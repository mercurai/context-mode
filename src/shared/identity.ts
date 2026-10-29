import type { PlatformId } from "../adapters/types.js";

/** Supplied by an authenticated adapter, never by tool arguments. */
export interface AuthenticatedScope {
  provider: Extract<PlatformId, "codex" | "claude-code">;
  home: string;
  launchId: string;
}

export type IdentityRegistration = {
  sessionId: string;
  workspace: string;
} & (
  | { kind: "codex-thread"; threadId: string }
  | { kind: "claude-tool-call"; toolUseId: string; tool: string; agentId?: string }
);

export interface NativeToolCall {
  name: string;
  _meta?: unknown;
  arguments?: unknown;
}

export interface ResolvedIdentity extends AuthenticatedScope {
  sessionId: string;
  workspace: string;
  threadId?: string;
  agentId?: string;
}

/** Exact native root membership; this selector is never an MCP permission. */
export interface MemoryOwnerSelector { sessionId: string; agentId?: string }

export type MemoryOwnerRegistration = { sessionId: string; workspace: string } & (
  | { kind: "root" }
  | { kind: "child"; agentId: string }
);

export interface MemoryToolSelector { toolUseId: string; tool: string }

export interface MemoryToolRegistration extends MemoryToolSelector { owner: MemoryOwnerSelector }

export interface RegistryOptions {
  now: () => Date;
  ttlMs: number;
  maxEntries: number;
}

type Entry = { scopeKey: string; expiresAt: number } & (
  | { kind: "binding"; identity: ResolvedIdentity; fingerprint: string; tool?: string }
  | { kind: "ambiguous" | "revoked" }
);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid identity object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Invalid identity object");
  }
  return value as Record<string, unknown>;
}

function fields(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error("Unexpected identity field");
  }
}

/** Snapshot only explicit data fields at the native-memory boundary. */
function memoryFields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  const input = object(value);
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !allowed.includes(key)) throw new Error("Unexpected identity field");
    const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
    if (!("value" in descriptor)) throw new Error("Invalid identity field");
    result[key] = descriptor.value;
  }
  return result;
}

function sameIdentity(a: ResolvedIdentity, b: ResolvedIdentity): boolean {
  return a.provider === b.provider && a.home === b.home && a.launchId === b.launchId &&
    a.workspace === b.workspace && a.sessionId === b.sessionId &&
    a.threadId === b.threadId && a.agentId === b.agentId;
}

function text(value: unknown, limit = 256): string {
  if (typeof value !== "string" || !value || value.length > limit ||
      value !== value.trim() || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error("Invalid identity field");
  }
  return value;
}

function absolutePath(value: unknown): string {
  const path = text(value, 4096);
  const absolute = path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) ||
    /^\\\\[^\\/]+[\\/][^\\/]+/.test(path);
  if (!absolute || path.split(/[\\/]/).some((part) => part === "." || part === "..")) {
    throw new Error("Identity path must be an absolute canonical path");
  }
  // Canonicalization belongs to the trusted adapter. Never collapse worktrees
  // to a common Git root or reinterpret Windows paths on a Linux service.
  return path;
}

function scopeSnapshot(input: AuthenticatedScope): AuthenticatedScope {
  const scope = object(input);
  fields(scope, ["provider", "home", "launchId"]);
  if (scope.provider !== "codex" && scope.provider !== "claude-code") {
    throw new Error("Unsupported identity provider");
  }
  return { provider: scope.provider, home: absolutePath(scope.home), launchId: text(scope.launchId) };
}

function registrationSnapshot(scope: AuthenticatedScope, input: IdentityRegistration) {
  const registration = object(input);
  const identity: ResolvedIdentity = {
    ...scope, sessionId: text(registration.sessionId), workspace: absolutePath(registration.workspace),
  };
  if (scope.provider === "codex" && registration.kind === "codex-thread") {
    fields(registration, ["kind", "threadId", "sessionId", "workspace"]);
    identity.threadId = text(registration.threadId);
    return { identity, nativeId: identity.threadId, tool: undefined };
  }
  if (scope.provider === "claude-code" && registration.kind === "claude-tool-call") {
    fields(registration, ["kind", "toolUseId", "sessionId", "agentId", "workspace", "tool"]);
    if (registration.agentId !== undefined) identity.agentId = text(registration.agentId);
    return { identity, nativeId: text(registration.toolUseId), tool: text(registration.tool) };
  }
  throw new Error("Registration does not match authenticated provider");
}

/**
 * Identity correlation after transport authentication, not authentication itself.
 * Native-ID history and revocations are permanent for this instance, including
 * expired and ambiguous bindings. The owning service must invalidate its scopes
 * before replacing the registry, including on restart. TTL expiry does not permit
 * ID reuse: delayed native calls cannot distinguish a new binding from the old.
 */
export class SharedIdentityRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private lastNow: number | undefined;

  constructor(options: RegistryOptions) {
    if (!options || typeof options.now !== "function" ||
        !Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0 ||
        !Number.isSafeInteger(options.maxEntries) || options.maxEntries <= 0) {
      throw new Error("Invalid identity registry bounds");
    }
    this.now = options.now;
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries;
  }

  registerMemoryOwner(input: AuthenticatedScope, registration: MemoryOwnerRegistration): void {
    const context = this.memoryContext(input);
    const value = memoryFields(registration, ["kind", "sessionId", "workspace", "agentId"]);
    const identity: ResolvedIdentity = { ...context.scope,
      sessionId: text(value.sessionId), workspace: absolutePath(value.workspace) };
    let namespace = "memory-root", nativeId = identity.sessionId;
    if (value.kind === "child") {
      nativeId = text(value.agentId);
      const root = this.memoryOwner(context.scopeKey, context.now, { sessionId: identity.sessionId });
      if (nativeId === identity.sessionId || root.workspace !== identity.workspace) {
        throw new Error("Child identity does not match registered root");
      }
      namespace = "memory-child";
      if (context.scope.provider === "claude-code") identity.agentId = nativeId;
    } else if (value.kind !== "root" || Object.hasOwn(value, "agentId")) {
      throw new Error("Invalid memory owner registration");
    }
    if (context.scope.provider === "codex") identity.threadId = nativeId;
    this.bind(JSON.stringify([context.scopeKey, namespace, nativeId]), context, identity);
  }

  resolveMemoryOwner(input: AuthenticatedScope, owner: MemoryOwnerSelector): ResolvedIdentity {
    const { scopeKey, now } = this.memoryContext(input);
    return this.memoryOwner(scopeKey, now, owner);
  }

  registerMemoryTool(input: AuthenticatedScope, registration: MemoryToolRegistration): void {
    const context = this.memoryContext(input);
    const value = memoryFields(registration, ["owner", "toolUseId", "tool"]);
    const identity = this.memoryOwner(context.scopeKey, context.now, value.owner);
    const key = JSON.stringify([context.scopeKey, "memory-tool", text(value.toolUseId)]);
    this.bind(key, context, identity, text(value.tool));
  }

  resolveMemoryTool(input: AuthenticatedScope, selector: MemoryToolSelector): ResolvedIdentity {
    const { scopeKey, now } = this.memoryContext(input);
    const value = memoryFields(selector, ["toolUseId", "tool"]);
    const entry = this.binding(JSON.stringify([scopeKey, "memory-tool", text(value.toolUseId)]), now);
    if (text(value.tool) !== entry.tool) throw new Error("Request tool does not match registered identity");
    const identity = entry.identity;
    const agentId = identity.provider === "codex"
      ? (identity.threadId === identity.sessionId ? undefined : identity.threadId) : identity.agentId;
    const owner = this.memoryOwner(scopeKey, now, { sessionId: identity.sessionId, ...(agentId ? { agentId } : {}) });
    if (!sameIdentity(identity, owner)) throw new Error("Tool identity does not match registered owner");
    return owner;
  }

  register(input: AuthenticatedScope, registration: IdentityRegistration): void {
    const { scope, scopeKey, now } = this.context(input);
    this.assertNotRevoked(scopeKey);
    const { identity, nativeId, tool } = registrationSnapshot(scope, registration);
    const key = JSON.stringify([scopeKey, nativeId]);
    this.bind(key, { scopeKey, now }, identity, tool);
  }

  private bind(key: string, context: { scopeKey: string; now: number }, identity: ResolvedIdentity, tool?: string): void {
    const { scopeKey, now } = context;
    const fingerprint = JSON.stringify([identity, tool]);
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.kind === "binding" && existing.fingerprint === fingerprint) {
        if (existing.expiresAt <= now) throw new Error("Identity registration expired");
        return;
      }
      this.entries.set(key, { kind: "ambiguous", scopeKey, expiresAt: existing.expiresAt });
      throw new Error("Ambiguous identity registration");
    }
    this.assertCapacity();
    this.entries.set(key, {
      kind: "binding", scopeKey, expiresAt: now + this.ttlMs, identity, fingerprint, tool,
    });
  }

  resolve(input: AuthenticatedScope, call: NativeToolCall): ResolvedIdentity {
    const { scope, scopeKey, now } = this.context(input);
    this.assertNotRevoked(scopeKey);
    const request = object(call);
    const tool = text(request.name);
    const meta = object(request._meta);
    const nativeId = text(scope.provider === "codex" ? meta.threadId : meta["claudecode/toolUseId"]);
    const entry = this.binding(JSON.stringify([scopeKey, nativeId]), now);
    if (scope.provider === "codex" && text(meta.sessionId) !== entry.identity.sessionId) {
      throw new Error("Request lineage does not match registered identity");
    }
    if (scope.provider === "claude-code" && tool !== entry.tool) {
      throw new Error("Request tool does not match registered identity");
    }
    // arguments are deliberately never consulted for identity or registration.
    return { ...entry.identity };
  }

  /**
   * The auth owner must invalidate the target credential independently if this
   * throws: an unknown launch's revocation can exceed the bounded registry.
   * Known launches release their identity history to retain one revocation entry.
   */
  revokeLaunch(input: AuthenticatedScope): void {
    const { scopeKey } = this.context(input);
    const key = JSON.stringify([scopeKey, null]);
    if (this.entries.get(key)?.kind === "revoked") return;
    for (const [entryKey, entry] of this.entries) {
      if (entry.scopeKey === scopeKey) this.entries.delete(entryKey);
    }
    if (this.entries.size >= this.maxEntries) {
      throw new Error("Identity revocation capacity exhausted; invalidate credential at auth owner");
    }
    this.entries.set(key, { kind: "revoked", scopeKey, expiresAt: Infinity });
  }

  private context(input: AuthenticatedScope) {
    const scope = scopeSnapshot(input);
    const date = this.now();
    const now = date instanceof Date ? date.getTime() : NaN;
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(now + this.ttlMs)) {
      throw new Error("Invalid identity registry clock");
    }
    if (this.lastNow !== undefined && now < this.lastNow) throw new Error("Identity registry clock moved backwards");
    this.lastNow = now;
    return { scope, scopeKey: JSON.stringify([scope.provider, scope.home, scope.launchId]), now };
  }

  private memoryContext(input: AuthenticatedScope) {
    const scope = memoryFields(input, ["provider", "home", "launchId"]);
    const context = this.context(scope as unknown as AuthenticatedScope);
    this.assertNotRevoked(context.scopeKey);
    return context;
  }

  private memoryOwner(scopeKey: string, now: number, selector: unknown): ResolvedIdentity {
    const value = memoryFields(selector, ["sessionId", "agentId"]);
    const sessionId = text(value.sessionId);
    const child = Object.hasOwn(value, "agentId");
    const nativeId = child ? text(value.agentId) : sessionId;
    const entry = this.binding(JSON.stringify([scopeKey, child ? "memory-child" : "memory-root", nativeId]), now);
    if (sessionId !== entry.identity.sessionId) throw new Error("Request lineage does not match registered identity");
    if (child) {
      const root = this.memoryOwner(scopeKey, now, { sessionId });
      const expected = { ...root, ...(root.provider === "codex" ? { threadId: nativeId } : { agentId: nativeId }) };
      if (!sameIdentity(entry.identity, expected)) throw new Error("Child identity does not match registered root");
    }
    return { ...entry.identity };
  }

  private binding(key: string, now: number) {
    const entry = this.entries.get(key);
    if (!entry || entry.kind !== "binding") throw new Error("Unknown or ambiguous request identity");
    if (entry.expiresAt <= now) throw new Error("Request identity expired");
    return entry;
  }

  private assertNotRevoked(scopeKey: string): void {
    if (this.entries.has(JSON.stringify([scopeKey, null]))) throw new Error("Launch identity revoked");
  }

  private assertCapacity(): void {
    if (this.entries.size >= this.maxEntries) throw new Error("Identity registry capacity exhausted");
  }
}
