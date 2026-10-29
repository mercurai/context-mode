import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SharedIdentityRegistry, type NativeToolCall } from "../../src/shared/identity.js";
import { createSharedLaunchAuthority, type SharedLaunchAuthority, type SharedLaunchGrant,
  type SharedLaunchMetadata } from "../../src/shared/launch-authority.js";
import type { SharedRuntime, SharedToolResult } from "../../src/shared/runtime.js";

const TTL = 1000;
const TOOLS = ["ctx_index", "ctx_search", "ctx_stats"];
const call = (threadId = "root", sessionId = "root", name = "ctx_search"): NativeToolCall =>
  ({ name, _meta: { threadId, sessionId } });
const claudeCall = (id = "call", name = "ctx_search"): NativeToolCall =>
  ({ name, _meta: { "claudecode/toolUseId": id } });
const output = (result: SharedToolResult) => result.content.map((block) => block.text ?? "").join("\n");

function request(capability?: string): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  if (capability) {
    req.headers.authorization = `Bearer ${capability}`;
    req.rawHeaders = ["Authorization", `Bearer ${capability}`];
  }
  return req;
}

describe("production shared launch authority", () => {
  let root: string;
  let clock: number;
  let registry: SharedIdentityRegistry;
  let metadata: SharedLaunchMetadata;
  let authorities: SharedLaunchAuthority[];
  let runtimes: SharedRuntime[];

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "shared-launch-authority-")));
    clock = 0;
    authorities = [];
    runtimes = [];
    metadata = { provider: "codex", home: join(root, "config-home"), userHome: join(root, "user-home"), workspace: join(root, "worktree-a") };
    for (const path of [metadata.home, metadata.userHome, metadata.workspace, join(root, "worktree-b"), join(root, "fallback", "tmp")]) mkdirSync(path, { recursive: true });
    for (const [key, value] of Object.entries({ HOME: join(root, "fallback"), USERPROFILE: join(root, "fallback"),
      CODEX_HOME: join(root, "fallback"), CLAUDE_CONFIG_DIR: join(root, "fallback"),
      CONTEXT_MODE_DIR: join(root, "fallback", "storage"), CLAUDE_PROJECT_DIR: join(root, "fallback"),
      CONTEXT_MODE_PROJECT_DIR: join(root, "fallback"), CLAUDE_SESSION_ID: "must-not-be-used",
      TMPDIR: join(root, "fallback", "tmp"), TMP: join(root, "fallback", "tmp"), TEMP: join(root, "fallback", "tmp"),
    })) vi.stubEnv(key, value);
    vi.stubEnv("CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS", undefined);
    registry = newRegistry();
  });

  afterEach(async () => {
    try {
      for (const runtime of runtimes) await runtime.close();
      for (const authority of authorities) authority.close();
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  function newRegistry() {
    return new SharedIdentityRegistry({ now: () => new Date(clock), ttlMs: TTL, maxEntries: 100 });
  }
  function create(maxLaunches = 8, toolNames: readonly string[] = TOOLS) {
    const authority = createSharedLaunchAuthority({ identityRegistry: registry, now: () => new Date(clock),
      ttlMs: TTL, maxLaunches, mcpServerName: "context-mode", toolNames });
    authorities.push(authority);
    return authority;
  }
  function start(authority: SharedLaunchAuthority, grant: SharedLaunchGrant, session = "root", cwd = metadata.workspace) {
    authority.registerHook(request(grant.hookCapability), { hook_event_name: "SessionStart", session_id: session, cwd });
  }
  function preTool(authority: SharedLaunchAuthority, grant: SharedLaunchGrant, extra: Record<string, unknown> = {}) {
    authority.registerHook(request(grant.hookCapability), { hook_event_name: "PreToolUse", session_id: "root", cwd: metadata.workspace,
      tool_use_id: "call", tool_name: "mcp__context-mode__ctx_search", ...extra });
  }

  // Synthetic boundary contracts only. Ordinary-tool payload adapters and nested
  // native child fields still require representative native-client qualification.
  describe.each(["codex", "claude-code"] as const)("native memory enrollment: %s", (provider) => {
    function enroll(authority: SharedLaunchAuthority, grant: SharedLaunchGrant, extra: Record<string, unknown> = {}) {
      authority.registerMemoryHook(request(grant.hookCapability), {
        hook_event_name: "SessionStart", session_id: "root", cwd: metadata.workspace, ...extra,
      });
    }
    function setup() {
      const authority = create();
      const grant = authority.issue({ ...metadata, provider });
      enroll(authority, grant);
      return { authority, grant };
    }
    function expected(grant: SharedLaunchGrant, sessionId = "root", agentId?: string) {
      return { ...grant.scope, sessionId, workspace: metadata.workspace,
        ...(provider === "codex" ? { threadId: agentId ?? sessionId } : agentId ? { agentId } : {}) };
    }

    test("enrolls exact roots without authorizing callable MCP requests", () => {
      const { authority, grant } = setup();
      enroll(authority, grant, { session_id: "other" });
      expect(registry.resolveMemoryOwner(grant.scope, { sessionId: "root" })).toEqual(expected(grant));
      expect(registry.resolveMemoryOwner(grant.scope, { sessionId: "other" })).toEqual(expected(grant, "other"));
      expect(() => registry.resolve(grant.scope, provider === "codex" ? call() : claudeCall())).toThrow();
    });

    test("enrolls a child under its known exact root amid another active conversation", () => {
      const { authority, grant } = setup();
      enroll(authority, grant, { session_id: "other" });
      enroll(authority, grant, { hook_event_name: "SubagentStart", agent_id: "child" });
      expect(registry.resolveMemoryOwner(grant.scope, { sessionId: "root", agentId: "child" })).toEqual(expected(grant, "root", "child"));
      expect(registry.resolveMemoryOwner(grant.scope, { sessionId: "root" })).toEqual(expected(grant));
      expect(() => registry.resolveMemoryOwner(grant.scope, { sessionId: "other", agentId: "child" })).toThrow();
    });

    test("ordinary-tool observation cannot grant MCP permission even on identifier collision", () => {
      const { authority, grant } = setup();
      enroll(authority, grant, { hook_event_name: "PreToolUse", tool_use_id: "call", tool_name: "Bash" });
      expect(registry.resolveMemoryTool(grant.scope, { toolUseId: "call", tool: "Bash" })).toEqual(expected(grant));
      expect(() => registry.resolve(grant.scope, provider === "codex" ? call() : claudeCall())).toThrow();
      if (provider === "codex") start(authority, grant);
      else preTool(authority, grant);
      expect(registry.resolve(grant.scope, provider === "codex" ? call() : claudeCall())).toMatchObject({ sessionId: "root" });
      expect(registry.resolveMemoryTool(grant.scope, { toolUseId: "call", tool: "Bash" })).toEqual(expected(grant));
      // Existing callable registration stays governed by its original whitelist.
      expect(() => preTool(authority, grant, { tool_name: "Bash", tool_use_id: "not-callable" })).toThrow();
    });

    test("binds observed child tools to their enrolled child and exact native tool name", () => {
      const { authority, grant } = setup();
      enroll(authority, grant, { hook_event_name: "SubagentStart", agent_id: "child" });
      enroll(authority, grant, { hook_event_name: "PreToolUse", agent_id: "child", tool_use_id: "child-call", tool_name: "Read" });
      expect(registry.resolveMemoryTool(grant.scope, { toolUseId: "child-call", tool: "Read" })).toEqual(expected(grant, "root", "child"));
      expect(() => registry.resolveMemoryTool(grant.scope, { toolUseId: "child-call", tool: "Bash" })).toThrow();
    });

    test.each(["SubagentStart", "PreToolUse"])("rejects %s with an unknown root instead of using the latest", (event) => {
      const { authority, grant } = setup();
      expect(registry.resolveMemoryOwner(grant.scope, { sessionId: "root" })).toEqual(expected(grant));
      expect(() => enroll(authority, grant, { hook_event_name: event, session_id: "missing", agent_id: "child",
        tool_use_id: "call", tool_name: "Bash" })).toThrow();
      expect(() => registry.resolveMemoryOwner(grant.scope, { sessionId: "missing", agentId: "child" })).toThrow();
      expect(() => registry.resolveMemoryTool(grant.scope, { toolUseId: "call", tool: "Bash" })).toThrow();
    });

    test.each(["workspace", "self-child", "parent-override", "unknown-agent"])("rejects %s without adding an alternate owner", (kind) => {
      const { authority, grant } = setup();
      expect(registry.resolveMemoryOwner(grant.scope, { sessionId: "root" })).toEqual(expected(grant));
      const extra = kind === "workspace" ? { session_id: "other", cwd: join(root, "worktree-b") }
        : kind === "self-child" ? { hook_event_name: "SubagentStart", agent_id: "root" }
        : kind === "parent-override" ? { hook_event_name: "SubagentStart", agent_id: "child", parent_agent_id: "invented" }
        : { hook_event_name: "PreToolUse", agent_id: "unknown", tool_use_id: "call", tool_name: "Bash" };
      expect(() => enroll(authority, grant, extra)).toThrow();
      expect(registry.resolveMemoryOwner(grant.scope, { sessionId: "root" })).toEqual(expected(grant));
    });

    test.each(["mcp-purpose", "revoked", "expired"])("rechecks %s authority before enrolling memory identity", (kind) => {
      const { authority, grant } = setup();
      expect(registry.resolveMemoryOwner(grant.scope, { sessionId: "root" })).toEqual(expected(grant));
      authority.authenticateHook(request(grant.hookCapability));
      if (kind === "revoked") authority.revoke(grant.scope);
      if (kind === "expired") clock = TTL;
      expect(() => authority.registerMemoryHook(request(kind === "mcp-purpose" ? grant.mcpCapability : grant.hookCapability),
        { hook_event_name: "SessionStart", session_id: "other", cwd: metadata.workspace })).toThrow();
      expect(() => registry.resolveMemoryOwner(grant.scope, { sessionId: "other" })).toThrow();
    });

    test("a new launch must re-enroll the same durable owner while the old launch stays revoked", () => {
      const { authority, grant } = setup();
      const previous = registry.resolveMemoryOwner(grant.scope, { sessionId: "root" });
      authority.revoke(grant.scope);
      const resumed = authority.issue({ ...metadata, provider });
      expect(() => registry.resolveMemoryOwner(resumed.scope, { sessionId: "root" })).toThrow();
      enroll(authority, resumed);
      expect(registry.resolveMemoryOwner(resumed.scope, { sessionId: "root" })).toEqual({ ...previous, launchId: resumed.scope.launchId });
      expect(() => enroll(authority, grant)).toThrow();
      expect(() => registry.resolveMemoryOwner(resumed.scope, { sessionId: "different" })).toThrow();
    });

    test("projects identity without reading nonidentity payload fields", () => {
      const { authority, grant } = setup();
      let evaluated = false;
      authority.registerMemoryHook(request(grant.hookCapability), {
        hook_event_name: "PreToolUse", session_id: "root", cwd: metadata.workspace, tool_use_id: "call", tool_name: "Bash",
        get tool_input() { evaluated = true; throw new Error("Payload must not be read during enrollment"); },
        get transcript_path() { evaluated = true; throw new Error("Transcript must not be accessed"); },
      });
      expect(evaluated).toBe(false);
      expect(registry.resolveMemoryTool(grant.scope, { toolUseId: "call", tool: "Bash" })).toEqual(expected(grant));
    });
  });

  test("issues separate opaque capabilities and authenticates only its private scope", async () => {
    const authority = create();
    const grant = authority.issue(metadata);
    // Boolean assertions never expose capabilities in failure diagnostics.
    expect(/^[A-Za-z0-9_-]{32,}$/.test(grant.mcpCapability)).toBe(true);
    expect(/^[A-Za-z0-9_-]{32,}$/.test(grant.hookCapability)).toBe(true);
    expect(grant.mcpCapability !== grant.hookCapability).toBe(true);
    expect(await authority.authenticate(request(grant.mcpCapability))).toEqual(grant.scope);
    expect(await authority.isActive(grant.scope)).toBe(true);
    expect(authority.metadata(grant.scope)).toEqual(metadata);
    expect(JSON.stringify(authority).includes(grant.mcpCapability)).toBe(false);
    expect(JSON.stringify(authority).includes(grant.hookCapability)).toBe(false);
  });

  test("hook credentials cannot authenticate MCP and MCP credentials cannot register identity", async () => {
    const authority = create();
    const grant = authority.issue(metadata);
    await expect(Promise.resolve().then(() => authority.authenticate(request(grant.hookCapability)))).rejects.toThrow();
    expect(() => authority.registerHook(request(grant.mcpCapability), { hook_event_name: "SessionStart", session_id: "root", cwd: metadata.workspace })).toThrow();
    expect(() => registry.resolve(grant.scope, call())).toThrow();
  });

  test("hook prebody authentication returns only the frozen canonical scope", () => {
    const authority = create();
    const grant = authority.issue(metadata);
    const scope = authority.authenticateHook(request(grant.hookCapability));
    expect(scope).toEqual(grant.scope);
    expect(Object.isFrozen(scope)).toBe(true);
    expect(Object.keys(scope).sort()).toEqual(["home", "launchId", "provider"]);
    // Authentication alone never creates a native session registration.
    expect(() => registry.resolve(scope, call())).toThrow();
  });

  test.each(["mcp-purpose", "missing", "unknown", "duplicate", "wrong-scheme"])("hook prebody authentication rejects %s", (kind) => {
    const authority = create();
    const grant = authority.issue(metadata);
    const req = request(kind === "missing" ? undefined : kind === "unknown" ? "synthetic-unknown" :
      kind === "mcp-purpose" ? grant.mcpCapability : grant.hookCapability);
    if (kind === "duplicate") req.rawHeaders.push("Authorization", `Bearer ${grant.hookCapability}`);
    if (kind === "wrong-scheme") req.headers.authorization = `Basic ${grant.hookCapability}`;
    expect(() => authority.authenticateHook(req)).toThrow(/Invalid or inactive launch authority input/);
  });

  test.each(["expired", "revoked", "closed"])("hook prebody authentication rejects a %s launch", (kind) => {
    const authority = create();
    const grant = authority.issue(metadata);
    start(authority, grant);
    if (kind === "expired") clock = TTL;
    else if (kind === "revoked") authority.revoke(grant.scope);
    else authority.close();
    expect(() => authority.authenticateHook(request(grant.hookCapability))).toThrow(/Invalid or inactive launch authority input/);
  });

  test("registration rechecks hook credentials revoked after prebody authentication", () => {
    const authority = create();
    const grant = authority.issue(metadata);
    const scope = authority.authenticateHook(request(grant.hookCapability));
    authority.revoke(scope);
    expect(() => start(authority, grant)).toThrow();
    expect(() => registry.resolve(scope, call())).toThrow();
  });

  test.each(["missing", "unknown", "duplicate", "wrong-scheme"])("rejects %s authentication", async (kind) => {
    const authority = create();
    const grant = authority.issue(metadata);
    const req = request(kind === "missing" ? undefined : kind === "unknown" ? "synthetic-unknown" : grant.mcpCapability);
    if (kind === "duplicate") req.rawHeaders.push("Authorization", `Bearer ${grant.mcpCapability}`);
    if (kind === "wrong-scheme") req.headers.authorization = `Basic ${grant.mcpCapability}`;
    await expect(Promise.resolve().then(() => authority.authenticate(req))).rejects.toThrow();
  });

  test("snapshots launch metadata and does not accept a forged active scope", async () => {
    const authority = create();
    const grant = authority.issue(metadata);
    const original = { ...metadata };
    metadata.workspace = join(root, "worktree-b");
    expect(authority.metadata(grant.scope)).toEqual(original);
    expect(Object.isFrozen(authority.metadata(grant.scope))).toBe(true);
    expect(Object.isFrozen(grant.scope)).toBe(true);
    expect(await authority.isActive({ ...grant.scope, provider: "claude-code" })).toBe(false);
    expect(await authority.isActive({ ...grant.scope, home: metadata.userHome })).toBe(false);
    expect(() => authority.metadata({ ...grant.scope, launchId: "unknown" })).toThrow();
  });

  test.each(["relative", "missing", "dot-segment"])("rejects %s paths at internal issuance", (kind) => {
    const authority = create();
    const path = kind === "relative" ? "worktree-a" : kind === "missing" ? join(root, "absent") : `${root}/worktree-a/../worktree-b`;
    expect(() => authority.issue({ ...metadata, workspace: path })).toThrow();
    expect(() => authority.issue({ ...metadata, home: path })).toThrow();
    expect(() => authority.issue({ ...metadata, userHome: path })).toThrow();
  });

  test("keeps equal native ids separate across launch provider/home/exact worktree", () => {
    const authority = create();
    const a = authority.issue(metadata);
    const b = authority.issue({ ...metadata, home: metadata.userHome, workspace: join(root, "worktree-b") });
    start(authority, a);
    start(authority, b, "root", join(root, "worktree-b"));
    expect(registry.resolve(a.scope, call()).workspace).toBe(metadata.workspace);
    expect(registry.resolve(b.scope, call()).workspace).toBe(join(root, "worktree-b"));
    const claude = authority.issue({ ...metadata, provider: "claude-code" });
    preTool(authority, claude);
    expect(() => registry.resolve(claude.scope, call())).toThrow();
    expect(registry.resolve(claude.scope, claudeCall()).provider).toBe("claude-code");
  });

  test("Codex start and child registration preserve concrete thread and root lineage", () => {
    const authority = create();
    const grant = authority.issue(metadata);
    start(authority, grant);
    authority.registerHook(request(grant.hookCapability), { hook_event_name: "SubagentStart", session_id: "root", agent_id: "child", cwd: metadata.workspace });
    expect(registry.resolve(grant.scope, call("child"))).toMatchObject({ sessionId: "root", threadId: "child", workspace: metadata.workspace });
    expect(() => registry.resolve(grant.scope, call("child", "other-root"))).toThrow();
  });

  test.each(["unknown-root", "self-child", "wrong-worktree", "wrong-provider"])("rejects %s native registration", (kind) => {
    const authority = create();
    const grant = authority.issue(metadata);
    start(authority, grant);
    const payload = { hook_event_name: "SubagentStart", session_id: kind === "unknown-root" ? "unknown" : "root",
      agent_id: kind === "self-child" ? "root" : "child", cwd: kind === "wrong-worktree" ? join(root, "worktree-b") : metadata.workspace };
    expect(() => kind === "wrong-provider" ? preTool(authority, grant) : authority.registerHook(request(grant.hookCapability), payload)).toThrow();
    expect(() => registry.resolve(grant.scope, call("child"))).toThrow();
  });

  test("uses only explicit native identity, ignoring transcript/prompt/tool input scope guesses", () => {
    const authority = create();
    const grant = authority.issue({ ...metadata, provider: "claude-code" });
    preTool(authority, grant, { transcript_path: "/invented/other.jsonl", prompt: "synthetic omitted",
      tool_input: { workspace: join(root, "worktree-b"), session_id: "other", userHome: root },
      provider: "codex", home: root, workspace: root, userHome: root });
    expect(registry.resolve(grant.scope, { ...claudeCall(), arguments: { workspace: root },
      _meta: { "claudecode/toolUseId": "call", workspace: root, home: root } })).toMatchObject({
      provider: "claude-code", home: metadata.home, workspace: metadata.workspace, sessionId: "root",
    });
    expect(authority.metadata(grant.scope).userHome).toBe(metadata.userHome);
    expect(JSON.stringify(authority).includes("synthetic omitted")).toBe(false);
  });

  test.each([undefined, "", 12])("never falls back when native session_id is missing/malformed %#", (session_id) => {
    const authority = create();
    const grant = authority.issue({ ...metadata, provider: "claude-code" });
    expect(() => preTool(authority, grant, { session_id, transcript_path: "/session/root.jsonl" })).toThrow();
    expect(() => registry.resolve(grant.scope, claudeCall())).toThrow();
  });

  test.each(["mcp__other__ctx_search", "mcp__context-mode__ctx_unknown", "ctx_search"])("rejects unowned tool mapping %s", (tool_name) => {
    const authority = create();
    const grant = authority.issue({ ...metadata, provider: "claude-code" });
    expect(() => preTool(authority, grant, { tool_name })).toThrow();
  });

  test("Claude maps exact native qualified name to the registered SDK tool and concrete child", () => {
    const authority = create();
    const grant = authority.issue({ ...metadata, provider: "claude-code" });
    preTool(authority, grant, { agent_id: "child" });
    expect(registry.resolve(grant.scope, claudeCall())).toMatchObject({ sessionId: "root", agentId: "child" });
    expect(() => registry.resolve(grant.scope, claudeCall("call", "ctx_index"))).toThrow();
  });

  test("conflicting native registration poisons the identity instead of choosing latest", () => {
    const authority = create();
    const grant = authority.issue({ ...metadata, provider: "claude-code" });
    preTool(authority, grant);
    expect(() => preTool(authority, grant, { session_id: "other" })).toThrow();
    expect(() => registry.resolve(grant.scope, claudeCall())).toThrow();
    expect(() => preTool(authority, grant)).toThrow();
  });

  test("conflicting Codex child lineage poisons that concrete thread", () => {
    const authority = create();
    const grant = authority.issue(metadata);
    start(authority, grant);
    start(authority, grant, "second-root");
    const child = { hook_event_name: "SubagentStart", session_id: "root", agent_id: "child", cwd: metadata.workspace };
    authority.registerHook(request(grant.hookCapability), child);
    expect(() => authority.registerHook(request(grant.hookCapability), { ...child, session_id: "second-root" })).toThrow();
    expect(() => registry.resolve(grant.scope, call("child"))).toThrow();
  });

  test.each([null, [], {}, { hook_event_name: "SessionStart", session_id: "root" },
    { hook_event_name: "SessionStart", session_id: "root", cwd: 42 }])("rejects malformed native hook payload %#", (payload) => {
    const authority = create();
    const grant = authority.issue(metadata);
    expect(() => authority.registerHook(request(grant.hookCapability), payload)).toThrow();
    expect(() => registry.resolve(grant.scope, call())).toThrow();
  });

  test("unknown hook capability cannot register a known native id", () => {
    const authority = create();
    const grant = authority.issue(metadata);
    expect(() => authority.registerHook(request("synthetic-unknown"), {
      hook_event_name: "SessionStart", session_id: "root", cwd: metadata.workspace,
    })).toThrow();
    expect(() => registry.resolve(grant.scope, call())).toThrow();
  });

  test("revocation invalidates both credentials and registered identities", async () => {
    const authority = create();
    const grant = authority.issue(metadata);
    start(authority, grant);
    authority.revoke(grant.scope);
    expect(await authority.isActive(grant.scope)).toBe(false);
    await expect(Promise.resolve().then(() => authority.authenticate(request(grant.mcpCapability)))).rejects.toThrow();
    expect(() => start(authority, grant)).toThrow();
    expect(() => registry.resolve(grant.scope, call())).toThrow();
  });

  test("TTL expiry cannot be renewed through duplicate native registration", async () => {
    const authority = create();
    const grant = authority.issue(metadata);
    start(authority, grant);
    clock = TTL - 1;
    start(authority, grant);
    clock = TTL;
    expect(await authority.isActive(grant.scope)).toBe(false);
    expect(() => start(authority, grant)).toThrow();
    expect(() => registry.resolve(grant.scope, call())).toThrow();
  });

  test("credential revocation stays effective when registry tombstone capacity is exhausted", async () => {
    registry = new SharedIdentityRegistry({ now: () => new Date(clock), ttlMs: TTL, maxEntries: 1 });
    const authority = create();
    const active = authority.issue(metadata);
    start(authority, active);
    const revoked = authority.issue(metadata);
    try { authority.revoke(revoked.scope); } catch { /* Auth owner must invalidate even if registry rejects its tombstone. */ }
    expect(await authority.isActive(revoked.scope)).toBe(false);
    await expect(Promise.resolve().then(() => authority.authenticate(request(revoked.mcpCapability)))).rejects.toThrow();
    expect(() => start(authority, revoked)).toThrow();
    expect(await authority.isActive(active.scope)).toBe(true);
  });

  test("launch capacity fails closed without evicting the active launch", async () => {
    const authority = create(1);
    const first = authority.issue(metadata);
    start(authority, first);
    expect(() => authority.issue(metadata)).toThrow();
    expect(await authority.isActive(first.scope)).toBe(true);
    expect(registry.resolve(first.scope, call()).sessionId).toBe("root");
  });

  test("restart rejects old credentials and restores real content only after fresh native registration", async () => {
    const { createSharedRuntime } = await import("../../src/shared/runtime.js");
    let authority: SharedLaunchAuthority;
    const runtime = await createSharedRuntime({ identityRegistry: registry, maxProjects: 4, maxSessions: 8,
      now: () => 1_800_000_000_000, resolveUserHome: (scope) => authority.metadata(scope).userHome });
    runtimes.push(runtime);
    authority = create(8, runtime.listTools().map((tool) => tool.name));
    const old = authority.issue(metadata);
    start(authority, old);
    expect(output(await runtime.call(old.scope, { ...call("root", "root", "ctx_index"),
      arguments: { content: "# Orchard\n\nOrchard authorityresumeapples survive service restart.", source: "research" } }))).toContain("Indexed");
    await runtime.close();
    authority.close();
    registry = newRegistry();
    const restored = await createSharedRuntime({ identityRegistry: registry, maxProjects: 4, maxSessions: 8,
      now: () => 1_800_000_000_000, resolveUserHome: (scope) => authority.metadata(scope).userHome });
    runtimes.push(restored);
    authority = create(8, restored.listTools().map((tool) => tool.name));
    await expect(Promise.resolve().then(() => authority.authenticate(request(old.mcpCapability)))).rejects.toThrow();
    expect(() => start(authority, old)).toThrow();
    const resumed = authority.issue(metadata);
    expect(resumed.scope.launchId !== old.scope.launchId).toBe(true);
    const search = { ...call(), arguments: { queries: ["orchard"] } };
    await expect(restored.call(resumed.scope, search)).rejects.toThrow();
    start(authority, resumed);
    expect(output(await restored.call(resumed.scope, search))).toContain("authorityresumeapples");
    const stranger = authority.issue(metadata);
    start(authority, stranger, "different-conversation");
    expect(output(await restored.call(stranger.scope, { ...call("different-conversation", "different-conversation"),
      arguments: { queries: ["orchard"] } }))).not.toContain("authorityresumeapples");
    const worktree = authority.issue({ ...metadata, workspace: join(root, "worktree-b") });
    start(authority, worktree, "root", join(root, "worktree-b"));
    expect(output(await restored.call(worktree.scope, search))).not.toContain("authorityresumeapples");
  });

  describe("explicit launch renewal", () => {
    test.each(["codex", "claude-code"] as const)("preserves %s capabilities, metadata and existing bindings past the old TTL", async (provider) => {
      const authority = create(1);
      const grant = authority.issue({ ...metadata, provider });
      const snapshot = authority.metadata(grant.scope);
      if (provider === "codex") start(authority, grant);
      else preTool(authority, grant);
      const nativeCall = provider === "codex" ? call() : claudeCall();
      const identity = registry.resolve(grant.scope, nativeCall);
      clock = TTL / 2;
      expect(authority.renew).toBeTypeOf("function");
      authority.renew(grant.scope);
      clock = TTL;
      // Reusing the original credentials proves renewal did not issue replacements.
      expect(await authority.authenticate(request(grant.mcpCapability))).toBe(grant.scope);
      expect(authority.authenticateHook(request(grant.hookCapability))).toBe(grant.scope);
      expect(authority.metadata(grant.scope)).toBe(snapshot);
      expect(registry.resolve(grant.scope, nativeCall)).toEqual(identity);
      expect(() => authority.issue({ ...metadata, provider })).toThrow(/capacity/i);
      if (provider === "codex") {
        authority.registerHook(request(grant.hookCapability), {
          hook_event_name: "SubagentStart", session_id: "root", agent_id: "child", cwd: metadata.workspace,
        });
      } else {
        preTool(authority, grant, { tool_use_id: "child-call", agent_id: "child" });
      }
      const childCall = provider === "codex" ? call("child") : claudeCall("child-call");
      clock = TTL * 1.5 - 1;
      expect(registry.resolve(grant.scope, nativeCall)).toEqual(identity);
      expect(registry.resolve(grant.scope, childCall)).toMatchObject({ sessionId: "root" });
      clock = TTL * 1.5;
      expect(authority.isActive(grant.scope)).toBe(false);
      expect(() => registry.resolve(grant.scope, nativeCall)).toThrow();
      expect(() => registry.resolve(grant.scope, childCall)).toThrow();
    });

    test.each(["expired", "revoked", "closed"])("cannot revive a %s launch", async (kind) => {
      const authority = create();
      const grant = authority.issue(metadata);
      start(authority, grant);
      expect(authority.renew).toBeTypeOf("function");
      if (kind === "expired") clock = TTL;
      else if (kind === "revoked") authority.revoke(grant.scope);
      else authority.close();
      expect(() => authority.renew(grant.scope)).toThrow(/Invalid or inactive launch authority input/);
      expect(authority.isActive(grant.scope)).toBe(false);
      await expect(Promise.resolve().then(() => authority.authenticate(request(grant.mcpCapability)))).rejects.toThrow();
      expect(() => authority.authenticateHook(request(grant.hookCapability))).toThrow();
      expect(() => registry.resolve(grant.scope, call())).toThrow();
    });

    test("refuses expiry between authority and registry clock reads without partial renewal", () => {
      let registryClock = 0;
      registry = new SharedIdentityRegistry({ now: () => new Date(registryClock), ttlMs: TTL, maxEntries: 8 });
      const authority = create();
      const grant = authority.issue(metadata);
      const snapshot = authority.metadata(grant.scope);
      start(authority, grant);
      clock = registryClock = 200;
      start(authority, grant, "later");
      clock = TTL - 1;
      registryClock = TTL;
      expect(authority.renew).toBeTypeOf("function");
      expect(() => authority.renew(grant.scope)).toThrow();
      expect(authority.metadata(grant.scope)).toBe(snapshot);
      expect(() => registry.resolve(grant.scope, call())).toThrow(/expired/i);
      expect(registry.resolve(grant.scope, call("later", "later")).sessionId).toBe("later");
      registryClock = TTL + 200;
      expect(() => registry.resolve(grant.scope, call("later", "later"))).toThrow(/expired/i);
      clock = TTL;
      expect(authority.isActive(grant.scope)).toBe(false);
      expect(() => authority.authenticateHook(request(grant.hookCapability))).toThrow();
    });

    test.each(["provider", "home", "launchId"] as const)("a forged %s cannot renew another launch", (field) => {
      const authority = create();
      const grant = authority.issue(metadata);
      start(authority, grant);
      const forged = { ...grant.scope,
        ...(field === "provider" ? { provider: "claude-code" as const } :
          field === "home" ? { home: metadata.userHome } : { launchId: "unknown-launch" }) };
      clock = TTL / 2;
      expect(authority.renew).toBeTypeOf("function");
      expect(() => authority.renew(forged)).toThrow(/Invalid or inactive launch authority input/);
      expect(authority.isActive(grant.scope)).toBe(true);
      clock = TTL;
      expect(authority.isActive(grant.scope)).toBe(false);
      expect(() => registry.resolve(grant.scope, call())).toThrow();
    });
  });
});
