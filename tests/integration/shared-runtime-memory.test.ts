import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SharedIdentityRegistry, type AuthenticatedScope, type ResolvedIdentity } from "../../src/shared/identity.js";
import { createSharedLaunchAuthority, type SharedLaunchAuthority } from "../../src/shared/launch-authority.js";
import type { SharedMemoryRuntime } from "../../src/shared/runtime.js";
import type { SharedMemoryDelivery } from "../../src/shared/memory-ingestion.js";
import { getSharedToolContext, type SharedToolContext } from "../../src/shared/runtime-context.js";

const NOW = Date.UTC(2030, 0, 2, 3, 4, 5);
const scopeOf = ({ provider, home, launchId }: Readonly<ResolvedIdentity>): AuthenticatedScope => ({ provider, home, launchId });
const prompt = (id: string, marker: string): SharedMemoryDelivery =>
  ({ v: 1, id, kind: "prompt", prompt: `Implement ${marker} for this workspace.` });
const text = (result: { content: Array<{ text?: string }>; isError?: boolean }) => {
  expect(result.isError).not.toBe(true);
  return result.content.map((part) => part.text ?? "").join("\n");
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("memory shares the runtime's admitted owners", () => {
  let root: string;
  let clock: number;
  let registry: SharedIdentityRegistry;
  let authority: SharedLaunchAuthority;
  let runtime: SharedMemoryRuntime | undefined;
  let callNumber: number;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "shared-runtime-memory-")));
    clock = NOW; callNumber = 0;
    const fallback = join(root, "fallback");
    mkdirSync(join(fallback, "tmp"), { recursive: true });
    for (const [key, value] of Object.entries({ HOME: fallback, USERPROFILE: fallback,
      CODEX_HOME: fallback, CLAUDE_CONFIG_DIR: fallback, CONTEXT_MODE_DIR: join(fallback, "store"),
      CLAUDE_PROJECT_DIR: fallback, CONTEXT_MODE_PROJECT_DIR: fallback,
      TMPDIR: join(fallback, "tmp"), TEMP: join(fallback, "tmp"), TMP: join(fallback, "tmp"),
    })) vi.stubEnv(key, value);
    vi.stubEnv("CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS", undefined);
    registry = new SharedIdentityRegistry({ now: () => new Date(clock), ttlMs: 1000, maxEntries: 100 });
    authority = createSharedLaunchAuthority({ identityRegistry: registry, now: () => new Date(clock),
      ttlMs: 1000, maxLaunches: 32, mcpServerName: "context-mode", toolNames: ["ctx_stats", "ctx_index", "ctx_search"] });
  });

  afterEach(async () => {
    try { await runtime?.close(); authority.close(); }
    finally { runtime = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
  });

  async function start(bounds: { maxProjects?: number; maxSessions?: number } = {}) {
    const { createSharedRuntime } = await import("../../src/shared/runtime.js");
    runtime = await createSharedRuntime({ identityRegistry: registry, maxProjects: 8, maxSessions: 16,
      now: () => clock, isActive: (scope) => authority.isActive(scope),
      resolveUserHome: (scope) => authority.metadata(scope).userHome, ...bounds });
  }

  function identity(values: Partial<ResolvedIdentity> = {}): ResolvedIdentity {
    const provider = values.provider ?? "codex";
    const home = values.home ?? join(root, "config");
    const workspace = values.workspace ?? join(root, "workspace");
    for (const path of [home, workspace]) mkdirSync(path, { recursive: true });
    const grant = authority.issue({ provider, home, workspace, userHome: root });
    const result: ResolvedIdentity = { ...grant.scope, workspace, sessionId: values.sessionId ?? "root-session",
      ...(provider === "codex" ? { threadId: values.threadId ?? values.sessionId ?? "root-session" }
        : values.agentId ? { agentId: values.agentId } : {}) };
    const call = nativeCall(result, "ctx_stats");
    return registry.resolve(grant.scope, call);
  }

  function nativeCall(owner: Readonly<ResolvedIdentity>, name: string, args: Record<string, unknown> = {}) {
    const scope = scopeOf(owner);
    if (owner.provider === "codex") {
      registry.register(scope, { kind: "codex-thread", threadId: owner.threadId!, sessionId: owner.sessionId, workspace: owner.workspace });
      return { name, arguments: args, _meta: { threadId: owner.threadId, sessionId: owner.sessionId } };
    }
    const toolUseId = `native-call-${++callNumber}`;
    registry.register(scope, { kind: "claude-tool-call", toolUseId, tool: name, sessionId: owner.sessionId,
      workspace: owner.workspace, ...(owner.agentId ? { agentId: owner.agentId } : {}) });
    return { name, arguments: args, _meta: { "claudecode/toolUseId": toolUseId } };
  }

  const call = (owner: Readonly<ResolvedIdentity>, name = "ctx_stats", args: Record<string, unknown> = {}) =>
    runtime!.call(scopeOf(owner), nativeCall(owner, name, args));

  async function context(owner: Readonly<ResolvedIdentity>): Promise<Readonly<SharedToolContext>> {
    const { REGISTERED_CTX_TOOLS } = await import("../../src/server.js");
    const tool = REGISTERED_CTX_TOOLS.find((entry) => entry.name === "ctx_stats")!;
    const original = tool.handler;
    let captured: Readonly<SharedToolContext> | undefined;
    tool.handler = (args, extra) => { captured = getSharedToolContext(); return original(args, extra); };
    try { text(await call(owner)); return captured!; }
    finally { tool.handler = original; }
  }

  test.each(["memory-first", "tool-first"])("%s shares storage and one session slot with tools", async (order) => {
    await start({ maxProjects: 1, maxSessions: 1 });
    const owner = identity();
    const before = order === "tool-first" ? await context(owner) : undefined;
    const result = await runtime!.ingestMemory(owner, prompt("native-a", "orchardalpha"));
    expect(result.duplicate).toBe(false);
    const admitted = await context(owner);
    if (before) { expect(admitted.store).toBe(before.store); expect(admitted.attribution.db).toBe(before.attribution.db); }
    expect(admitted.attribution.db!.getEvents(admitted.ownerId).some((event) => event.data.includes("orchardalpha"))).toBe(true);
    expect(text(await call(owner, "ctx_search", { queries: ["orchardalpha"], limit: 20 }))).toContain("orchardalpha");
    const other = identity({ sessionId: "other-session" });
    await expect(runtime!.recoverMemory(other)).rejects.toThrow(/session capacity/i);
    await expect(call(other)).rejects.toThrow(/session capacity/i);
  });

  test.each([
    ["provider", { provider: "claude-code" }],
    ["home", { home: "other-home" }],
    ["workspace", { workspace: "other-workspace" }],
    ["root", { sessionId: "other-session" }],
    ["Codex child", { threadId: "child-thread" }],
  ] as const)("same delivery ID remains isolated by %s", async (_dimension, values) => {
    await start();
    const overrides: Partial<ResolvedIdentity> = { ...values };
    if (overrides.home) overrides.home = join(root, overrides.home);
    if (overrides.workspace) overrides.workspace = join(root, overrides.workspace);
    const a = identity(), b = identity(overrides);
    await runtime!.ingestMemory(a, prompt("native-same", "orchardalpha"));
    expect((await runtime!.ingestMemory(b, prompt("native-same", "meadowbeta"))).duplicate).toBe(false);
    expect(await runtime!.recoverMemory(a)).toContain("orchardalpha");
    expect(await runtime!.recoverMemory(a)).not.toContain("meadowbeta");
    expect(await runtime!.recoverMemory(b)).toContain("meadowbeta");
    expect(text(await call(b, "ctx_search", { queries: ["Implement"], limit: 20 }))).not.toContain("orchardalpha");
  });

  test("Claude parent and child share neither deliveries nor recovered memory", async () => {
    await start();
    const parent = identity({ provider: "claude-code" });
    const child = identity({ provider: "claude-code", agentId: "native-child" });
    await runtime!.ingestMemory(parent, prompt("native-same", "orchardalpha"));
    expect((await runtime!.ingestMemory(child, prompt("native-same", "meadowbeta"))).duplicate).toBe(false);
    expect(await runtime!.recoverMemory(child)).toContain("meadowbeta");
    expect(await runtime!.recoverMemory(child)).not.toContain("orchardalpha");
    expect(await runtime!.recoverMemory(parent)).not.toContain("meadowbeta");
  });

  test("recovery alone reserves the same session capacity used by ingestion and tools", async () => {
    await start({ maxSessions: 1 });
    const a = identity(), b = identity({ sessionId: "other-session" });
    expect(await runtime!.recoverMemory(a)).not.toContain("orchardalpha");
    await expect(runtime!.ingestMemory(b, prompt("native-b", "orchardalpha"))).rejects.toThrow(/session capacity/i);
    await expect(call(b)).rejects.toThrow(/session capacity/i);
    expect((await runtime!.ingestMemory(a, prompt("native-a", "orchardalpha"))).duplicate).toBe(false);
  });

  test("memory and tools enforce the same project capacity independently of session capacity", async () => {
    await start({ maxProjects: 1, maxSessions: 4 });
    const a = identity(), b = identity({ workspace: join(root, "other-workspace") });
    await runtime!.ingestMemory(a, prompt("native-a", "orchardalpha"));
    await expect(runtime!.recoverMemory(b)).rejects.toThrow(/project capacity/i);
    await expect(call(b)).rejects.toThrow(/project capacity/i);
    expect(await runtime!.recoverMemory(a)).toContain("orchardalpha");
  });

  test("native retry survives runtime restart and a fresh launch of the same owner", async () => {
    await start({ maxSessions: 1 });
    const original = identity(); const delivery = prompt("native-retry", "orchardalpha");
    const first = await runtime!.ingestMemory(original, delivery);
    const opened = await context(original);
    const count = opened.attribution.db!.getEvents(opened.ownerId).length;
    expect((await runtime!.ingestMemory(original, delivery)).duplicate).toBe(true);
    await runtime!.close(); runtime = undefined; authority.revoke(scopeOf(original));
    await start({ maxSessions: 1 });
    const resumed = identity();
    expect(await runtime!.recoverMemory(resumed)).toBe(first.snapshot);
    expect((await runtime!.ingestMemory(resumed, delivery)).duplicate).toBe(true);
    const restored = await context(resumed);
    expect(restored.attribution.db!.getEvents(restored.ownerId)).toHaveLength(count);
    await expect(runtime!.ingestMemory(resumed, prompt("native-retry", "changedpayload"))).rejects.toThrow();
    expect(await runtime!.recoverMemory(resumed)).not.toContain("changedpayload");
  });

  test.each(["revoke", "expire"])("%s rejects stale memory operations after capacity closes their storage", async (mode) => {
    await start({ maxProjects: 1, maxSessions: 1 });
    const a = identity(); await runtime!.ingestMemory(a, prompt("native-a", "orchardalpha"));
    const opened = await context(a);
    const storeClose = vi.spyOn(opened.store, "close");
    const dbClose = vi.spyOn(opened.attribution.db!, "close");
    if (mode === "revoke") authority.revoke(scopeOf(a)); else clock += 1000;
    const b = identity({ workspace: join(root, "second-workspace"), sessionId: "second-session" });
    expect(await runtime!.recoverMemory(b)).not.toContain("orchardalpha");
    expect(storeClose).toHaveBeenCalledTimes(1); expect(dbClose).toHaveBeenCalledTimes(1);
    const read = vi.spyOn(opened.attribution.db!, "getEvents");
    const write = vi.spyOn(opened.attribution.db!, "applySharedMemoryDelivery");
    await expect(runtime!.recoverMemory(a)).rejects.toThrow(/inactive|expired|revoked/i);
    await expect(runtime!.ingestMemory(a, prompt("late", "latewrite"))).rejects.toThrow(/inactive|expired|revoked/i);
    expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  });

  test("memory cannot steal storage from a revoked owner while its tool is still running", async () => {
    await start({ maxProjects: 1, maxSessions: 1 });
    const a = identity(); await runtime!.ingestMemory(a, prompt("native-a", "orchardalpha"));
    const opened = await context(a); const storeClose = vi.spyOn(opened.store, "close");
    const { REGISTERED_CTX_TOOLS } = await import("../../src/server.js");
    const tool = REGISTERED_CTX_TOOLS.find((entry) => entry.name === "ctx_stats")!;
    const original = tool.handler, entered = deferred(), release = deferred();
    tool.handler = async (args, extra) => { entered.resolve(); await release.promise; return original(args, extra); };
    const pending = call(a);
    try {
      await entered.promise; authority.revoke(scopeOf(a));
      const b = identity({ workspace: join(root, "second-workspace"), sessionId: "second-session" });
      await expect(runtime!.recoverMemory(b)).rejects.toThrow(/capacity/i);
      expect(storeClose).not.toHaveBeenCalled();
      release.resolve(); text(await pending);
      expect(await runtime!.recoverMemory(b)).not.toContain("orchardalpha");
      expect(storeClose).toHaveBeenCalledTimes(1);
    } finally { release.resolve(); tool.handler = original; await pending.catch(() => undefined); }
  });

  test("close drains an admitted memory write and rejects later recovery without losing the committed delivery", async () => {
    await start();
    const owner = identity(); const opened = await context(owner);
    const storeClose = vi.spyOn(opened.store, "close");
    const pending = runtime!.ingestMemory(owner, prompt("native-a", "orchardalpha"));
    const closing = runtime!.close();
    const [result] = await Promise.all([pending, closing]);
    expect(result.events).toBeGreaterThan(0); expect(storeClose).toHaveBeenCalledTimes(1);
    await expect(runtime!.recoverMemory(owner)).rejects.toThrow(/closed/i);
    await expect(runtime!.ingestMemory(owner, prompt("late", "latewrite"))).rejects.toThrow(/closed/i);
    runtime = undefined; await start();
    expect(await runtime!.recoverMemory(owner)).toContain("orchardalpha");
    expect(await runtime!.recoverMemory(owner)).not.toContain("latewrite");
  });

  test("inactive launches cannot create a memory store from ambient configuration", async () => {
    await start(); const owner = identity(); authority.revoke(scopeOf(owner));
    await expect(runtime!.ingestMemory(owner, prompt("native-a", "orchardalpha"))).rejects.toThrow(/inactive|revoked/i);
    await expect(runtime!.recoverMemory(owner)).rejects.toThrow(/inactive|revoked/i);
    expect(existsSync(join(owner.home, "context-mode"))).toBe(false);
    expect(existsSync(join(root, "fallback", "context-mode"))).toBe(false);
  });

  test("missing trusted liveness denies memory before storage admission but preserves legacy tool-only calls", async () => {
    const { createSharedRuntime } = await import("../../src/shared/runtime.js");
    runtime = await createSharedRuntime({ identityRegistry: registry, maxProjects: 1, maxSessions: 1,
      now: () => clock, resolveUserHome: (scope) => authority.metadata(scope).userHome });
    const denied = identity(), legacy = identity({ sessionId: "legacy-session" });
    await expect(runtime.ingestMemory(denied, prompt("native-a", "orchardalpha"))).rejects.toThrow(/trusted launch liveness/i);
    await expect(runtime.recoverMemory(denied)).rejects.toThrow(/trusted launch liveness/i);
    expect(existsSync(join(denied.home, "context-mode"))).toBe(false);
    expect(existsSync(join(root, "fallback", "context-mode"))).toBe(false);
    // This distinct owner can take the only slot: rejected memory calls did not
    // silently allocate an owner even when there were no files yet.
    expect(text(await call(legacy))).toMatch(/context.mode/i);
    expect(existsSync(join(legacy.home, "context-mode"))).toBe(true);
    await expect(runtime.recoverMemory(legacy)).rejects.toThrow(/trusted launch liveness/i);
  });
});
