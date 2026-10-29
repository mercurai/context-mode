import type { AuthenticatedScope, NativeToolCall, SharedIdentityRegistry } from "./identity.js";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { ContentStore } from "../store.js";
import { SessionDB } from "../session/db.js";
import { restoreSessionStats } from "../session/persist-tool-calls.js";
import { evaluateSharedReadPolicy, extractToolPermissionPatterns } from "../security.js";
import { stripJsonComments } from "../util/jsonc.js";
import { FloodGuard } from "../search/flood-guard.js";
import { withSharedToolContext, type SharedToolContext } from "./runtime-context.js";
import type { ResolvedIdentity } from "./identity.js";
import { createSharedMemoryIngestor, type SharedMemoryDelivery, type SharedMemoryIngestor,
  type SharedMemoryResult } from "./memory-ingestion.js";

export interface SharedRuntimeOptions {
  identityRegistry: SharedIdentityRegistry;
  maxProjects: number;
  maxSessions: number;
  now?: () => number;
  /** Trusted launch metadata; never inferred from the service's environment. */
  resolveUserHome?: (scope: Readonly<AuthenticatedScope>) => string | undefined;
  /** Trusted launch liveness; omitted for legacy in-process callers. */
  isActive?: (scope: Readonly<AuthenticatedScope>) => boolean;
}

export interface SharedToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export interface SharedRuntime {
  listTools(): readonly SharedRuntimeTool[];
  call(scope: AuthenticatedScope, request: NativeToolCall, context?: SharedRuntimeRequestContext): Promise<SharedToolResult>;
  close(): Promise<void>;
}

/** Internal native-hook integration; not exposed as MCP tools or HTTP routes. */
export interface SharedMemoryRuntime extends SharedRuntime {
  ingestMemory(identity: Readonly<ResolvedIdentity>, delivery: SharedMemoryDelivery): Promise<SharedMemoryResult>;
  recoverMemory(identity: Readonly<ResolvedIdentity>): Promise<string>;
}

export interface SharedRuntimeTool {
  readonly name: string;
  readonly config: Readonly<Record<string, unknown>>;
}

export interface SharedRuntimeRequestContext {
  readonly signal: AbortSignal;
  readonly requestId: string | number;
  readonly transportSessionId: string;
}

type Project = { store: ContentStore; db: SessionDB; storePath: string; dbPath: string; sessionsDir: string;
  storeClosed?: boolean; dbClosed?: boolean };
type Owner = { context: Readonly<SharedToolContext>; projectKey: string; launches: Map<string, Readonly<AuthenticatedScope>>;
  activeCalls: number; memory?: SharedMemoryIngestor };
const SUPPORTED_TOOLS = new Set(["ctx_index", "ctx_search", "ctx_stats"]);
// Match the ingestion core's existing maximum; service configuration is separate.
const MAX_MEMORY_DELIVERIES_PER_OWNER = 100_000;

function digest(parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function insideWorkspace(filePath: string, workspace: string): boolean {
  const path = realpathSync(resolve(workspace, filePath));
  const delta = relative(realpathSync(workspace), path);
  return delta === "" || (!isAbsolute(delta) && delta !== ".." && !delta.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

function denyFile(identity: Readonly<ResolvedIdentity>, filePath: string, userHome?: string): boolean {
  try {
    if (!insideWorkspace(filePath, identity.workspace)) return true;
    // Codex reads stay inside the registered workspace. Its execution sandbox
    // policy is not interchangeable with Claude settings; execution is disabled.
    if (identity.provider !== "claude-code") return false;
    const settings = [
      { path: join(identity.workspace, ".claude", "settings.local.json"), anchor: identity.workspace },
      { path: join(identity.workspace, ".claude", "settings.json"), anchor: identity.workspace },
      { path: join(identity.home, "settings.json"), anchor: identity.home },
    ];
    for (const { path, anchor } of settings) {
      let raw: string;
      try {
        raw = readFileSync(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      // Parse once: validation and policy extraction must use the same bytes.
      // Malformed or unreadable settings fail closed in the outer catch.
      const value: unknown = JSON.parse(stripJsonComments(raw));
      // There is no interactive approval bridge in the shared service yet.
      // A matching ask rule therefore cannot authorize either a fresh read or
      // retrieval of previously indexed file content.
      const patterns = [
        ...extractToolPermissionPatterns(value, "Read", "deny", { strict: true }),
        ...extractToolPermissionPatterns(value, "Read", "ask", { strict: true }),
      ];
      if (evaluateSharedReadPolicy(filePath, patterns, {
        workspaceDir: identity.workspace, settingsDir: anchor, userHome,
      }).denied) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function resolveTrustedUserHome(
  scope: AuthenticatedScope,
  resolver: SharedRuntimeOptions["resolveUserHome"],
): string | undefined {
  const home = resolver?.(Object.freeze({ ...scope }));
  if (home === undefined) return undefined;
  if (typeof home !== "string" || !isAbsolute(home) || home.split(/[\\/]/).some((part) => part === "." || part === "..")) {
    throw new Error("Trusted user home must be an absolute canonical path");
  }
  const canonical = realpathSync(home);
  const samePath = process.platform === "win32"
    ? canonical.toLowerCase() === resolve(home).toLowerCase() : canonical === resolve(home);
  if (!samePath) throw new Error("Trusted user home must be canonical");
  return canonical;
}

function openProject(identity: ResolvedIdentity): Project {
  const hash = digest([identity.provider, identity.workspace]);
  const contentDir = join(identity.home, "context-mode", "content");
  const sessionsDir = join(identity.home, "context-mode", "sessions");
  mkdirSync(contentDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  const storePath = join(contentDir, `${hash}.db`);
  const dbPath = join(sessionsDir, `${hash}.db`);
  const store = new ContentStore(storePath);
  try {
    return { store, db: new SessionDB({ dbPath }), storePath, dbPath, sessionsDir };
  } catch (error) {
    store.close();
    throw error;
  }
}

function createContext(identity: ResolvedIdentity, ownerId: string, project: Project, now: () => number): Readonly<SharedToolContext> {
  project.db.ensureSession(ownerId, identity.workspace);
  const attribution = Object.freeze({ sessionId: ownerId, workspaceDir: identity.workspace, db: project.db });
  const restored = restoreSessionStats(project.dbPath, attribution);
  return Object.freeze({
    identity: Object.freeze({ ...identity }), ownerId, store: project.store, storePath: project.storePath,
    sessionDbPath: project.dbPath, sessionsDir: project.sessionsDir,
    statsPath: join(project.sessionsDir, `stats-${ownerId}.json`), attribution,
    stats: { calls: restored?.calls ?? {}, bytesReturned: restored?.bytesReturned ?? {}, bytesIndexed: 0,
      bytesSandboxed: 0, cacheHits: 0, cacheMisses: 0, cacheBytesSaved: 0, sessionStart: restored?.sessionStart ?? now() },
    persistence: { lastWrite: 0 }, now,
    floodGuard: new FloodGuard({ windowMs: 60_000, softCapAfter: 3, blockAfter: 8 }),
    denyFile: (filePath: string) => denyFile(identity, filePath),
  });
}

export async function createSharedRuntime(options: SharedRuntimeOptions): Promise<SharedMemoryRuntime> {
  const { identityRegistry, maxProjects, maxSessions, now = Date.now, resolveUserHome, isActive } = options;
  for (const bound of [maxProjects, maxSessions]) {
    if (!Number.isSafeInteger(bound) || bound <= 0) throw new Error("Invalid shared runtime resource bound");
  }
  const { REGISTERED_CTX_TOOLS, flushSharedRuntimeStats } = await import("../server.js");
  const supportedTools = new Map(REGISTERED_CTX_TOOLS
    .filter((tool) => SUPPORTED_TOOLS.has(tool.name)).map((tool) => [tool.name, tool]));
  const descriptors = Object.freeze([...supportedTools.values()].map((tool) => Object.freeze({
    name: tool.name, config: Object.freeze({ ...tool.config }),
  })));
  const projects = new Map<string, Project>();
  const sessions = new Map<string, Owner>();
  const inFlight = new Set<Promise<unknown>>();
  let closed = false;
  let closePromise: Promise<void> | undefined;

  function closeProject(project: Project): void {
    const errors: unknown[] = [];
    try { if (!project.storeClosed) { project.store.close(); project.storeClosed = true; } } catch (error) { errors.push(error); }
    try { if (!project.dbClosed) { project.db.close(); project.dbClosed = true; } } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Shared runtime storage cleanup failed");
  }

  function sweepInactive(): void {
    if (!isActive) return;
    for (const [id, owner] of sessions) {
      for (const [launch, scope] of owner.launches) if (!isActive(scope)) owner.launches.delete(launch);
      if (owner.launches.size || owner.activeCalls) continue;
      withSharedToolContext(owner.context, flushSharedRuntimeStats);
      sessions.delete(id);
    }
    for (const [key, project] of projects) {
      if ([...sessions.values()].some((owner) => owner.projectKey === key)) continue;
      closeProject(project);
      projects.delete(key);
    }
  }

  function admitOwner(identity: ResolvedIdentity): Owner {
    if (closed) throw new Error("Shared runtime is closed");
    const callScope = { provider: identity.provider, home: identity.home, launchId: identity.launchId };
    const projectKey = digest([identity.provider, identity.home, identity.workspace]);
    const ownerId = digest([projectKey, identity.sessionId, identity.threadId ?? identity.agentId ?? identity.sessionId]);
    if (isActive && !isActive(callScope)) throw new Error("Shared launch is inactive");
    const membership = JSON.stringify([callScope.provider, callScope.home, callScope.launchId]);
    let owner = sessions.get(ownerId);
    // Attach the authenticated caller before sweeping: durable owners may be
    // shared by launches, and the context's first launch is not their lifetime.
    owner?.launches.set(membership, Object.freeze({ ...callScope }));
    sweepInactive();
    // The sweep may expire this launch and evict its owner. Never reopen an
    // expired launch or dispatch through the cached context it just closed.
    if (isActive && !isActive(callScope)) throw new Error("Shared launch is inactive");
    owner = sessions.get(ownerId);
    if (!owner) {
      if (sessions.size >= maxSessions) throw new Error("Shared session capacity exceeded");
      let project = projects.get(projectKey);
      if (!project) {
        if (projects.size >= maxProjects) throw new Error("Shared project capacity exceeded");
        project = openProject(identity);
        projects.set(projectKey, project);
      }
      if (project.storeClosed || project.dbClosed) throw new Error("Shared project cleanup is incomplete");
      owner = { context: createContext(identity, ownerId, project, now), projectKey, activeCalls: 0,
        launches: new Map([[membership, Object.freeze({ ...callScope })]]) };
      sessions.set(ownerId, owner);
    }
    return owner;
  }

  async function withOwner<T>(identity: ResolvedIdentity, operation: (owner: Owner) => T | Promise<T>): Promise<T> {
    const owner = admitOwner(identity);
    owner.activeCalls++;
    try {
      return await operation(owner);
    } finally { owner.activeCalls--; }
  }

  async function trackOperation<T>(operation: () => Promise<T>): Promise<T> {
    const pending = operation();
    inFlight.add(pending);
    try { return await pending; } finally { inFlight.delete(pending); }
  }

  function memoryOperation<T>(identity: Readonly<ResolvedIdentity>, operation: (memory: SharedMemoryIngestor) => T): Promise<T> {
    return trackOperation(async () => {
      if (closed) throw new Error("Shared runtime is closed");
      if (!isActive) throw new Error("Shared memory requires trusted launch liveness");
      return withOwner(structuredClone(identity), (owner) => {
        owner.memory ??= createSharedMemoryIngestor(owner.context, { maxDeliveries: MAX_MEMORY_DELIVERIES_PER_OWNER });
        return operation(owner.memory);
      });
    });
  }

  async function invoke(
    scope: AuthenticatedScope,
    request: NativeToolCall,
    transportContext?: SharedRuntimeRequestContext,
  ): Promise<SharedToolResult> {
    if (closed) throw new Error("Shared runtime is closed");
    // Keep the transport-owned signal live; structuredClone does not preserve
    // AbortSignal semantics. Snapshot only the surrounding request metadata.
    const requestContext = transportContext ? Object.freeze({
      signal: transportContext.signal, requestId: transportContext.requestId,
      transportSessionId: transportContext.transportSessionId,
    }) : undefined;
    requestContext?.signal.throwIfAborted();
    const callScope = structuredClone(scope);
    const call = structuredClone(request);
    identityRegistry.resolve(callScope, call);
    if (!SUPPORTED_TOOLS.has(call.name)) throw new Error("Tool is not supported by the shared runtime");
    const tool = supportedTools.get(call.name);
    if (!tool || !(tool.config.inputSchema instanceof z.ZodType)) throw new Error("Shared tool schema is unavailable");
    const args = await tool.config.inputSchema.parseAsync(call.arguments ?? {}) as Record<string, unknown>;
    if (closed) throw new Error("Shared runtime is closed");
    requestContext?.signal.throwIfAborted();
    // Async schema refinements can yield while a launch is being revoked.
    const identity = identityRegistry.resolve(callScope, call);
    const userHome = resolveTrustedUserHome(callScope, resolveUserHome);
    // No model-provided project override may widen the authenticated workspace.
    if (call.name === "ctx_search" && (args.sort === "timeline" || args.project !== undefined)) {
      throw new Error("Cross-session search is not supported by the shared runtime");
    }
    return withOwner(identity, async (owner) => {
      const toolContext = Object.freeze({ ...owner.context, identity: Object.freeze({ ...identity }),
        denyFile: (filePath: string) => denyFile(identity, filePath, userHome) });
      const result = await withSharedToolContext(toolContext, () => tool.handler(args, requestContext)) as SharedToolResult;
      requestContext?.signal.throwIfAborted();
      return result;
    });
  }

  return {
    ingestMemory(identity, delivery) {
      return memoryOperation(identity, (memory) => memory.ingest(delivery));
    },
    recoverMemory(identity) {
      return memoryOperation(identity, (memory) => memory.recover());
    },
    listTools() {
      return descriptors;
    },
    call(scope, request, context) {
      return trackOperation(() => invoke(scope, request, context));
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        await Promise.allSettled([...inFlight]);
        try {
          for (const owner of sessions.values()) withSharedToolContext(owner.context, flushSharedRuntimeStats);
        } finally {
          const errors: unknown[] = [];
          for (const project of projects.values()) {
            try { closeProject(project); } catch (error) { errors.push(error); }
          }
          sessions.clear();
          projects.clear();
          if (errors.length) throw new AggregateError(errors, "Shared runtime storage cleanup failed");
        }
      })();
      return closePromise;
    },
  };
}
