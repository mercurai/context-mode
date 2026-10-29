import { describe, expect, it } from "vitest";
import type { PlatformId } from "../../src/adapters/types.js";
import { SharedIdentityRegistry, type IdentityRegistration, type MemoryOwnerRegistration } from "../../src/shared/identity.js";

type Scope = {
  provider: Extract<PlatformId, "codex" | "claude-code">;
  home: string;
  launchId: string;
};

const CODEX: Scope = {
  provider: "codex",
  home: "C:/Users/example/codex-home",
  launchId: "launch-a",
};
const CLAUDE: Scope = { ...CODEX, provider: "claude-code" };
const WORKTREE_A = "D:/worktrees/Project/feature-a";
const WORKTREE_B = "D:/worktrees/Project/feature-b";
const TOOL = "ctx_search";
const TTL_MS = 1_000;

// Native-memory observations are a separate permission namespace from MCP calls.
// These fixtures pin registry semantics; they do not qualify native hook payloads.
describe.each([CODEX, CLAUDE])("shared memory identity: $provider", (scope) => {
  const root = (sessionId = "root", workspace = WORKTREE_A): MemoryOwnerRegistration =>
    ({ kind: "root", sessionId, workspace });
  const child = (agentId = "child", sessionId = "root"): MemoryOwnerRegistration =>
    ({ kind: "child", sessionId, workspace: WORKTREE_A, agentId });
  const canonical = (sessionId = "root", agentId?: string) => ({ ...scope, sessionId, workspace: WORKTREE_A,
    ...(scope.provider === "codex" ? { threadId: agentId ?? sessionId } : agentId ? { agentId } : {}) });

  it("resolves interleaved roots and children without a recent-session fallback", () => {
    const { registry } = fixture();
    registry.registerMemoryOwner(scope, root());
    registry.registerMemoryOwner(scope, root("other"));
    registry.registerMemoryOwner(scope, child());
    registry.registerMemoryOwner(scope, child("other-child", "other"));
    expect(registry.resolveMemoryOwner(scope, { sessionId: "root" })).toEqual(canonical());
    expect(registry.resolveMemoryOwner(scope, { sessionId: "root", agentId: "child" })).toEqual(canonical("root", "child"));
    expect(registry.resolveMemoryOwner(scope, { sessionId: "other", agentId: "other-child" })).toEqual(canonical("other", "other-child"));
    expect(() => registry.resolveMemoryOwner(scope, { sessionId: "missing" })).toThrow();
    expect(() => registry.resolveMemoryOwner(scope, { sessionId: "other", agentId: "child" })).toThrow();
  });

  it("separates root, child, memory tool and callable MCP identifiers", () => {
    const { registry } = fixture();
    registry.registerMemoryOwner(scope, root("same"));
    registry.registerMemoryOwner(scope, child("child", "same"));
    registry.registerMemoryTool(scope, { owner: { sessionId: "same", agentId: "child" }, toolUseId: "same", tool: "Bash" });
    expect(registry.resolveMemoryTool(scope, { toolUseId: "same", tool: "Bash" })).toEqual(canonical("same", "child"));
    expect(() => registry.resolve(scope, scope.provider === "codex" ? codexCall("same", "same") : claudeCall("same"))).toThrow();
    registry.register(scope, scope.provider === "codex"
      ? { kind: "codex-thread", threadId: "same", sessionId: "mcp-session", workspace: WORKTREE_B }
      : { kind: "claude-tool-call", toolUseId: "same", tool: TOOL, sessionId: "mcp-session", workspace: WORKTREE_B });
    expect(registry.resolve(scope, scope.provider === "codex" ? codexCall("same", "mcp-session") : claudeCall("same")))
      .toMatchObject({ sessionId: "mcp-session", workspace: WORKTREE_B });
    expect(registry.resolveMemoryOwner(scope, { sessionId: "same" })).toEqual(canonical("same"));
    expect(registry.resolveMemoryTool(scope, { toolUseId: "same", tool: "Bash" })).toEqual(canonical("same", "child"));
  });

  it.each(["unknown-root", "self-child", "wrong-workspace"])("rejects %s child enrollment", (kind) => {
    const { registry } = fixture();
    registry.registerMemoryOwner(scope, root());
    expect(registry.resolveMemoryOwner(scope, { sessionId: "root" })).toEqual(canonical());
    const registration = { ...child(kind === "self-child" ? "root" : "child", kind === "unknown-root" ? "missing" : "root"),
      ...(kind === "wrong-workspace" ? { workspace: WORKTREE_B } : {}) };
    expect(() => registry.registerMemoryOwner(scope, registration)).toThrow();
    expect(() => registry.resolveMemoryOwner(scope, { sessionId: registration.sessionId, agentId: "child" })).toThrow();
    expect(registry.resolveMemoryOwner(scope, { sessionId: "root" })).toEqual(canonical());
  });

  it("rejects unsupported parent overrides without inventing nested lineage", () => {
    const { registry } = fixture();
    registry.registerMemoryOwner(scope, root());
    expect(registry.resolveMemoryOwner(scope, { sessionId: "root" })).toEqual(canonical());
    expect(() => registry.registerMemoryOwner(scope, { ...child(), parent: { sessionId: "root", agentId: "other" } } as never)).toThrow();
    expect(() => registry.resolveMemoryOwner(scope, { sessionId: "root", agentId: "child" })).toThrow();
  });

  it("tombstones conflicting owner enrollment without redirecting old selectors", () => {
    const { registry } = fixture();
    registry.registerMemoryOwner(scope, root());
    registry.registerMemoryOwner(scope, root("other"));
    registry.registerMemoryOwner(scope, child());
    expect(registry.resolveMemoryOwner(scope, { sessionId: "root", agentId: "child" })).toEqual(canonical("root", "child"));
    expect(() => registry.registerMemoryOwner(scope, child("child", "other"))).toThrow();
    expect(() => registry.resolveMemoryOwner(scope, { sessionId: "root", agentId: "child" })).toThrow();
    expect(() => registry.resolveMemoryOwner(scope, { sessionId: "other", agentId: "child" })).toThrow();
    expect(registry.resolveMemoryOwner(scope, { sessionId: "root" })).toEqual(canonical());
  });

  it("pins native tool name and owner and tombstones conflicting invocation reuse", () => {
    const { registry } = fixture();
    registry.registerMemoryOwner(scope, root());
    registry.registerMemoryOwner(scope, root("other"));
    const tool = { owner: { sessionId: "root" }, toolUseId: "call", tool: "Bash" };
    registry.registerMemoryTool(scope, tool);
    expect(registry.resolveMemoryTool(scope, { toolUseId: "call", tool: "Bash" })).toEqual(canonical());
    expect(() => registry.resolveMemoryTool(scope, { toolUseId: "call", tool: "Read" })).toThrow();
    expect(() => registry.registerMemoryTool(scope, { ...tool, owner: { sessionId: "other" } })).toThrow();
    expect(() => registry.resolveMemoryTool(scope, { toolUseId: "call", tool: "Bash" })).toThrow();
  });

  it("root ambiguity invalidates previously enrolled children and their tools", () => {
    const { registry } = fixture();
    registry.registerMemoryOwner(scope, root());
    registry.registerMemoryOwner(scope, child());
    registry.registerMemoryTool(scope, { owner: { sessionId: "root", agentId: "child" }, toolUseId: "call", tool: "Bash" });
    expect(registry.resolveMemoryOwner(scope, { sessionId: "root", agentId: "child" })).toEqual(canonical("root", "child"));
    expect(registry.resolveMemoryTool(scope, { toolUseId: "call", tool: "Bash" })).toEqual(canonical("root", "child"));
    expect(() => registry.registerMemoryOwner(scope, root("root", WORKTREE_B))).toThrow();
    expect(() => registry.resolveMemoryOwner(scope, { sessionId: "root" })).toThrow();
    expect(() => registry.resolveMemoryOwner(scope, { sessionId: "root", agentId: "child" })).toThrow();
    expect(() => registry.resolveMemoryTool(scope, { toolUseId: "call", tool: "Bash" })).toThrow();
  });

  it("child ambiguity invalidates its existing tool binding without invalidating another owner", () => {
    const { registry } = fixture();
    registry.registerMemoryOwner(scope, root());
    registry.registerMemoryOwner(scope, root("other"));
    registry.registerMemoryOwner(scope, child());
    registry.registerMemoryTool(scope, { owner: { sessionId: "root", agentId: "child" }, toolUseId: "call", tool: "Bash" });
    registry.registerMemoryTool(scope, { owner: { sessionId: "other" }, toolUseId: "other-call", tool: "Read" });
    expect(registry.resolveMemoryTool(scope, { toolUseId: "call", tool: "Bash" })).toEqual(canonical("root", "child"));
    expect(() => registry.registerMemoryOwner(scope, child("child", "other"))).toThrow();
    expect(() => registry.resolveMemoryOwner(scope, { sessionId: "root", agentId: "child" })).toThrow();
    expect(() => registry.resolveMemoryTool(scope, { toolUseId: "call", tool: "Bash" })).toThrow();
    expect(registry.resolveMemoryTool(scope, { toolUseId: "other-call", tool: "Read" })).toEqual(canonical("other"));
  });

  it("later child and tool enrollment cannot extend their root's expiry", () => {
    const { registry, advance } = fixture();
    registry.registerMemoryOwner(scope, root());
    advance(250);
    registry.registerMemoryOwner(scope, child());
    advance(250);
    registry.registerMemoryTool(scope, { owner: { sessionId: "root", agentId: "child" }, toolUseId: "call", tool: "Bash" });
    advance(499);
    expect(registry.resolveMemoryOwner(scope, { sessionId: "root", agentId: "child" })).toEqual(canonical("root", "child"));
    expect(registry.resolveMemoryTool(scope, { toolUseId: "call", tool: "Bash" })).toEqual(canonical("root", "child"));
    advance(1);
    expect(() => registry.resolveMemoryOwner(scope, { sessionId: "root" })).toThrow();
    expect(() => registry.resolveMemoryOwner(scope, { sessionId: "root", agentId: "child" })).toThrow();
    expect(() => registry.resolveMemoryTool(scope, { toolUseId: "call", tool: "Bash" })).toThrow();
  });

  it("a later root-tool binding cannot outlive the exact enrolled root", () => {
    const { registry, advance } = fixture();
    registry.registerMemoryOwner(scope, root());
    advance(500);
    registry.registerMemoryTool(scope, { owner: { sessionId: "root" }, toolUseId: "call", tool: "Bash" });
    advance(499);
    expect(registry.resolveMemoryTool(scope, { toolUseId: "call", tool: "Bash" })).toEqual(canonical());
    advance(1);
    expect(() => registry.resolveMemoryOwner(scope, { sessionId: "root" })).toThrow();
    expect(() => registry.resolveMemoryTool(scope, { toolUseId: "call", tool: "Bash" })).toThrow();
  });

  it("does not renew expiry on duplicate enrollment or tool registration", () => {
    const { registry, advance } = fixture();
    registry.registerMemoryOwner(scope, root());
    const tool = { owner: { sessionId: "root" }, toolUseId: "call", tool: "Bash" };
    registry.registerMemoryTool(scope, tool);
    expect(registry.resolveMemoryTool(scope, { toolUseId: "call", tool: "Bash" })).toEqual(canonical());
    advance(TTL_MS - 1);
    registry.registerMemoryOwner(scope, root());
    registry.registerMemoryTool(scope, tool);
    advance(1);
    expect(() => registry.resolveMemoryOwner(scope, { sessionId: "root" })).toThrow();
    expect(() => registry.resolveMemoryTool(scope, { toolUseId: "call", tool: "Bash" })).toThrow();
    expect(() => registry.registerMemoryOwner(scope, root())).toThrow();
  });

  it("shares one capacity budget with legacy MCP entries and keeps tombstones", () => {
    const { registry, advance } = fixture(2);
    registry.register(scope, scope.provider === "codex" ? codexRegistration() : claudeRegistration());
    registry.registerMemoryOwner(scope, root());
    expect(registry.resolveMemoryOwner(scope, { sessionId: "root" })).toEqual(canonical());
    expect(() => registry.registerMemoryTool(scope, { owner: { sessionId: "root" }, toolUseId: "call", tool: "Bash" })).toThrow();
    advance(TTL_MS);
    expect(() => registry.registerMemoryOwner({ ...scope, launchId: "fresh" }, root())).toThrow();
  });

  it("counts memory tool observations against the same legacy registration capacity", () => {
    const { registry } = fixture(2);
    registry.registerMemoryOwner(scope, root());
    registry.registerMemoryTool(scope, { owner: { sessionId: "root" }, toolUseId: "call", tool: "Bash" });
    expect(registry.resolveMemoryTool(scope, { toolUseId: "call", tool: "Bash" })).toEqual(canonical());
    expect(() => registry.register(scope, scope.provider === "codex" ? codexRegistration() : claudeRegistration())).toThrow();
    expect(registry.resolveMemoryOwner(scope, { sessionId: "root" })).toEqual(canonical());
  });

  it("revokes all namespaces while leaving a separately enrolled launch intact", () => {
    const { registry } = fixture();
    const other = { ...scope, launchId: "other" };
    registry.registerMemoryOwner(scope, root());
    registry.registerMemoryOwner(other, root());
    registry.registerMemoryTool(scope, { owner: { sessionId: "root" }, toolUseId: "call", tool: "Bash" });
    expect(registry.resolveMemoryOwner(scope, { sessionId: "root" })).toEqual(canonical());
    registry.revokeLaunch(scope);
    expect(() => registry.resolveMemoryOwner(scope, { sessionId: "root" })).toThrow();
    expect(() => registry.resolveMemoryTool(scope, { toolUseId: "call", tool: "Bash" })).toThrow();
    expect(() => registry.registerMemoryOwner(scope, root("new"))).toThrow();
    expect(registry.resolveMemoryOwner(other, { sessionId: "root" })).toEqual({ ...canonical(), launchId: "other" });
  });

  it("requires new-launch enrollment and preserves the same canonical durable identity", () => {
    const { registry } = fixture();
    registry.registerMemoryOwner(scope, root());
    const old = registry.resolveMemoryOwner(scope, { sessionId: "root" });
    const resumed = { ...scope, launchId: "resumed" };
    expect(() => registry.resolveMemoryOwner(resumed, { sessionId: "root" })).toThrow();
    registry.registerMemoryOwner(resumed, root());
    const next = registry.resolveMemoryOwner(resumed, { sessionId: "root" });
    expect(next).toEqual({ ...old, launchId: "resumed" });
    expect(() => registry.resolveMemoryOwner({ ...resumed, home: "C:/different-home" }, { sessionId: "root" })).toThrow();
    expect(() => registry.resolveMemoryOwner({ ...resumed, provider: scope.provider === "codex" ? "claude-code" : "codex" }, { sessionId: "root" })).toThrow();
  });

  it("snapshots registration and resolved objects without accepting identity overrides", () => {
    const { registry } = fixture();
    const registration = root();
    registry.registerMemoryOwner(scope, registration);
    registration.workspace = WORKTREE_B;
    const identity = registry.resolveMemoryOwner(scope, { sessionId: "root" });
    identity.workspace = WORKTREE_B;
    expect(registry.resolveMemoryOwner(scope, { sessionId: "root" })).toEqual(canonical());
    expect(() => registry.resolveMemoryOwner(scope, { sessionId: "root", workspace: WORKTREE_B } as never)).toThrow();
    let evaluated = false;
    expect(() => registry.registerMemoryOwner(scope, { kind: "root", workspace: WORKTREE_A,
      get sessionId() { evaluated = true; return "evil"; } })).toThrow();
    expect(evaluated).toBe(false);
  });
});

function fixture(maxEntries = 8) {
  let elapsed = 0;
  return {
    registry: new SharedIdentityRegistry({
      now: () => new Date(elapsed),
      ttlMs: TTL_MS,
      maxEntries,
    }),
    advance: (milliseconds: number) => { elapsed += milliseconds; },
  };
}

function codexRegistration(threadId = "thread-a", workspace = WORKTREE_A) {
  return { kind: "codex-thread" as const, threadId, sessionId: "root-a", workspace };
}

function claudeRegistration(toolUseId = "call-a", sessionId = "session-a") {
  return {
    kind: "claude-tool-call" as const,
    toolUseId,
    sessionId,
    workspace: WORKTREE_A,
    tool: TOOL,
  };
}

function codexCall(threadId = "thread-a", sessionId = "root-a") {
  return { name: TOOL, _meta: { threadId, sessionId } };
}

function claudeCall(toolUseId = "call-a", name = TOOL) {
  return { name, _meta: { "claudecode/toolUseId": toolUseId } };
}

// Scope is supplied by the authenticated transport adapter, not tool arguments.
// register() is the trusted hook/launcher boundary. These tests deliberately do
// not manufacture credentials or claim to test transport authentication itself.
describe("shared identity: authenticated scope", () => {
  it.each([
    ["provider", { provider: "claude-code" as const }],
    ["home", { home: "C:/Users/example/other-home" }],
    ["launch", { launchId: "launch-b" }],
  ] as const)("refuses a known identifier in a different %s", (_label, difference) => {
    const { registry } = fixture();
    registry.register(CODEX, codexRegistration());
    const request = {
      name: TOOL,
      _meta: { ...codexCall()._meta, "claudecode/toolUseId": "thread-a" },
    };
    expect(() => registry.resolve({ ...CODEX, ...difference }, request)).toThrow();
    expect(registry.resolve(CODEX, request)).toMatchObject({ threadId: "thread-a" });
  });

  it.each([
    { provider: "codex" as const },
    { home: "C:/Users/example/other-home" },
    { launchId: "launch-b" },
  ])("does not expose Claude registrations through another scope %#", (difference) => {
    const { registry } = fixture();
    registry.register(CLAUDE, claudeRegistration());
    const request = { ...claudeCall(), _meta: { ...claudeCall()._meta, threadId: "call-a", sessionId: "session-a" } };
    expect(() => registry.resolve({ ...CLAUDE, ...difference }, request)).toThrow();
  });

  it("keeps identical identifiers independent across authenticated homes", () => {
    const { registry } = fixture();
    const otherHome = { ...CODEX, home: "C:/Users/example/other-home" };
    registry.register(CODEX, codexRegistration());
    registry.register(otherHome, codexRegistration("thread-a", WORKTREE_B));
    expect(registry.resolve(CODEX, codexCall())).toMatchObject({ ...CODEX, workspace: WORKTREE_A });
    expect(registry.resolve(otherHome, codexCall())).toMatchObject({ ...otherHome, workspace: WORKTREE_B });
  });

  it("refuses provider-incompatible trusted registration", () => {
    const { registry } = fixture();
    expect(() => registry.register(CODEX, claudeRegistration())).toThrow();
    expect(() => registry.register(CLAUDE, codexRegistration())).toThrow();
  });

  it.each([
    { ...CODEX, home: "" },
    { ...CODEX, launchId: "" },
  ])("refuses incomplete authenticated scope %#", (scope) => {
    const { registry } = fixture();
    expect(() => registry.register(scope, codexRegistration())).toThrow();
  });
});

describe("shared identity: native Codex request metadata", () => {
  it("isolates concrete child threads that share the same root session", () => {
    const { registry } = fixture();
    registry.register(CODEX, codexRegistration("child-a", WORKTREE_A));
    registry.register(CODEX, codexRegistration("child-b", WORKTREE_B));
    for (const [threadId, workspace] of [
      ["child-a", WORKTREE_A], ["child-b", WORKTREE_B], ["child-a", WORKTREE_A],
    ]) {
      expect(registry.resolve(CODEX, codexCall(threadId))).toMatchObject({
        threadId, sessionId: "root-a", workspace,
      });
    }
  });

  it("routes interleaved root conversations without a transport-wide current session", () => {
    const { registry } = fixture();
    registry.register(CODEX, { ...codexRegistration(), threadId: "root-a" });
    registry.register(CODEX, {
      ...codexRegistration("root-b", WORKTREE_B), sessionId: "root-b",
    });
    expect(registry.resolve(CODEX, codexCall("root-b", "root-b")))
      .toMatchObject({ threadId: "root-b", workspace: WORKTREE_B });
    expect(registry.resolve(CODEX, codexCall("root-a")))
      .toMatchObject({ threadId: "root-a", workspace: WORKTREE_A });
  });

  it.each([
    undefined, {}, { sessionId: "root-a" }, { threadId: "thread-a" },
    { threadId: "unknown", sessionId: "root-a" },
    { threadId: "", sessionId: "root-a" }, { threadId: 42, sessionId: "root-a" },
    { threadId: "thread-a", sessionId: "another-root" },
  ])("refuses missing, malformed or unbound identity %#", (_meta) => {
    const { registry } = fixture();
    registry.register(CODEX, codexRegistration());
    expect(() => registry.resolve(CODEX, { name: TOOL, _meta })).toThrow();
  });

  it("preserves the registered exact worktree without collapsing it to a project", () => {
    const { registry } = fixture();
    const workspace = "D:/worktrees/Mixed Case Project/feature-a";
    registry.register(CODEX, codexRegistration("thread-a", workspace));
    expect(registry.resolve(CODEX, codexCall()).workspace).toBe(workspace);
  });

  it("refuses an ambiguous thread binding instead of choosing first or latest", () => {
    const { registry } = fixture();
    registry.register(CODEX, codexRegistration());
    expect(() => registry.register(CODEX, codexRegistration("thread-a", WORKTREE_B))).toThrow();
    expect(() => registry.resolve(CODEX, codexCall())).toThrow();
  });
});

describe("shared identity: native Claude tool-use correlation", () => {
  it("requires trusted registration completed before the native MCP call", () => {
    const { registry } = fixture();
    expect(() => registry.resolve(CLAUDE, claudeCall())).toThrow();
    registry.register(CLAUDE, claudeRegistration());
    expect(registry.resolve(CLAUDE, claudeCall())).toMatchObject({
      ...CLAUDE, sessionId: "session-a", workspace: WORKTREE_A,
    });
  });

  it("distinguishes concurrent agents within the same Claude session", () => {
    const { registry } = fixture();
    registry.register(CLAUDE, { ...claudeRegistration(), agentId: "agent-a" });
    registry.register(CLAUDE, {
      ...claudeRegistration("call-b"), agentId: "agent-b", workspace: WORKTREE_B,
    });
    expect(registry.resolve(CLAUDE, claudeCall("call-b"))).toMatchObject({
      sessionId: "session-a", agentId: "agent-b", workspace: WORKTREE_B,
    });
    expect(registry.resolve(CLAUDE, claudeCall())).toMatchObject({
      sessionId: "session-a", agentId: "agent-a", workspace: WORKTREE_A,
    });
  });

  it("keeps retries bound to the original call after a clear or another conversation", () => {
    const { registry } = fixture();
    registry.register(CLAUDE, claudeRegistration());
    registry.register(CLAUDE, claudeRegistration("call-after-clear", "session-after-clear"));
    expect(registry.resolve(CLAUDE, claudeCall("call-after-clear")))
      .toMatchObject({ sessionId: "session-after-clear" });
    expect(registry.resolve(CLAUDE, claudeCall())).toMatchObject({ sessionId: "session-a" });
    registry.register(CLAUDE, claudeRegistration());
    expect(registry.resolve(CLAUDE, claudeCall())).toMatchObject({ sessionId: "session-a" });
  });

  it("refuses the correct call identifier when used for a different tool", () => {
    const { registry } = fixture();
    registry.register(CLAUDE, claudeRegistration());
    expect(() => registry.resolve(CLAUDE, claudeCall("call-a", "ctx_execute"))).toThrow();
  });

  it("does not accept model arguments as registration or identity", () => {
    const { registry } = fixture();
    const argumentsFromModel = {
      ...claudeRegistration(), ...CLAUDE, "claudecode/toolUseId": "call-a",
    };
    expect(() => registry.resolve(CLAUDE, {
      name: TOOL, arguments: argumentsFromModel,
    })).toThrow();
    registry.register(CLAUDE, claudeRegistration());
    expect(registry.resolve(CLAUDE, {
      ...claudeCall(), arguments: { ...argumentsFromModel, sessionId: "victim", workspace: WORKTREE_B },
    })).toMatchObject({ sessionId: "session-a", workspace: WORKTREE_A });
  });

  it.each([undefined, {}, { "claudecode/toolUseId": "unknown" }, { "claudecode/toolUseId": 42 }])(
    "refuses missing or unknown native call metadata %#", (_meta) => {
      const { registry } = fixture();
      registry.register(CLAUDE, claudeRegistration());
      expect(() => registry.resolve(CLAUDE, { name: TOOL, _meta })).toThrow();
    },
  );

  it("invalidates a call identifier that is replayed as a different session", () => {
    const { registry } = fixture();
    registry.register(CLAUDE, claudeRegistration());
    expect(() => registry.register(CLAUDE, claudeRegistration("call-a", "victim"))).toThrow();
    expect(() => registry.resolve(CLAUDE, claudeCall())).toThrow();
  });
});

describe("shared identity: bounded lifecycle", () => {
  it("expires bindings at the deadline without extending them for retries", () => {
    const { registry, advance } = fixture();
    registry.register(CLAUDE, claudeRegistration());
    advance(TTL_MS - 1);
    registry.register(CLAUDE, claudeRegistration());
    expect(registry.resolve(CLAUDE, claudeCall())).toMatchObject({ sessionId: "session-a" });
    advance(1);
    expect(() => registry.resolve(CLAUDE, claudeCall())).toThrow();
  });

  it("also expires Codex thread registrations", () => {
    const { registry, advance } = fixture();
    registry.register(CODEX, codexRegistration());
    advance(TTL_MS);
    expect(() => registry.resolve(CODEX, codexCall())).toThrow();
  });

  it("revokes a launch without disturbing another launch or permitting old re-registration", () => {
    const { registry } = fixture();
    const otherLaunch = { ...CLAUDE, launchId: "launch-b" };
    registry.register(CLAUDE, claudeRegistration());
    registry.register(otherLaunch, claudeRegistration("call-a", "session-b"));
    registry.revokeLaunch(CLAUDE);
    expect(() => registry.resolve(CLAUDE, claudeCall())).toThrow();
    expect(() => registry.register(CLAUDE, claudeRegistration())).toThrow();
    expect(registry.resolve(otherLaunch, claudeCall())).toMatchObject({ sessionId: "session-b" });
  });

  it("bounds identity history without reclaiming expired identifiers", () => {
    const { registry, advance } = fixture(2);
    registry.register(CODEX, codexRegistration());
    registry.register(CLAUDE, claudeRegistration());
    expect(() => registry.register(CLAUDE, claudeRegistration("call-c"))).toThrow();
    expect(registry.resolve(CODEX, codexCall())).toMatchObject({ threadId: "thread-a" });
    expect(registry.resolve(CLAUDE, claudeCall())).toMatchObject({ sessionId: "session-a" });
    advance(TTL_MS);
    expect(() => registry.register(CLAUDE, claudeRegistration("call-c"))).toThrow();
    expect(() => registry.resolve(CODEX, codexCall())).toThrow();
    expect(() => registry.resolve(CLAUDE, claudeCall())).toThrow();
  });

  it("retains ambiguity tombstones beyond the original registration deadline", () => {
    const { registry, advance } = fixture(1);
    registry.register(CLAUDE, claudeRegistration());
    expect(() => registry.register(CLAUDE, claudeRegistration("call-a", "conflict"))).toThrow();
    expect(() => registry.register(CLAUDE, claudeRegistration("call-b"))).toThrow();
    advance(TTL_MS);
    expect(() => registry.register(CLAUDE, claudeRegistration("call-b"))).toThrow();
    expect(() => registry.register(CLAUDE, claudeRegistration())).toThrow();
    expect(() => registry.resolve(CLAUDE, claudeCall())).toThrow();
  });

  it("retains revocations after registration expiry and charges them against capacity", () => {
    const { registry, advance } = fixture(1);
    registry.register(CLAUDE, claudeRegistration());
    registry.revokeLaunch(CLAUDE);
    registry.revokeLaunch(CLAUDE);
    advance(TTL_MS * 2);
    expect(() => registry.register(CLAUDE, claudeRegistration())).toThrow();
    expect(() => registry.register({ ...CLAUDE, launchId: "fresh" }, claudeRegistration())).toThrow();
  });

  it("reports unknown-launch revocation capacity without disabling an unrelated launch", () => {
    const { registry } = fixture(1);
    registry.register(CLAUDE, claudeRegistration());
    expect(() => registry.revokeLaunch({ ...CLAUDE, launchId: "unseen" }))
      .toThrow(/revocation.*capacity/i);
    expect(registry.resolve(CLAUDE, claudeCall())).toMatchObject({ sessionId: "session-a" });
    registry.revokeLaunch(CLAUDE);
    expect(() => registry.resolve(CLAUDE, claudeCall())).toThrow();
  });

  it("never rebinds an expired Claude call identifier to a different session", () => {
    const { registry, advance } = fixture();
    registry.register(CLAUDE, claudeRegistration());
    advance(TTL_MS);
    expect(() => registry.register(CLAUDE, claudeRegistration("call-a", "session-b"))).toThrow();
    // A delayed request has only its native call ID: it must never resolve to B.
    expect(() => registry.resolve(CLAUDE, claudeCall())).toThrow();
  });

  it("does not revive an expired binding by repeating its original registration", () => {
    const { registry, advance } = fixture();
    registry.register(CLAUDE, claudeRegistration());
    advance(TTL_MS);
    expect(() => registry.register(CLAUDE, claudeRegistration())).toThrow();
    expect(() => registry.resolve(CLAUDE, claudeCall())).toThrow();
  });

  it("refuses a backwards clock instead of reviving an expired binding", () => {
    const { registry, advance } = fixture();
    registry.register(CLAUDE, claudeRegistration());
    advance(TTL_MS);
    expect(() => registry.resolve(CLAUDE, claudeCall())).toThrow();
    advance(-TTL_MS);
    expect(() => registry.resolve(CLAUDE, claudeCall())).toThrow();
  });

  it("refuses an invalid clock without changing the identity binding", () => {
    let clock = new Date(0);
    const registry = new SharedIdentityRegistry({ now: () => clock, ttlMs: TTL_MS, maxEntries: 1 });
    registry.register(CLAUDE, claudeRegistration());
    clock = new Date(NaN);
    expect(() => registry.resolve(CLAUDE, claudeCall())).toThrow();
    clock = new Date(0);
    expect(registry.resolve(CLAUDE, claudeCall())).toMatchObject({ sessionId: "session-a" });
  });
});

describe("shared identity: input and state ownership", () => {
  it.each([
    null,
    { ...claudeRegistration(), kind: "unknown" },
    { ...claudeRegistration(), toolUseId: "" },
    { ...claudeRegistration(), sessionId: "bad\nidentity" },
    { ...claudeRegistration(), agentId: "" },
    { ...claudeRegistration(), tool: 42 },
    { ...claudeRegistration(), workspace: "relative/worktree" },
    { ...claudeRegistration(), workspace: "D:/worktrees/../other" },
    { ...claudeRegistration(), workspace: "D:drive-relative" },
    { ...claudeRegistration(), toolUseId: "x".repeat(257) },
    { ...claudeRegistration(), unexpected: "model-owned-field" },
  ])("refuses malformed registration %# without poisoning a valid binding", (registration) => {
    const { registry } = fixture();
    registry.register(CLAUDE, claudeRegistration());
    expect(() => registry.register(CLAUDE, registration as IdentityRegistration)).toThrow();
    expect(registry.resolve(CLAUDE, claudeCall())).toMatchObject({ sessionId: "session-a" });
  });

  it("copies registration and scope input and returns independent identity snapshots", () => {
    const { registry } = fixture();
    const scope = { ...CLAUDE };
    const registration = claudeRegistration();
    registry.register(scope, registration);
    scope.home = "D:/other-home";
    registration.workspace = WORKTREE_B;
    registration.sessionId = "other-session";
    const identity = registry.resolve(CLAUDE, claudeCall());
    expect(identity).toMatchObject({ ...CLAUDE, workspace: WORKTREE_A, sessionId: "session-a" });
    identity.workspace = WORKTREE_B;
    identity.sessionId = "mutated-result";
    expect(registry.resolve(CLAUDE, claudeCall())).toMatchObject({ workspace: WORKTREE_A, sessionId: "session-a" });
  });

  it.each([
    { ttlMs: 0, maxEntries: 1 },
    { ttlMs: Number.POSITIVE_INFINITY, maxEntries: 1 },
    { ttlMs: TTL_MS, maxEntries: 0 },
    { ttlMs: TTL_MS, maxEntries: 1.5 },
  ])("refuses an unbounded or invalid registry configuration %#", (options) => {
    expect(() => new SharedIdentityRegistry({ ...options, now: () => new Date(0) })).toThrow();
  });
});
