import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SharedIdentityRegistry, type AuthenticatedScope, type NativeToolCall, type ResolvedIdentity } from "../../src/shared/identity.js";
import { loadDatabase } from "../../src/db-base.js";
import type { SharedRuntimeRequestContext, SharedRuntimeTool } from "../../src/shared/runtime.js";

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

interface SharedRuntime {
  listTools(): readonly SharedRuntimeTool[];
  call(scope: AuthenticatedScope, request: NativeToolCall, context?: SharedRuntimeRequestContext): Promise<ToolResult>;
  close(): Promise<void>;
}

function files(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    // Never follow symlinks: a failed cache-healing assertion may leave one.
    return entry.isDirectory() ? files(path) : [path];
  }).sort();
}

function text(result: ToolResult): string {
  expect(result.isError).not.toBe(true);
  return result.content.map((part) => part.text ?? "").join("\n");
}

function absoluteReadRule(path: string): string {
  let normalized = path.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(normalized)) normalized = `/${normalized[0].toLowerCase()}${normalized.slice(2)}`;
  return `Read(/${normalized})`;
}

describe("shared runtime invokes the existing context-mode tools", () => {
  let root: string;
  let fallback: string;
  let missingPlugin: string;
  let registry: SharedIdentityRegistry;
  let runtime: SharedRuntime | undefined;
  let claude: ResolvedIdentity;
  let codex: ResolvedIdentity;
  let callNumber: number;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "ctx-shared-runtime-")));
    fallback = join(root, "unregistered-fallback");
    const fallbackClaude = join(fallback, ".claude");
    missingPlugin = join(fallbackClaude, "plugins", "cache", "context-mode", "missing");
    mkdirSync(dirname(missingPlugin), { recursive: true });
    writeFileSync(join(fallbackClaude, "plugins", "installed_plugins.json"), JSON.stringify({
      plugins: { "context-mode@context-mode": [{ installPath: missingPlugin }] },
    }));
    for (const [name, value] of Object.entries({
      HOME: fallback, USERPROFILE: fallback,
      CLAUDE_CONFIG_DIR: fallbackClaude, CODEX_HOME: join(fallback, ".codex"),
      CLAUDE_PROJECT_DIR: join(fallback, "workspace"), CONTEXT_MODE_PROJECT_DIR: join(fallback, "workspace"),
      CONTEXT_MODE_DIR: join(fallback, "storage"), CLAUDE_SESSION_ID: "unregistered-fallback-session",
      TMPDIR: join(fallback, "tmp"), TEMP: join(fallback, "tmp"), TMP: join(fallback, "tmp"),
    })) vi.stubEnv(name, value);
    mkdirSync(join(fallback, "tmp"), { recursive: true });
    // Containment only: expected storage always comes from registered homes.
    // This flag is deliberately absent so the factory must select safe import
    // behavior itself, rather than receiving a test-only embedded-mode escape.
    vi.stubEnv("CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS", undefined);
    registry = new SharedIdentityRegistry({ now: () => new Date(0), ttlMs: 60_000, maxEntries: 100 });
    callNumber = 0;
    claude = identity("claude-code", "claude-home", "worktree-a");
    codex = identity("codex", "codex-home", "worktree-b");
    writeFileSync(join(claude.workspace, "notes.md"), "# Orchard\n\nOrchard research contains alphaapples.");
    writeFileSync(join(codex.workspace, "notes.md"), "# Orchard\n\nOrchard research contains betapears.");
  });

  afterEach(async () => {
    try {
      await runtime?.close();
    } finally {
      runtime = undefined;
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  function identity(provider: ResolvedIdentity["provider"], home: string, workspace: string): ResolvedIdentity {
    const result: ResolvedIdentity = {
      provider, home: join(root, home), workspace: join(root, workspace),
      launchId: `launch-${provider}`, sessionId: `session-${provider}`,
      ...(provider === "codex" ? { threadId: "thread-root" } : {}),
    };
    mkdirSync(result.home, { recursive: true });
    mkdirSync(result.workspace, { recursive: true });
    return result;
  }

  async function create(bounds: {
    maxProjects?: number;
    maxSessions?: number;
    resolveUserHome?: (scope: Readonly<AuthenticatedScope>) => string | undefined;
  } = {}): Promise<SharedRuntime> {
    // No production server import before fixture containment is established.
    const { createSharedRuntime } = await import("../../src/shared/runtime.js");
    runtime = await createSharedRuntime({ identityRegistry: registry, maxProjects: 4, maxSessions: 8,
      now: () => 1_800_000_000_000, ...bounds });
    return runtime;
  }

  function invoke(owner: ResolvedIdentity, name: string, args: Record<string, unknown> = {}, context?: SharedRuntimeRequestContext) {
    const scope = { provider: owner.provider, home: owner.home, launchId: owner.launchId };
    if (owner.provider === "codex") {
      registry.register(scope, {
        kind: "codex-thread", threadId: owner.threadId!, sessionId: owner.sessionId, workspace: owner.workspace,
      });
      return runtime!.call(scope, {
        name, arguments: args, _meta: { threadId: owner.threadId, sessionId: owner.sessionId },
      }, context);
    }
    const toolUseId = `call-${++callNumber}`;
    registry.register(scope, {
      kind: "claude-tool-call", toolUseId, tool: name, sessionId: owner.sessionId,
      workspace: owner.workspace, ...(owner.agentId ? { agentId: owner.agentId } : {}),
    });
    return runtime!.call(scope, { name, arguments: args, _meta: { "claudecode/toolUseId": toolUseId } }, context);
  }

  async function drain(): Promise<void> {
    await runtime!.close();
    runtime = undefined;
  }

  function stats(home: string): Array<{ by_tool: Record<string, { calls: number }> }> {
    return files(join(home, "context-mode")).filter((path) => /[/\\]stats-[^/\\]+\.json$/.test(path))
      .map((path) => JSON.parse(readFileSync(path, "utf8")));
  }

  test("factory and first tool call install no stdio/parent lifecycle and repair no plugin cache", async () => {
    const processEvents = ["SIGINT", "SIGTERM", "exit", "uncaughtException", "unhandledRejection"] as const;
    const stdinEvents = ["data", "end", "close"] as const;
    const processListeners = processEvents.map((event) => process.listeners(event));
    const stdinListeners = stdinEvents.map((event) => process.stdin.listeners(event));
    const before = files(root);

    await create();

    expect(processEvents.map((event) => process.listeners(event))).toEqual(processListeners);
    expect(stdinEvents.map((event) => process.stdin.listeners(event))).toEqual(stdinListeners);
    expect(files(root)).toEqual(before);
    expect(existsSync(missingPlugin)).toBe(false);

    // A lazy server import on the first call must preserve the same boundary.
    // Registered-home storage is allowed once a real tool is invoked.
    const fallbackBefore = files(fallback);
    expect(text(await invoke(claude, "ctx_stats"))).toMatch(/context.mode/i);
    expect(processEvents.map((event) => process.listeners(event))).toEqual(processListeners);
    expect(stdinEvents.map((event) => process.stdin.listeners(event))).toEqual(stdinListeners);
    expect(files(fallback)).toEqual(fallbackBefore);
    expect(existsSync(missingPlugin)).toBe(false);
  });

  test("interleaved real index/search/stats calls use each registered home and worktree", async () => {
    await create();
    const fallbackBefore = files(fallback);
    // ctx_index(path) crosses an await before choosing the ContentStore. Both
    // calls use the same relative filename, heading and source label.
    const indexed = await Promise.all([
      invoke(claude, "ctx_index", { path: "notes.md", source: "notes" }),
      invoke(codex, "ctx_index", { path: "notes.md", source: "notes" }),
    ]);
    for (const result of indexed) expect(text(result)).toMatch(/Indexed/);
    text(await invoke(claude, "ctx_index", { content: "Additional alpha research.", source: "extra" }));
    const [a, b] = await Promise.all([
      invoke(claude, "ctx_search", { queries: ["orchard"] }),
      invoke(codex, "ctx_search", { queries: ["orchard"] }),
    ]);
    expect(text(a)).toContain("alphaapples");
    expect(text(a)).not.toContain("betapears");
    expect(text(b)).toContain("betapears");
    expect(text(b)).not.toContain("alphaapples");
    for (const result of await Promise.all([invoke(claude, "ctx_stats"), invoke(codex, "ctx_stats")])) {
      expect(text(result)).toMatch(/context.mode/i);
    }
    await drain();

    expect(stats(claude.home)).toHaveLength(1);
    expect(stats(codex.home)).toHaveLength(1);
    expect(stats(claude.home)[0].by_tool.ctx_index.calls).toBe(2);
    expect(stats(codex.home)[0].by_tool.ctx_index.calls).toBe(1);
    for (const owner of [claude, codex]) {
      expect(stats(owner.home)[0].by_tool.ctx_search.calls).toBe(1);
      expect(stats(owner.home)[0].by_tool.ctx_stats.calls).toBe(1);
      expect(files(join(owner.home, "context-mode", "content")).filter((path) => path.endsWith(".db")))
        .toHaveLength(1);
    }
    expect(files(fallback)).toEqual(fallbackBefore);
    expect(existsSync(missingPlugin)).toBe(false);
  });

  test("concrete child threads share a project store without sharing content or statistics", async () => {
    await create();
    const a = { ...codex, threadId: "child-a" };
    const b = { ...codex, threadId: "child-b" };
    text(await invoke(a, "ctx_index", { content: "Additional alpha research.", source: "extra" }));
    const indexed = await Promise.all([
      invoke(a, "ctx_index", { path: "notes.md", source: "notes" }),
      invoke(b, "ctx_index", { content: "# Orchard\n\nOrchard research contains childbananas.", source: "notes" }),
    ]);
    indexed.forEach(text);
    const [foundA, foundB] = await Promise.all([
      invoke(a, "ctx_search", { queries: ["orchard"] }),
      invoke(b, "ctx_search", { queries: ["orchard"] }),
    ]);
    expect(text(foundA)).toContain("betapears");
    expect(text(foundA)).not.toContain("childbananas");
    expect(text(foundB)).toContain("childbananas");
    expect(text(foundB)).not.toContain("betapears");
    for (const result of await Promise.all([invoke(a, "ctx_stats"), invoke(b, "ctx_stats")])) text(result);
    await drain();

    expect(stats(codex.home)).toHaveLength(2);
    expect(stats(codex.home).map((entry) => entry.by_tool.ctx_index.calls).sort()).toEqual([1, 2]);
    const databases = files(join(codex.home, "context-mode", "content")).filter((path) => path.endsWith(".db"));
    expect(databases).toHaveLength(1);
    const Database = loadDatabase();
    const database = new Database(databases[0], { readonly: true });
    try {
      const owners = database.prepare("SELECT DISTINCT session_id FROM chunks").all() as Array<{ session_id: string }>;
      expect(owners).toHaveLength(2);
      expect(owners.every((entry) => entry.session_id.length > 0)).toBe(true);
    } finally {
      database.close();
    }
  });

  test("unknown identity and invalid tool arguments fail before file or database access", async () => {
    await create();
    const before = files(root);
    const scope = { provider: codex.provider, home: codex.home, launchId: codex.launchId };
    await expect(runtime!.call(scope, {
      name: "ctx_index", arguments: { path: join(codex.workspace, "notes.md") },
      _meta: { threadId: "unregistered", sessionId: codex.sessionId },
    })).rejects.toThrow(/identity|scope|registered/i);
    await expect(runtime!.call(scope, { name: "ctx_index", arguments: { path: "notes.md" } }))
      .rejects.toThrow(/identity|scope|metadata|object/i);
    await expect(invoke(codex, "ctx_index", { path: 123 })).rejects.toThrow(/invalid|validation|string/i);
    expect(files(root)).toEqual(before);
  });

  test("shared administrative and execution tools reject without mutating stored content", async () => {
    await create();
    text(await invoke(claude, "ctx_index", { content: "Orchard research stays available.", source: "notes" }));
    const fallbackBefore = files(fallback);
    for (const [name, args] of [
      ["ctx_upgrade", {}], ["ctx_purge", { confirm: true, scope: "project" }], ["ctx_insight", {}],
      ["ctx_execute", { language: "javascript", code: "0" }],
      ["ctx_execute_file", { path: "notes.md", language: "javascript", code: "0" }],
      ["ctx_batch_execute", { commands: [{ label: "disabled", command: "true" }], queries: [] }],
    ] as Array<[string, Record<string, unknown>]>) {
      await expect(invoke(claude, name, args)).rejects.toThrow(/shared|unsupported|disabled|not permitted/i);
    }
    expect(text(await invoke(claude, "ctx_search", { queries: ["orchard"] }))).toContain("stays available");
    await drain();
    expect(files(fallback)).toEqual(fallbackBefore);
    expect(existsSync(missingPlugin)).toBe(false);
  });

  test("project and session capacity reject new owners without opening their storage", async () => {
    await create({ maxProjects: 1, maxSessions: 2 });
    text(await invoke(claude, "ctx_index", { content: "Orchard stays in the admitted project.", source: "notes" }));
    const before = files(codex.home);
    await expect(invoke(codex, "ctx_index", { content: "Must not be stored.", source: "notes" }))
      .rejects.toThrow(/project capacity/i);
    expect(files(codex.home)).toEqual(before);

    text(await invoke({ ...claude, agentId: "child-a" }, "ctx_stats"));
    await expect(invoke({ ...claude, agentId: "child-b" }, "ctx_stats"))
      .rejects.toThrow(/session capacity/i);
    expect(text(await invoke(claude, "ctx_search", { queries: ["orchard"] }))).toContain("admitted project");
    await drain();
    expect(stats(claude.home)).toHaveLength(2);
  });

  test("launch revocation during asynchronous validation rejects before opening storage", async () => {
    await create();
    const before = files(root);
    const pending = invoke(codex, "ctx_index", { content: "Must not be stored.", source: "revoked" });
    registry.revokeLaunch({ provider: codex.provider, home: codex.home, launchId: codex.launchId });
    await expect(pending).rejects.toThrow(/revoked/i);
    expect(files(root)).toEqual(before);
  });

  test("restart restores the same owner's content and persistent call counters", async () => {
    await create();
    text(await invoke(codex, "ctx_index", { content: "Orchard survives a service restart.", source: "notes" }));
    const previous = runtime!;
    await drain();
    await expect(previous.call({ provider: codex.provider, home: codex.home, launchId: codex.launchId }, {
      name: "ctx_stats", arguments: {}, _meta: { threadId: codex.threadId, sessionId: codex.sessionId },
    })).rejects.toThrow(/closed/i);

    await create();
    expect(text(await invoke(codex, "ctx_search", { queries: ["orchard"] }))).toContain("survives a service restart");
    text(await invoke(codex, "ctx_stats"));
    await drain();
    expect(stats(codex.home)).toHaveLength(1);
    expect(stats(codex.home)[0].by_tool.ctx_index.calls).toBe(1);
    expect(stats(codex.home)[0].by_tool.ctx_search.calls).toBe(1);
  });

  test("a policy change hides cached file content without changing another provider's policy", async () => {
    await create();
    text(await invoke(claude, "ctx_index", { path: "notes.md", source: "notes" }));
    text(await invoke(codex, "ctx_index", { path: "notes.md", source: "notes" }));
    writeFileSync(join(claude.home, "settings.json"), JSON.stringify({
      permissions: { deny: [absoluteReadRule(join(claude.workspace, "notes.md"))] },
    }));
    expect(text(await invoke(claude, "ctx_search", { queries: ["orchard"] }))).not.toContain("alphaapples");
    expect(text(await invoke(codex, "ctx_search", { queries: ["orchard"] }))).toContain("betapears");
    const denied = await invoke(claude, "ctx_index", { path: "notes.md", source: "denied" });
    expect(denied.isError).toBe(true);
    expect(denied.content.map((part) => part.text).join("\n")).toMatch(/blocked/i);
  });

  test.each([
    ["global", "index"], ["global", "search"],
    ["project", "index"], ["project", "search"],
  ] as const)("%s JSONC deny policy blocks %s access", async (location, operation) => {
    await create();
    // Index first so the search case exercises cached content after a policy
    // change, without relying on a refresh or modified file timestamp.
    text(await invoke(claude, "ctx_index", { path: "notes.md", source: "notes" }));
    const settingsPath = location === "global"
      ? join(claude.home, "settings.json")
      : join(claude.workspace, ".claude", "settings.json");
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, "// Workspace read restriction\n" + JSON.stringify({
      permissions: { deny: [absoluteReadRule(join(claude.workspace, "notes.md"))] },
    }));

    if (operation === "index") {
      const denied = await invoke(claude, "ctx_index", { path: "notes.md", source: "denied" });
      expect(denied.isError).toBe(true);
      expect(denied.content.map((part) => part.text).join("\n")).toMatch(/blocked/i);
    } else {
      expect(text(await invoke(claude, "ctx_search", { queries: ["orchard"] }))).not.toContain("alphaapples");
    }
  });

  test.each([
    { permissions: "invalid" },
    { permissions: { deny: "Read(notes.md)" } },
    { permissions: { deny: [42] } },
  ])("malformed permission policy fails closed: %j", async (policy) => {
    await create();
    text(await invoke(claude, "ctx_index", { path: "notes.md", source: "notes" }));
    writeFileSync(join(claude.home, "settings.json"), JSON.stringify(policy));
    const denied = await invoke(claude, "ctx_index", { path: "notes.md", source: "denied" });
    expect(denied.isError).toBe(true);
    expect(text(await invoke(claude, "ctx_search", { queries: ["orchard"] }))).not.toContain("alphaapples");
  });

  test.each([
    ["Read", "index"], ["Read", "search"],
    ["R*", "index"], ["R*", "search"],
    ["*", "index"], ["*", "search"],
    ["Read(*)", "index"], ["Read(*)", "search"],
    ["Read(**)", "index"], ["Read(**)", "search"],
  ] as const)("blanket %s deny blocks %s access", async (rule, operation) => {
    await create();
    text(await invoke(claude, "ctx_index", { path: "notes.md", source: "notes" }));
    writeFileSync(join(claude.home, "settings.json"), JSON.stringify({ permissions: { deny: [rule] } }));
    if (operation === "index") {
      const denied = await invoke(claude, "ctx_index", { path: "notes.md", source: "denied" });
      expect(denied.isError).toBe(true);
      expect(denied.content.map((part) => part.text).join("\n")).toMatch(/blocked/i);
    } else {
      expect(text(await invoke(claude, "ctx_search", { queries: ["orchard"] }))).not.toContain("alphaapples");
    }
  });

  test.each([
    ["global", "absolute", "nested/notes.md"],
    ["project", "/nested/notes.md", "nested/notes.md"],
    ["global", "/project/nested/notes.md", "nested/notes.md"],
    ["global", "notes.md", "nested/notes.md"],
    ["project", "secrets/**", "vendor/secrets/notes.md"],
  ] as const)("%s anchored Read(%s) blocks index and cached search", async (location, specifier, relativeFile) => {
    const owner = { ...claude, workspace: join(claude.home, "project") };
    const target = join(owner.workspace, relativeFile);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "Orchard research contains anchoredprivatecontent.");
    await create();
    text(await invoke(owner, "ctx_index", { path: relativeFile, source: "notes" }));
    const settingsPath = location === "global"
      ? join(owner.home, "settings.json") : join(owner.workspace, ".claude", "settings.json");
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ permissions: {
      deny: [specifier === "absolute" ? absoluteReadRule(target) : `Read(${specifier})`],
    } }));

    const denied = await invoke(owner, "ctx_index", { path: relativeFile, source: "denied" });
    expect(denied.isError).toBe(true);
    expect(text(await invoke(owner, "ctx_search", { queries: ["orchard"] }))).not.toContain("anchoredprivatecontent");
  });

  test("a global slash rule anchors at its settings source, not the workspace", async () => {
    await create();
    writeFileSync(join(claude.home, "settings.json"), JSON.stringify({ permissions: { deny: ["Read(/notes.md)"] } }));
    text(await invoke(claude, "ctx_index", { path: "notes.md", source: "notes" }));
    expect(text(await invoke(claude, "ctx_search", { queries: ["orchard"] }))).toContain("alphaapples");
  });

  test("tilde rules use the trusted user home even when the provider config root differs", async () => {
    const userHome = join(root, "explicit-user-home");
    const owner = { ...claude, workspace: join(userHome, "project") };
    mkdirSync(owner.workspace, { recursive: true });
    writeFileSync(join(owner.workspace, "notes.md"), "Orchard research contains tildeprivatecontent.");
    await create({ resolveUserHome: () => userHome });
    text(await invoke(owner, "ctx_index", { path: "notes.md", source: "notes" }));
    writeFileSync(join(owner.home, "settings.json"), JSON.stringify({ permissions: { deny: ["Read(~/project/notes.md)"] } }));
    const denied = await invoke(owner, "ctx_index", { path: "notes.md", source: "denied" });
    expect(denied.isError).toBe(true);
    expect(text(await invoke(owner, "ctx_search", { queries: ["orchard"] }))).not.toContain("tildeprivatecontent");
  });

  test("tilde rules without a trusted user home fail closed", async () => {
    await create();
    writeFileSync(join(claude.home, "settings.json"), JSON.stringify({ permissions: { deny: ["Read(~/private/**)"] } }));
    expect((await invoke(claude, "ctx_index", { path: "notes.md", source: "notes" })).isError).toBe(true);
  });

  test("a noncanonical user-home resolver result fails before opening storage", async () => {
    await create({ resolveUserHome: () => "relative-home" });
    const before = files(root);
    await expect(invoke(claude, "ctx_index", { path: "notes.md", source: "notes" }))
      .rejects.toThrow(/home|canonical|absolute/i);
    expect(files(root)).toEqual(before);
  });

  test.each(["Read", "Read(./notes.md)"])("applicable ask rule %s denies reads without an approval bridge", async (rule) => {
    await create();
    text(await invoke(claude, "ctx_index", { path: "notes.md", source: "notes" }));
    writeFileSync(join(claude.home, "settings.json"), JSON.stringify({ permissions: { ask: [rule] } }));
    expect((await invoke(claude, "ctx_index", { path: "notes.md", source: "denied" })).isError).toBe(true);
    expect(text(await invoke(claude, "ctx_search", { queries: ["orchard"] }))).not.toContain("alphaapples");
  });

  test("a nonmatching ask rule does not block an unrelated read", async () => {
    await create();
    writeFileSync(join(claude.home, "settings.json"), JSON.stringify({ permissions: { ask: ["Read(./other.md)"] } }));
    text(await invoke(claude, "ctx_index", { path: "notes.md", source: "notes" }));
    expect(text(await invoke(claude, "ctx_search", { queries: ["orchard"] }))).toContain("alphaapples");
  });

  test.each(["R*(notes.md)", "Read([n]otes.md)"])("applicable rule %s is enforced or fails closed", async (rule) => {
    await create();
    text(await invoke(claude, "ctx_index", { path: "notes.md", source: "notes" }));
    writeFileSync(join(claude.home, "settings.json"), JSON.stringify({ permissions: { deny: [rule] } }));
    expect((await invoke(claude, "ctx_index", { path: "notes.md", source: "denied" })).isError).toBe(true);
    expect(text(await invoke(claude, "ctx_search", { queries: ["orchard"] }))).not.toContain("alphaapples");
  });

  test("an absolute deny through a directory symlink guards reads by the real path", async () => {
    const realDir = join(claude.workspace, "real");
    const aliasDir = join(claude.workspace, "alias");
    mkdirSync(realDir);
    writeFileSync(join(realDir, "notes.md"), "Orchard research contains aliasprivatecontent.");
    symlinkSync(realDir, aliasDir, process.platform === "win32" ? "junction" : "dir");
    await create();
    text(await invoke(claude, "ctx_index", { path: "real/notes.md", source: "notes" }));
    writeFileSync(join(claude.home, "settings.json"), JSON.stringify({ permissions: {
      deny: [absoluteReadRule(join(aliasDir, "notes.md"))],
    } }));
    expect((await invoke(claude, "ctx_index", { path: "real/notes.md", source: "denied" })).isError).toBe(true);
    expect(text(await invoke(claude, "ctx_search", { queries: ["orchard"] }))).not.toContain("aliasprivatecontent");
  });

  test("tool descriptors expose the implemented registry handlers only", async () => {
    await create();
    const before = files(root);
    const descriptors = runtime!.listTools();
    expect(descriptors.map((tool) => tool.name).sort()).toEqual(["ctx_index", "ctx_search", "ctx_stats"]);
    const { REGISTERED_CTX_TOOLS } = await import("../../src/server.js");
    for (const descriptor of descriptors) {
      const registered = REGISTERED_CTX_TOOLS.find((tool) => tool.name === descriptor.name);
      expect(descriptor.config.inputSchema).toBe(registered!.config.inputSchema);
    }
    expect(files(root)).toEqual(before);
    text(await invoke(claude, "ctx_index", { content: "Orchard descriptors invoke real handlers.", source: "notes" }));
    expect(text(await invoke(claude, "ctx_search", { queries: ["orchard"] }))).toContain("real handlers");
    text(await invoke(claude, "ctx_stats"));
    await expect(invoke(claude, "ctx_upgrade")).rejects.toThrow(/supported/i);
  });

  test("a pre-aborted tool request creates no storage or statistics", async () => {
    await create();
    const before = files(root);
    const controller = new AbortController();
    controller.abort();
    await expect(invoke(claude, "ctx_index", { content: "Must not be indexed.", source: "cancelled" }, {
      signal: controller.signal, requestId: "cancelled-index", transportSessionId: "transport-a",
    })).rejects.toThrow(/abort|cancel/i);
    expect(files(root)).toEqual(before);
  });

  test("cancelling a readonly request during validation preserves its owner's counters", async () => {
    await create();
    text(await invoke(claude, "ctx_index", { content: "Orchard remains searchable.", source: "notes" }));
    const controller = new AbortController();
    const pending = invoke(claude, "ctx_search", { queries: ["orchard"] }, {
      signal: controller.signal, requestId: 7, transportSessionId: "transport-a",
    });
    controller.abort();
    await expect(pending).rejects.toThrow(/abort|cancel/i);
    expect(text(await invoke(claude, "ctx_search", { queries: ["orchard"] }))).toContain("remains searchable");
    await drain();
    expect(stats(claude.home)[0].by_tool.ctx_search.calls).toBe(1);
    expect(stats(claude.home)[0].by_tool.ctx_index.calls).toBe(1);
  });
});
