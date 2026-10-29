import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadDatabase } from "../../src/db-base.js";
import { ContentStore } from "../../src/store.js";
import * as authorityModule from "../../src/shared/launch-authority.js";
import type { SharedLaunchGrant, SharedLaunchMetadata } from "../../src/shared/launch-authority.js";
import * as runtimeModule from "../../src/shared/runtime.js";
import { createSharedService, type SharedService, type SharedServiceOptions } from "../../src/shared/service.js";

type Owner = { grant: SharedLaunchGrant; metadata: SharedLaunchMetadata; session: string; agent?: string };
type Reply = { status: number; body: Record<string, unknown>; raw: string };
const NOW = Date.UTC(2030, 0, 2, 3, 4, 5);
const TTL = 60_000;
const TOOL = "mcp__fixture__lookup";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// Real service, registry, runtime, extraction, and SQLite. The two delegating
// factory wrappers expose deterministic upload/settlement barriers only. These
// synthetic native envelopes pin the bridge contract, not native-client support.
describe("memory hooks through the actual shared service", () => {
  let root: string, clock: number;
  let services: SharedService[], owners: Owner[];
  let authenticated: ((request: IncomingMessage) => void) | undefined;
  let authenticationAttempts: number;
  let afterCommit: (() => Promise<void>) | undefined;
  let runtimeClosing: boolean;
  const createAuthority = authorityModule.createSharedLaunchAuthority;
  const createRuntime = runtimeModule.createSharedRuntime;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "shared-memory-hooks-")));
    clock = NOW; services = []; owners = []; authenticated = undefined; authenticationAttempts = 0;
    afterCommit = undefined; runtimeClosing = false;
    const fallback = join(root, "fallback");
    mkdirSync(join(fallback, "tmp"), { recursive: true });
    for (const [name, value] of Object.entries({ HOME: fallback, USERPROFILE: fallback, CODEX_HOME: fallback,
      CLAUDE_CONFIG_DIR: fallback, XDG_CONFIG_HOME: fallback, APPDATA: fallback, CONTEXT_MODE_DIR: join(fallback, "store"),
      CLAUDE_PROJECT_DIR: fallback, CONTEXT_MODE_PROJECT_DIR: fallback, CLAUDE_SESSION_ID: "ambient-unregistered",
      TMPDIR: join(fallback, "tmp"), TMP: join(fallback, "tmp"), TEMP: join(fallback, "tmp"),
    })) vi.stubEnv(name, value);
    vi.stubEnv("CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS", undefined);
    vi.spyOn(authorityModule, "createSharedLaunchAuthority").mockImplementation((options) => {
      const actual = createAuthority(options);
      return { ...actual, authenticateHook(request) {
        authenticationAttempts++;
        const scope = actual.authenticateHook(request);
        authenticated?.(request);
        return scope;
      } };
    });
    vi.spyOn(runtimeModule, "createSharedRuntime").mockImplementation(async (options) => {
      const actual = await createRuntime(options);
      return { ...actual, async ingestMemory(identity, delivery) {
        const result = await actual.ingestMemory(identity, delivery);
        await afterCommit?.();
        return result;
      }, close() { runtimeClosing = true; return actual.close(); } };
    });
  });

  afterEach(async () => {
    try { await Promise.allSettled(services.map((service) => service.close())); }
    finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
  });

  async function create(limits: Partial<SharedServiceOptions> = {}) {
    const service = await createSharedService({ now: () => new Date(clock), ttlMs: TTL,
      maxIdentities: 128, maxLaunches: 16, maxProjects: 8, maxSessions: 16, mcpServerName: "context-mode",
      http: { host: "127.0.0.1", port: 0, allowedOrigins: [], limits: {
        maxTransportSessions: 4, maxPendingInitializations: 2, maxInFlightRequests: 2, maxBodyBytes: 65_536,
      } }, ...limits });
    services.push(service); await service.listen(); return service;
  }

  function owner(service: SharedService, values: { provider?: SharedLaunchMetadata["provider"]; home?: string;
    workspace?: string; session?: string } = {}): Owner {
    const metadata = { provider: values.provider ?? "claude-code", home: join(root, values.home ?? "config"),
      userHome: root, workspace: join(root, values.workspace ?? "workspace") };
    for (const path of [metadata.home, metadata.workspace]) mkdirSync(path, { recursive: true });
    const result = { metadata, grant: service.issue(metadata), session: values.session ?? "root" };
    owners.push(result); return result;
  }
  const url = (service: SharedService) => new URL(`http://127.0.0.1:${service.address().port}/hooks`);
  const native = (who: Owner, event: string, extra: Record<string, unknown> = {}) => ({ hook_event_name: event,
    session_id: who.session, cwd: who.metadata.workspace, ...(who.agent ? { agent_id: who.agent } : {}), ...extra });
  async function post(service: SharedService, who: Owner, payload: unknown, raw?: string, capability = who.grant.hookCapability): Promise<Reply> {
    const response = await fetch(url(service), { method: "POST", headers: {
      authorization: `Bearer ${capability}`, "content-type": "application/json",
    }, body: raw ?? JSON.stringify(payload) });
    const text = await response.text();
    for (const entry of owners) {
      expect(text.includes(entry.grant.hookCapability)).toBe(false);
      expect(text.includes(entry.grant.mcpCapability)).toBe(false);
    }
    return { status: response.status, body: JSON.parse(text) as Record<string, unknown>, raw: text };
  }
  const memory = (service: SharedService, who: Owner, event: string, extra: Record<string, unknown> = {}) =>
    post(service, who, { memory: native(who, event, extra) });
  function success(reply: Reply, status: "registered" | "applied" | "duplicate") {
    expect(reply.status).toBe(202); expect(reply.body).toEqual({ memory: { status } });
  }
  function failure(reply: Reply, status: number, code: string) {
    expect(reply.status).toBe(status); expect(reply.body.code).toBe(code);
    expect(reply.raw).not.toContain("private-native-marker");
  }
  async function recover(service: SharedService, who: Owner): Promise<string> {
    const result = await memory(service, who, who.agent ? "SubagentStart" : "SessionStart");
    expect(result.status).toBe(202);
    expect(result.body).toEqual({ memory: { status: "recovered", recovery: expect.any(String) } });
    return (result.body.memory as { recovery: string }).recovery;
  }
  const prompt = (service: SharedService, who: Owner, id = "prompt-a", marker = "orchardalpha") =>
    memory(service, who, "UserPromptSubmit", { prompt_id: id, prompt: `Implement ${marker} in this workspace.` });
  const preTool = (service: SharedService, who: Owner, id = "tool-a") =>
    memory(service, who, "PreToolUse", { tool_use_id: id, tool_name: TOOL });
  const completedTool = (service: SharedService, who: Owner, extra: Record<string, unknown> = {}) =>
    memory(service, who, "PostToolUse", { tool_use_id: "tool-a", tool_name: TOOL,
      tool_input: { query: "orchardtool" }, tool_response: "orchardtool result", ...extra });

  async function searchMemory(service: SharedService, who: Owner, query = "lookup"): Promise<string> {
    const client = new Client({ name: "shared-memory-hook-test", version: "1" });
    const toolUseId = `search-${who.session}-${who.agent ?? "root"}-${query}`;
    const registration = who.metadata.provider === "codex" ? native(who, "SessionStart")
      : native(who, "PreToolUse", { tool_use_id: toolUseId, tool_name: "mcp__context-mode__ctx_search" });
    expect((await post(service, who, registration)).status).toBe(202);
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", url(service)), {
        requestInit: { headers: { authorization: `Bearer ${who.grant.mcpCapability}` } },
      }));
      const result = await client.callTool({ name: "ctx_search", arguments: { queries: [query], source: "session-events", limit: 20 },
        _meta: who.metadata.provider === "codex" ? { threadId: who.session, sessionId: who.session } : { "claudecode/toolUseId": toolUseId } });
      expect(result.isError).not.toBe(true);
      return JSON.stringify(result.content);
    } finally { await client.close(); }
  }

  function rows(who: Owner, table: "session_events" | "shared_memory_deliveries" | "shared_memory_extraction" | "session_resume" | "chunks") {
    const directory = join(who.metadata.home, "context-mode", table === "chunks" ? "content" : "sessions");
    if (!existsSync(directory)) return [];
    const Database = loadDatabase();
    return readdirSync(directory).filter((name) => name.endsWith(".db")).flatMap((name) => {
      const db = new Database(join(directory, name), { readonly: true });
      try { return db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]; }
      finally { db.close(); }
    });
  }

  async function assertPrivateValuesAbsent(service: SharedService, who: Owner, publicMarker: string, privateValues: readonly string[]) {
    const snapshot = await recover(service, who), search = await searchMemory(service, who, publicMarker);
    const persisted = JSON.stringify([rows(who, "session_events"), rows(who, "shared_memory_extraction"),
      rows(who, "session_resume"), rows(who, "chunks"), snapshot, search]);
    expect(persisted).toContain(publicMarker);
    for (const value of privateValues) expect(persisted.includes(value)).toBe(false);
    expect(rows(who, "shared_memory_deliveries")).toHaveLength(1);
  }

  async function commandHook(service: SharedService, who: Owner, event: string, extra: Record<string, unknown> = {}, expectedExit = 0) {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../../hooks/shared-service.mjs", import.meta.url))], {
      env: { ...process.env, CONTEXT_MODE_SHARED_HOOK_URL: url(service).href,
        CONTEXT_MODE_SHARED_HOOK_CAP: who.grant.hookCapability, CONTEXT_MODE_SHARED_PROVIDER: who.metadata.provider,
        CONTEXT_MODE_SHARED_MCP_SERVER: "context-mode" }, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    child.stdin.end(JSON.stringify(native(who, event, extra)));
    expect(await closed).toBe(expectedExit);
    if (expectedExit !== 0) {
      expect(stdout).toBe("");
      expect(stderr).toBe("context-mode shared hook failed\n");
      return {};
    }
    expect(stderr).toBe("");
    expect(stdout).not.toContain(who.grant.hookCapability);
    return JSON.parse(stdout) as { hookSpecificOutput?: { hookEventName: string; additionalContext: string } };
  }

  test.each(["Read", "Write", "Bash"])("large %s completion retains useful memory, redacts before shortening and detects changed tails", async (tool_name) => {
    const service = await create(), who = owner(service);
    await commandHook(service, who, "SessionStart");
    const tool_use_id = "large-completion";
    await commandHook(service, who, "PreToolUse", { tool_name, tool_use_id });
    const privateValue = "synthetic-private-value";
    const content = `orchardlarge api_key="${privateValue}${"x".repeat(80_000)}" ` + "ordinary ".repeat(10_000);
    const extra = { tool_name, tool_use_id,
      tool_input: tool_name === "Bash" ? { command: "cat orchardlarge.txt" } :
        { file_path: join(who.metadata.workspace, "orchardlarge.ts"), ...(tool_name === "Write" ? { content } : {}) },
      tool_response: tool_name === "Bash" ? `Error: ${content} tail-original` : { content, result: "tail-original" } };
    await commandHook(service, who, "PostToolUse", extra);
    expect(rows(who, "shared_memory_deliveries")).toHaveLength(1);
    expect(JSON.stringify(rows(who, "session_events"))).toContain("orchardlarge");
    expect(JSON.stringify(rows(who, "session_events"))).not.toContain(privateValue);
    await commandHook(service, who, "PostToolUse", extra);
    expect(rows(who, "shared_memory_deliveries")).toHaveLength(1);
    const changed = { ...extra, tool_response: typeof extra.tool_response === "string" ?
      extra.tool_response.replace("tail-original", "tail-changed") : { ...extra.tool_response, result: "tail-changed" } };
    await commandHook(service, who, "PostToolUse", changed, 1);
    expect(rows(who, "shared_memory_deliveries")).toHaveLength(1);
    const snapshot = await commandHook(service, who, "SessionStart");
    expect(snapshot.hookSpecificOutput?.additionalContext).toContain("orchardlarge");
    expect(await searchMemory(service, who, "orchardlarge")).toContain("orchardlarge");
    await assertPrivateValuesAbsent(service, who, "orchardlarge", [privateValue]);
  });

  test.each(["escaped-code", "structured-json", "structured-patch"])("%s completion fits service admission after projection", async (shape) => {
    const service = await create(), who = owner(service);
    await commandHook(service, who, "SessionStart");
    const tool_name = shape === "structured-patch" ? "Write" : "Read", tool_use_id = "structured-capture";
    const file_path = join(who.metadata.workspace, "orchardshape.ts");
    const code = 'const orchardshape = "quoted\\\\value";\n'.repeat(1450);
    const tool_response = shape === "escaped-code" ? { type: "text", file: { filePath: file_path, content: code } } :
      shape === "structured-json" ? { content: JSON.stringify(Array.from({ length: 5500 }, (_, n) => n)) } :
        { structuredPatch: [{ lines: Array.from({ length: 5500 }, (_, n) => `+ orchardshape line ${n}`) }] };
    await commandHook(service, who, "PreToolUse", { tool_name, tool_use_id });
    await commandHook(service, who, "PostToolUse", { tool_name, tool_use_id, tool_input: { file_path }, tool_response });
    expect(rows(who, "shared_memory_deliveries")).toHaveLength(1);
    expect(await searchMemory(service, who, "orchardshape")).toContain("orchardshape");
  });

  test("production recovery command accepts long histories and omitted details remain searchable", async () => {
    const service = await create(), who = owner(service);
    await recover(service, who);
    for (let n = 0; n < 55; n++) {
      const extra = { tool_use_id: `error-${n}`, tool_name: "Bash" };
      success(await memory(service, who, "PreToolUse", extra), "registered");
      success(await memory(service, who, "PostToolUseFailure", { ...extra,
        tool_input: { command: `compile-${n}` }, error: `Error: failure${n} ${"detail ".repeat(50)}` }), "applied");
    }
    const output = await commandHook(service, who, "SessionStart");
    const snapshot = output.hookSpecificOutput?.additionalContext;
    expect(snapshot?.length).toBeLessThanOrEqual(10_000);
    expect(snapshot).toContain('<section_summary section="errors">');
    expect(snapshot).toMatch(/^<session_resume[\s\S]*<\/session_resume>$/);
    expect(await searchMemory(service, who, "failure54")).toContain("failure54");
  });

  test("production hook command connects enrollment, memory, recovery and MCP without cross-provider leakage", async () => {
    let service = await create();
    const a = owner(service, { session: "claude-root" });
    const b = owner(service, { provider: "codex", session: "codex-root", workspace: "worktree-b" });
    for (const who of [a, b]) await commandHook(service, who, "SessionStart");
    await commandHook(service, a, "UserPromptSubmit", { prompt_id: "prompt-a", prompt: "Implement orchardalpha." });
    for (const [who, marker] of [[a, "orchardalpha"], [b, "orchardbeta"]] as const) {
      await commandHook(service, who, "PreToolUse", { tool_use_id: "read-a", tool_name: "Read" });
      await commandHook(service, who, "PostToolUse", { tool_use_id: "read-a", tool_name: "Read",
        tool_input: { file_path: join(who.metadata.workspace, `${marker}.ts`) }, tool_response: `${marker} source` });
      const recovery = await commandHook(service, who, "SessionStart");
      expect(recovery.hookSpecificOutput?.hookEventName).toBe("SessionStart");
      expect(recovery.hookSpecificOutput?.additionalContext).toContain(marker);
      expect(recovery.hookSpecificOutput?.additionalContext).not.toContain(who === a ? "orchardbeta" : "orchardalpha");
      // Unlike searchMemory(), this path relies entirely on the command hook's
      // callable registration. A missing ordinary /hooks request must fail here.
      await commandHook(service, who, "PreToolUse", { tool_use_id: "search-a", tool_name: "mcp__context-mode__ctx_search" });
      const client = new Client({ name: "production-hook-integration", version: "1" });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", url(service)), {
          requestInit: { headers: { authorization: `Bearer ${who.grant.mcpCapability}` } },
        }));
        const result = await client.callTool({ name: "ctx_search", arguments: { queries: [marker], source: "session-events" },
          _meta: who.metadata.provider === "codex" ? { threadId: who.session, sessionId: who.session } : { "claudecode/toolUseId": "search-a" } });
        expect(result.isError).not.toBe(true);
        const content = JSON.stringify(result.content);
        expect(content).toContain(marker);
        expect(content).not.toContain(who === a ? "orchardbeta" : "orchardalpha");
      } finally { await client.close(); }
    }
    await service.close();
    service = await create();
    for (const [who, marker] of [[a, "orchardalpha"], [b, "orchardbeta"]] as const) {
      who.grant = service.issue(who.metadata);
      const recovered = (await commandHook(service, who, "SessionStart")).hookSpecificOutput?.additionalContext;
      expect(recovered).toContain(marker);
      expect(recovered).not.toContain(who === a ? "orchardbeta" : "orchardalpha");
    }
    expect(rows(a, "shared_memory_deliveries")).toHaveLength(3);
  }, 30_000);

  test("ordinary identity hooks retain their exact receipt without creating memory", async () => {
    const service = await create(), who = owner(service, { provider: "codex" });
    const result = await post(service, who, native(who, "SessionStart"));
    expect(result.status).toBe(202); expect(result.body).toEqual({ registered: true });
    expect(rows(who, "session_events")).toEqual([]);
    expect(rows(who, "shared_memory_deliveries")).toEqual([]);
  });

  test("rejects wrong-purpose credentials before parsing a malformed memory body", async () => {
    const service = await create(), who = owner(service);
    failure(await post(service, who, null, '{"memory":private-native-marker', who.grant.mcpCapability), 401, "unauthorized");
    expect(rows(who, "session_events")).toEqual([]);
    expect(existsSync(join(who.metadata.home, "context-mode"))).toBe(false);
  });

  test("unknown owners and workspace overrides never fall back to the latest enrolled session", async () => {
    const service = await create(), who = owner(service);
    await recover(service, who); success(await prompt(service, who), "applied");
    const before = rows(who, "shared_memory_deliveries");
    failure(await prompt(service, { ...who, session: "private-native-marker" }), 400, "invalid");
    failure(await memory(service, who, "UserPromptSubmit", { prompt_id: "private-native-marker", prompt: "foreign",
      cwd: join(root, "fallback") }), 400, "invalid");
    expect(rows(who, "shared_memory_deliveries")).toEqual(before);
    expect(await recover(service, who)).toContain("orchardalpha");
    expect(existsSync(join(root, "fallback", "store"))).toBe(false);
  });

  test("native prompt retries survive service restart and conflicting reuse cannot overwrite the receipt", async () => {
    const first = await create(), original = owner(first);
    await recover(first, original); success(await prompt(first, original), "applied");
    const before = rows(original, "session_events");
    success(await prompt(first, original), "duplicate");
    failure(await prompt(first, original, "prompt-a", "private-native-marker"), 409, "conflict");
    expect(rows(original, "session_events")).toEqual(before);
    expect(rows(original, "shared_memory_deliveries")).toHaveLength(1);
    await first.close();
    const second = await create(), resumed = owner(second);
    expect(await recover(second, resumed)).toContain("orchardalpha");
    success(await prompt(second, resumed), "duplicate");
    expect(rows(resumed, "session_events")).toEqual(before);
    expect(rows(resumed, "shared_memory_deliveries")).toHaveLength(1);
  });

  test("identical prompt text with distinct native occurrence IDs produces two prompt events", async () => {
    const service = await create(), who = owner(service);
    await recover(service, who);
    success(await prompt(service, who, "prompt-a"), "applied");
    success(await prompt(service, who, "prompt-b"), "applied");
    expect(rows(who, "session_events").filter((row) => row.type === "user_prompt")).toHaveLength(2);
    expect(rows(who, "shared_memory_deliveries")).toHaveLength(2);
  });

  test("interleaved roots and child memory recover only the exact owner", async () => {
    const service = await create(), a = owner(service), b = { ...a, session: "other" };
    const child = { ...a, agent: "child" };
    await recover(service, a); await recover(service, b); await recover(service, child);
    for (const [who, marker] of [[a, "orchardalpha"], [b, "meadowbeta"], [child, "childcherries"]] as const) {
      success(await prompt(service, who, "same-native-id", marker), "applied");
    }
    expect(rows(a, "shared_memory_deliveries")).toHaveLength(3);
    for (const [who, expected, excluded] of [[a, "orchardalpha", ["meadowbeta", "childcherries"]],
      [b, "meadowbeta", ["orchardalpha", "childcherries"]], [child, "childcherries", ["orchardalpha", "meadowbeta"]]] as const) {
      const snapshot = await recover(service, who); expect(snapshot).toContain(expected);
      for (const marker of excluded) expect(snapshot).not.toContain(marker);
    }
  });

  test("provider and workspace boundaries isolate the same native tool occurrence", async () => {
    const service = await create(), a = owner(service), b = owner(service, { provider: "codex" }),
      c = owner(service, { workspace: "other-workspace" });
    for (const [who, marker] of [[a, "orchardalpha"], [b, "codexbananas"], [c, "worktreecherries"]] as const) {
      await recover(service, who); success(await preTool(service, who), "registered");
      success(await completedTool(service, who, { tool_response: marker }), "applied");
    }
    expect(rows(a, "shared_memory_deliveries")).toHaveLength(3);
    const eventOwners = new Set<string>();
    for (const [who, expected, excluded] of [[a, "orchardalpha", ["codexbananas", "worktreecherries"]],
      [b, "codexbananas", ["orchardalpha", "worktreecherries"]], [c, "worktreecherries", ["orchardalpha", "codexbananas"]]] as const) {
      // MCP response bodies belong to searchable events, not inline resume sections.
      const stored = rows(who, "session_events").find((event) => event.category === "mcp" && String(event.data).includes(expected));
      expect(stored).toBeDefined(); eventOwners.add(String(stored!.session_id));
      expect(rows(who, "shared_memory_deliveries").filter((row) => row.session_id === stored!.session_id)).toHaveLength(1);
      const result = await searchMemory(service, who); expect(result).toContain(expected);
      for (const marker of excluded) expect(result).not.toContain(marker);
    }
    expect(eventOwners.size).toBe(3);
  });

  test("Codex prompt hooks refuse supplied occurrence claims until native qualification exists", async () => {
    const service = await create(), who = owner(service, { provider: "codex" });
    await recover(service, who);
    failure(await memory(service, who, "UserPromptSubmit", { prompt: "private-native-marker", prompt_id: "claimed", turn_id: "turn" }),
      422, "unsupported");
    expect(rows(who, "shared_memory_deliveries")).toEqual([]);
    expect(rows(who, "session_events")).toEqual([]);
  });

  test("terminal tool observations require prebinding and consistent native owner and name", async () => {
    const service = await create(), a = owner(service), b = { ...a, session: "other" };
    await recover(service, a); await recover(service, b);
    failure(await completedTool(service, a), 400, "invalid");
    success(await preTool(service, a), "registered");
    failure(await completedTool(service, b), 400, "invalid");
    failure(await completedTool(service, a, { tool_name: "private-native-marker" }), 400, "invalid");
    expect(rows(a, "shared_memory_deliveries")).toEqual([]);
    success(await completedTool(service, a), "applied");
    const stored = rows(a, "session_events").filter((event) => event.category === "mcp");
    expect(stored).toHaveLength(1); expect(String(stored[0].data)).toContain("orchardtool");
    expect(rows(a, "shared_memory_deliveries")).toHaveLength(1);
    expect(rows(a, "shared_memory_deliveries")[0].session_id).toBe(stored[0].session_id);
    expect(await searchMemory(service, a)).toContain("orchardtool");
    expect(await searchMemory(service, b)).not.toContain("orchardtool");
  });

  test("success and failure of one tool invocation cannot create two completion deliveries", async () => {
    const service = await create(), who = owner(service);
    await recover(service, who); success(await preTool(service, who), "registered");
    success(await completedTool(service, who), "applied");
    success(await completedTool(service, who), "duplicate");
    failure(await memory(service, who, "PostToolUseFailure", { tool_use_id: "tool-a", tool_name: TOOL,
      tool_input: { query: "orchardtool" }, error: "private-native-marker", tool_response: "private-native-marker" }), 409, "conflict");
    expect(rows(who, "shared_memory_deliveries")).toHaveLength(1);
    expect(await recover(service, who)).not.toContain("private-native-marker");
  });

  test.each(["object", "json-object-text", "json-string-wrapped-object", "nested-json-strings"])(
    "sanitizes %s failure responses before extraction, state, resume and actual search", async (kind) => {
    const service = await create(), who = owner(service);
    await recover(service, who); success(await preTool(service, who), "registered");
    const json = '{"result":"orchardpublic","nested":[{"api\\u005fkey":"synthetic-secret-a"},' +
      '{"authorization":"Bearer synthetic-secret-b"}],"cookie":"synthetic-secret-c"}';
    const response = kind === "object" ? JSON.parse(json) : kind === "json-object-text" ? json
      : kind === "json-string-wrapped-object" ? JSON.stringify(json)
      : { result: "orchardpublic", nested: [JSON.stringify(json)] };
    success(await memory(service, who, "PostToolUseFailure", { tool_use_id: "tool-a", tool_name: TOOL,
      tool_input: { query: "orchardpublic" }, error: response }), "applied");
    await assertPrivateValuesAbsent(service, who, "orchardpublic", ["synthetic-secret-a", "synthetic-secret-b", "synthetic-secret-c"]);
  });

  test.each(["tool-input", "prompt"])("sanitizes escaped JSON secret keys inside %s strings", async (kind) => {
    const service = await create(), who = owner(service);
    await recover(service, who);
    const marker = kind === "tool-input" ? "inputpublic" : "promptpublic";
    const json = `{"api\\u005fkey":"synthetic-value-a","result":"${marker}"}`;
    if (kind === "tool-input") {
      success(await preTool(service, who), "registered");
      success(await completedTool(service, who, { tool_input: { query: json }, tool_response: "tool result" }), "applied");
    } else {
      success(await memory(service, who, "UserPromptSubmit", { prompt_id: "escaped-prompt", prompt: json }), "applied");
    }
    expect(JSON.stringify(rows(who, "session_events"))).toContain(marker);
    await assertPrivateValuesAbsent(service, who, marker, ["synthetic-value-a"]);
  });

  test("a redacted assignment crossing the error-state limit remains retryable and resolves on success", async () => {
    const service = await create(), who = owner(service);
    await recover(service, who); success(await preTool(service, who), "registered");
    // The safe replacement begins at offset 199. The extractor's 200-character
    // error summary therefore cuts inside its marker, even though the full
    // admitted response has already been sanitized.
    const response = "orchardcut ".padEnd(189, "x") + ' api_key="synthetic-secret-cut"';
    const failed = { tool_use_id: "tool-a", tool_name: TOOL, tool_input: { query: "orchardcut" }, error: response };
    success(await memory(service, who, "PostToolUseFailure", failed), "applied");
    const stateRows = rows(who, "shared_memory_extraction");
    expect(stateRows).toHaveLength(1);
    const state = JSON.parse(String(stateRows[0].state_json)) as { lastError: { error: string } | null };
    expect(state.lastError).not.toBeNull();
    expect(state.lastError!.error.length).toBeLessThanOrEqual(200);
    expect(Buffer.byteLength(String(stateRows[0].state_json))).toBeLessThanOrEqual(32 * 1024);
    await assertPrivateValuesAbsent(service, who, "orchardcut", ["synthetic-secret-cut"]);
    const before = rows(who, "session_events");
    success(await memory(service, who, "PostToolUseFailure", failed), "duplicate");
    expect(rows(who, "session_events")).toEqual(before);
    success(await preTool(service, who, "tool-next"), "registered");
    success(await completedTool(service, who, { tool_use_id: "tool-next", tool_response: "orchardcut fixed" }), "applied");
    const resolved = JSON.parse(String(rows(who, "shared_memory_extraction")[0].state_json)) as { lastError: unknown };
    expect(resolved.lastError).toBeNull();
    expect(rows(who, "shared_memory_deliveries")).toHaveLength(2);
    const persisted = JSON.stringify([rows(who, "session_events"), rows(who, "shared_memory_extraction"),
      rows(who, "session_resume"), rows(who, "chunks"), await recover(service, who), await searchMemory(service, who, "orchardcut")]);
    expect(persisted).toContain("orchardcut"); expect(persisted.includes("synthetic-secret-cut")).toBe(false);
  });

  test("index failure after commit is retryable without duplicating SQLite events", async () => {
    const service = await create(), who = owner(service);
    await recover(service, who);
    const original = ContentStore.prototype.index;
    const index = vi.spyOn(ContentStore.prototype, "index").mockImplementationOnce(() => { throw new Error("private-native-marker"); });
    failure(await prompt(service, who), 503, "storage");
    const before = rows(who, "session_events");
    expect(before.some((event) => String(event.data).includes("orchardalpha"))).toBe(true);
    expect(rows(who, "shared_memory_deliveries")).toHaveLength(1);
    index.mockImplementation(original);
    success(await prompt(service, who), "duplicate");
    expect(rows(who, "session_events")).toEqual(before);
    expect(JSON.stringify(rows(who, "chunks"))).toContain("orchardalpha");
  });

  test("memory recovery consumes the existing owner capacity", async () => {
    const service = await create({ maxSessions: 1 }), a = owner(service), b = owner(service, { session: "other" });
    await recover(service, a); success(await prompt(service, a), "applied");
    failure(await memory(service, b, "SessionStart"), 429, "capacity");
    expect(await recover(service, a)).toContain("orchardalpha");
    expect(rows(a, "shared_memory_deliveries")).toHaveLength(1);
  });

  test("rechecks hook authority after the final asynchronous admission boundary", async () => {
    const service = await create(), who = owner(service);
    await recover(service, who);
    let authenticationCount = 0;
    authenticationAttempts = 0;
    authenticated = () => {
      if (++authenticationCount === 2) service.revoke(who.grant.scope);
    };
    failure(await prompt(service, who), 401, "unauthorized");
    expect(authenticationCount).toBe(2);
    expect(authenticationAttempts).toBe(3);
    expect(rows(who, "shared_memory_deliveries")).toEqual([]);
    expect(rows(who, "session_events")).toEqual([]);
  });

  test("two unsettled memory operations exhaust admission even after one client disconnects", async () => {
    const service = await create(), who = owner(service);
    await recover(service, who);
    const full = deferred(), releases = [deferred(), deferred()];
    let admitted = 0;
    afterCommit = async () => {
      const slot = admitted++;
      if (admitted === 2) full.resolve();
      if (slot < releases.length) await releases[slot].promise;
    };
    const controllers = [new AbortController(), new AbortController()];
    const pending = controllers.map((controller, index) => fetch(url(service), {
      method: "POST", signal: controller.signal, headers: { authorization: `Bearer ${who.grant.hookCapability}`,
        "content-type": "application/json" }, body: JSON.stringify({ memory: native(who, "UserPromptSubmit", {
        prompt_id: `held-${index}`, prompt: `Implement heldorchard${index}.`,
      }) }),
    }).then(async (response) => ({ status: response.status, body: await response.json() })));
    for (const request of pending) void request.catch(() => undefined);
    try {
      expect(await Promise.race([full.promise.then(() => "full"), Promise.all(pending)])).toBe("full");
      expect(service.health().inFlightRequests).toBe(2);
      expect(rows(who, "shared_memory_deliveries")).toHaveLength(2);
      failure(await prompt(service, who, "third"), 429, "capacity");
      controllers[0].abort(); await pending[0].catch(() => undefined);
      expect(service.health().inFlightRequests).toBe(2);
      failure(await prompt(service, who, "third"), 429, "capacity");
      afterCommit = undefined; releases[0].resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(service.health().inFlightRequests).toBe(1);
      success(await prompt(service, who, "third"), "applied");
      expect(rows(who, "shared_memory_deliveries")).toHaveLength(3);
    } finally {
      for (const controller of controllers) controller.abort();
      for (const release of releases) release.resolve();
      await Promise.allSettled(pending);
    }
  });

  test("revocation during upload prevents memory commit", async () => {
    const service = await create(), who = owner(service);
    await recover(service, who);
    const reached = deferred(); authenticated = (request) => { if (request.headers["x-test-upload"]) reached.resolve(); };
    const data = JSON.stringify({ memory: native(who, "UserPromptSubmit", { prompt_id: "late", prompt: "private-native-marker" }) });
    let outgoing!: ReturnType<typeof httpRequest>;
    const received = new Promise<Reply>((resolve, reject) => {
      outgoing = httpRequest(url(service), { method: "POST", headers: { authorization: `Bearer ${who.grant.hookCapability}`,
        "content-type": "application/json", "x-test-upload": "partial" } }, (response) => {
        let raw = ""; response.on("data", (part) => { raw += part; });
        response.once("end", () => resolve({ status: response.statusCode!, raw, body: JSON.parse(raw) }));
      });
      outgoing.once("error", reject); outgoing.write(data.slice(0, 1));
    });
    void received.catch(() => undefined);
    try {
      expect(await Promise.race([reached.promise.then(() => "authenticated"), received])).toBe("authenticated");
      service.revoke(who.grant.scope);
      outgoing.end(data.slice(1)); failure(await received, 401, "unauthorized");
      expect(rows(who, "shared_memory_deliveries")).toEqual([]);
      expect(rows(who, "session_events")).toEqual([]);
    } finally { outgoing.destroy(); }
  });

  test("disconnect after commit retains one receipt and shutdown drains the unsettled hook", async () => {
    const service = await create(), who = owner(service);
    await recover(service, who);
    const committed = deferred(), release = deferred();
    afterCommit = async () => { committed.resolve(); await release.promise; };
    const controller = new AbortController();
    const pending = fetch(url(service), { method: "POST", signal: controller.signal, headers: {
      authorization: `Bearer ${who.grant.hookCapability}`, "content-type": "application/json",
    }, body: JSON.stringify({ memory: native(who, "UserPromptSubmit", { prompt_id: "prompt-a", prompt: "Implement orchardalpha in this workspace." }) }) });
    void pending.catch(() => undefined);
    let closing: Promise<void> | undefined;
    try {
      expect(await Promise.race([committed.promise.then(() => "committed"), pending.then((response) => response.status)])).toBe("committed");
      expect(rows(who, "shared_memory_deliveries")).toHaveLength(1);
      controller.abort(); await pending.catch(() => undefined);
      expect(service.health().inFlightRequests).toBe(1);
      closing = service.close();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(service.health().state).toBe("draining"); expect(runtimeClosing).toBe(false);
    } finally { controller.abort(); release.resolve(); await pending.catch(() => undefined); await closing; }
    afterCommit = undefined;
    const next = await create(), resumed = owner(next);
    expect(await recover(next, resumed)).toContain("orchardalpha");
    success(await prompt(next, resumed), "duplicate");
    expect(rows(resumed, "shared_memory_deliveries")).toHaveLength(1);
  });
});
