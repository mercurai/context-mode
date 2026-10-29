import type { IncomingMessage } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { AuthenticatedScope, ResolvedIdentity, SharedIdentityRegistry } from "./identity.js";
import type { SharedHttpAuthority } from "./http.js";

/** Trusted harness input. Paths are existing canonical directories, not hook/tool overrides. */
export interface SharedLaunchMetadata {
  provider: AuthenticatedScope["provider"];
  home: string;
  userHome: string;
  workspace: string;
}

export interface SharedLaunchGrant {
  readonly scope: Readonly<AuthenticatedScope>;
  /** Ephemeral secrets returned only to the trusted launch caller. Never persist or log. */
  readonly mcpCapability: string;
  readonly hookCapability: string;
}

export interface SharedLaunchAuthorityOptions {
  identityRegistry: SharedIdentityRegistry;
  now: () => Date;
  ttlMs: number;
  maxLaunches: number;
  mcpServerName: string;
  /** Supply names from the current shared runtime's SDK tool descriptors. */
  toolNames: readonly string[];
}

export interface SharedLaunchAuthority extends SharedHttpAuthority {
  /** In-process lifetime checks are synchronous, including runtime admission. */
  isActive(scope: Readonly<AuthenticatedScope>): boolean;
  /** Authenticate the hook credential before transport reads a body; registration rechecks it. */
  authenticateHook(request: IncomingMessage): Readonly<AuthenticatedScope>;
  /** Internal authenticated harness control only; never expose issuance as an HTTP tool/route. */
  issue(metadata: SharedLaunchMetadata): SharedLaunchGrant;
  metadata(scope: Readonly<AuthenticatedScope>): Readonly<SharedLaunchMetadata>;
  /** Separate hook credential. Native identity is projected explicitly; no legacy fallback. */
  registerHook(request: IncomingMessage, nativePayload: unknown): void;
  /** Separate native-memory enrollment; cannot authorize callable MCP tools. */
  registerMemoryHook(request: IncomingMessage, nativePayload: unknown): void;
  /** Resolve only enrolled native memory owners; never accept caller-built identities. */
  resolveMemoryHook(request: IncomingMessage, nativePayload: unknown): Readonly<ResolvedIdentity>;
  revoke(scope: Readonly<AuthenticatedScope>): void;
  close(): void;
}

/**
 * Authentication is possession of a purpose-specific launch capability. A native
 * hook's inherited environment secret does not prove native origin against code
 * that can read that environment. The harness must protect the issuing control
 * channel and hook credentials. This module does not widen that trust boundary.
 */
type Launch = {
  scope: Readonly<AuthenticatedScope>;
  metadata: Readonly<SharedLaunchMetadata>;
  expiresAt: number;
  mcpHash: Buffer;
  hookHash: Buffer;
};

function invalid(): never { throw new Error("Invalid or inactive launch authority input"); }

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  return value as Record<string, unknown>;
}

function field(input: Record<string, unknown>, name: string, maximum = 256): string {
  // Native JSON fields must be own data properties. Do not invoke accessors.
  const descriptor = Object.getOwnPropertyDescriptor(input, name);
  const value: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
  if (typeof value !== "string" || !value || value.length > maximum ||
      value !== value.trim() || /[\x00-\x1f\x7f]/.test(value)) return invalid();
  return value;
}

function canonicalDirectory(value: string): string {
  if (!isAbsolute(value) || value.split(/[\\/]/).some((part) => part === "." || part === "..")) return invalid();
  try {
    const canonical = realpathSync(value);
    const same = process.platform === "win32"
      ? canonical.toLowerCase() === resolve(value).toLowerCase() : canonical === resolve(value);
    if (!same || !statSync(canonical).isDirectory()) return invalid();
    return canonical;
  } catch { return invalid(); }
}

function snapshot(input: SharedLaunchMetadata): Readonly<SharedLaunchMetadata> {
  const value = record(input);
  if (Object.keys(value).some((key) => !["provider", "home", "userHome", "workspace"].includes(key))) return invalid();
  const provider = field(value, "provider");
  if (provider !== "codex" && provider !== "claude-code") return invalid();
  return Object.freeze({ provider, home: canonicalDirectory(field(value, "home", 4096)),
    userHome: canonicalDirectory(field(value, "userHome", 4096)),
    workspace: canonicalDirectory(field(value, "workspace", 4096)) });
}

function credentialHash(request: IncomingMessage): Buffer {
  const authorization = request.headers.authorization;
  const count = request.rawHeaders.filter((_value, index) => index % 2 === 0 &&
    request.rawHeaders[index].toLowerCase() === "authorization").length;
  if (count !== 1 || typeof authorization !== "string" || !/^Bearer [A-Za-z0-9_-]{32,128}$/.test(authorization)) return invalid();
  return createHash("sha256").update(authorization.slice(7)).digest();
}

export function createSharedLaunchAuthority(options: SharedLaunchAuthorityOptions): SharedLaunchAuthority {
  if (!options || typeof options.now !== "function" || !Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0 ||
      !Number.isSafeInteger(options.maxLaunches) || options.maxLaunches <= 0 ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(options.mcpServerName) || !Array.isArray(options.toolNames) ||
      !options.toolNames.length || options.toolNames.some((name) => typeof name !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(name)) ||
      new Set(options.toolNames).size !== options.toolNames.length) return invalid();
  const { identityRegistry, now, ttlMs, maxLaunches } = options;
  const tools = new Map(options.toolNames.map((name) => [`mcp__${options.mcpServerName}__${name}`, name]));
  const lineageTool = options.toolNames[0];
  const epoch = randomBytes(24).toString("base64url");
  const launches = new Map<string, Launch>();
  let closed = false;
  let lastNow: number | undefined;

  function time(): number {
    if (closed) return invalid();
    const date = now();
    const current = date instanceof Date ? date.getTime() : NaN;
    if (!Number.isSafeInteger(current) || !Number.isSafeInteger(current + ttlMs) ||
        (lastNow !== undefined && current < lastNow)) return invalid();
    lastNow = current;
    return current;
  }

  function invalidate(launch: Launch): void {
    // Remove both credential hashes before registry operations that may throw.
    launches.delete(launch.scope.launchId);
    identityRegistry.revokeLaunch(launch.scope);
  }

  function active(launch: Launch | undefined, current: number): Launch {
    if (!launch) return invalid();
    if (launch.expiresAt <= current) { invalidate(launch); return invalid(); }
    return launch;
  }

  function owned(scope: Readonly<AuthenticatedScope>): Launch | undefined {
    const value = record(scope);
    if (Object.keys(value).some((key) => !["provider", "home", "launchId"].includes(key))) return undefined;
    const launch = launches.get(field(value, "launchId"));
    return launch && field(value, "provider") === launch.scope.provider && field(value, "home", 4096) === launch.scope.home
      ? launch : undefined;
  }

  function authenticate(request: IncomingMessage, purpose: "mcpHash" | "hookHash"): Launch {
    const current = time();
    const hash = credentialHash(request);
    let found: Launch | undefined;
    // All comparisons use fixed-length hashes; raw capabilities are never retained.
    for (const launch of launches.values()) if (timingSafeEqual(hash, launch[purpose])) found = launch;
    return active(found, current);
  }

  function registerHook(request: IncomingMessage, payload: unknown): void {
    const launch = authenticate(request, "hookHash");
    const input = record(payload);
    const event = field(input, "hook_event_name");
    const sessionId = field(input, "session_id");
    const workspace = canonicalDirectory(field(input, "cwd", 4096));
    if (workspace !== launch.metadata.workspace) return invalid();
    if (launch.scope.provider === "codex") {
      let threadId = sessionId;
      if (event === "SubagentStart") {
        threadId = field(input, "agent_id");
        if (threadId === sessionId) return invalid();
        // Resolve the root through the registry so expiry/conflict/revocation
        // have one authority, without maintaining a parallel lineage cache.
        identityRegistry.resolve(launch.scope, { name: lineageTool, _meta: { threadId: sessionId, sessionId } });
      } else if (event !== "SessionStart" || Object.hasOwn(input, "agent_id")) return invalid();
      identityRegistry.register(launch.scope, { kind: "codex-thread", threadId, sessionId, workspace });
      return;
    }
    if (event !== "PreToolUse") return invalid();
    const tool = tools.get(field(input, "tool_name"));
    if (!tool) return invalid();
    const toolUseId = field(input, "tool_use_id");
    const agent = Object.hasOwn(input, "agent_id") ? { agentId: field(input, "agent_id") } : {};
    // Only the native identity whitelist enters registry storage. In particular,
    // transcript, prompt, input, environment and purported scope overrides do not.
    identityRegistry.register(launch.scope, { kind: "claude-tool-call", toolUseId, tool, sessionId, workspace, ...agent });
  }

  function memoryInput(request: IncomingMessage, payload: unknown) {
    const launch = authenticate(request, "hookHash");
    const input = record(payload);
    const event = field(input, "hook_event_name");
    const sessionId = field(input, "session_id");
    const workspace = canonicalDirectory(field(input, "cwd", 4096));
    if (workspace !== launch.metadata.workspace ||
        ["parent", "parent_agent_id", "parent_session_id", "parent_thread_id"].some((key) => Object.hasOwn(input, key))) return invalid();
    const owner = { sessionId, ...(Object.hasOwn(input, "agent_id") ? { agentId: field(input, "agent_id") } : {}) };
    return { launch, input, event, sessionId, workspace, owner };
  }

  function registerMemoryHook(request: IncomingMessage, payload: unknown): void {
    const { launch, input, event, sessionId, workspace, owner } = memoryInput(request, payload);
    if (event === "SessionStart") {
      if (Object.hasOwn(input, "agent_id")) return invalid();
      identityRegistry.registerMemoryOwner(launch.scope, { kind: "root", sessionId, workspace });
      return;
    }
    if (event === "SubagentStart") {
      identityRegistry.registerMemoryOwner(launch.scope, { kind: "child", sessionId, workspace, agentId: field(input, "agent_id") });
      return;
    }
    if (event !== "PreToolUse") return invalid();
    // Observation stores the exact native tool name in its own namespace. It
    // never enters the callable MCP whitelist or reads tool inputs/transcripts.
    identityRegistry.registerMemoryTool(launch.scope, { owner,
      toolUseId: field(input, "tool_use_id"), tool: field(input, "tool_name") });
  }

  function resolveMemoryHook(request: IncomingMessage, payload: unknown): Readonly<ResolvedIdentity> {
    const { launch, input, event, owner } = memoryInput(request, payload);
    const identity = identityRegistry.resolveMemoryOwner(launch.scope, owner);
    if (!["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(event)) return identity;
    const tool = identityRegistry.resolveMemoryTool(launch.scope, {
      toolUseId: field(input, "tool_use_id"), tool: field(input, "tool_name"),
    });
    if (tool.sessionId !== identity.sessionId || tool.workspace !== identity.workspace ||
        tool.threadId !== identity.threadId || tool.agentId !== identity.agentId) return invalid();
    return tool;
  }

  return Object.freeze({
    issue(input: SharedLaunchMetadata): SharedLaunchGrant {
      const current = time();
      const metadata = snapshot(input);
      for (const launch of launches.values()) if (launch.expiresAt <= current) invalidate(launch);
      if (launches.size >= maxLaunches) throw new Error("Launch authority capacity exhausted");
      const scope = Object.freeze({ provider: metadata.provider, home: metadata.home,
        launchId: `${epoch}.${randomBytes(24).toString("base64url")}` });
      const mcpCapability = randomBytes(32).toString("base64url");
      let hookCapability: string;
      do { hookCapability = randomBytes(32).toString("base64url"); } while (hookCapability === mcpCapability);
      launches.set(scope.launchId, { scope, metadata, expiresAt: current + ttlMs,
        mcpHash: createHash("sha256").update(mcpCapability).digest(),
        hookHash: createHash("sha256").update(hookCapability).digest() });
      return Object.freeze({ scope, mcpCapability, hookCapability });
    },
    authenticate: (request: IncomingMessage) => authenticate(request, "mcpHash").scope,
    authenticateHook: (request: IncomingMessage) => authenticate(request, "hookHash").scope,
    isActive(scope: Readonly<AuthenticatedScope>): boolean {
      try { return Boolean(active(owned(scope), time())); } catch { return false; }
    },
    metadata: (scope: Readonly<AuthenticatedScope>) => active(owned(scope), time()).metadata,
    registerHook,
    registerMemoryHook,
    resolveMemoryHook,
    revoke(scope: Readonly<AuthenticatedScope>): void {
      // Revocation must work even after a clock error; it does not admit work.
      const launch = owned(scope);
      if (launch) invalidate(launch);
    },
    close(): void {
      if (closed) return;
      closed = true;
      const remaining = [...launches.values()];
      launches.clear();
      const errors: unknown[] = [];
      for (const launch of remaining) {
        try { identityRegistry.revokeLaunch(launch.scope); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new Error("Launch authority closed; registry revocation failed");
    },
  });
}
