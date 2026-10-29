import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ContentStore } from "../../src/store.js";
import { SessionDB } from "../../src/session/db.js";
import { FloodGuard } from "../../src/search/flood-guard.js";
import { composeFetchCacheKey } from "../../src/fetch-cache.js";
import { withSharedToolContext, type SharedExecutor, type SharedToolContext } from "../../src/shared/runtime-context.js";
import type { ExecResult } from "../../src/types.js";
import type { RegisteredCtxTool } from "../../src/server.js";

type ExecuteInput = Parameters<SharedExecutor["execute"]>[0];
type ExecuteFileInput = Parameters<SharedExecutor["executeFile"]>[0];
type Result = { content: Array<{ type: string; text?: string }>; isError?: boolean };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function output(stdout: string): ExecResult {
  return { stdout, stderr: "", exitCode: 0, timedOut: false };
}

function text(result: Result): string {
  expect(result.isError).not.toBe(true);
  return result.content.map((part) => part.text ?? "").join("\n");
}

describe("shared execution context reuses registered handlers", () => {
  let root: string;
  let store: ContentStore;
  let db: SessionDB;
  let tools: RegisteredCtxTool[];
  let legacyExecute: ReturnType<typeof vi.spyOn>;
  let legacyExecuteFile: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "ctx-execution-context-")));
    const fallback = join(root, "fallback");
    mkdirSync(fallback);
    for (const key of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CLAUDE_PROJECT_DIR",
      "CONTEXT_MODE_PROJECT_DIR", "CONTEXT_MODE_DIR", "TMPDIR", "TEMP", "TMP"]) vi.stubEnv(key, fallback);
    vi.stubEnv("CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS", "1");
    vi.stubEnv("CONTEXT_MODE_PLATFORM", "codex");
    store = new ContentStore(join(root, "content.db"));
    db = new SessionDB({ dbPath: join(root, "sessions.db") });
    // A RED run must never fall through to the singleton and execute code.
    const { PolyglotExecutor } = await import("../../src/executor.js");
    legacyExecute = vi.spyOn(PolyglotExecutor.prototype, "execute").mockRejectedValue(new Error("UNSCOPED_EXECUTOR"));
    legacyExecuteFile = vi.spyOn(PolyglotExecutor.prototype, "executeFile").mockRejectedValue(new Error("UNSCOPED_EXECUTOR"));
    tools = (await import("../../src/server.js")).REGISTERED_CTX_TOOLS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store?.close();
    db?.close();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  function context(owner: string, launch = owner, workspace = "workspace"): SharedToolContext {
    const home = join(root, "home");
    const cwd = join(root, workspace);
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    db.ensureSession(owner, cwd);
    return {
      identity: { provider: "codex", home, workspace: cwd, launchId: launch, sessionId: owner, threadId: owner },
      ownerId: owner, store, storePath: join(root, "content.db"), sessionDbPath: join(root, "sessions.db"),
      sessionsDir: root, statsPath: join(root, `stats-${owner}.json`),
      attribution: { sessionId: owner, workspaceDir: cwd, db },
      stats: { calls: {}, bytesReturned: {}, bytesIndexed: 0, bytesSandboxed: 0,
        cacheHits: 0, cacheMisses: 0, cacheBytesSaved: 0, sessionStart: 1_800_000_000_000 },
      persistence: { lastWrite: 0 }, now: () => 1_800_000_000_000,
      floodGuard: new FloodGuard({ windowMs: 60_000, softCapAfter: 30, blockAfter: 80 }),
      denyFile: (path) => !resolve(cwd, path).startsWith(cwd + "/") && resolve(cwd, path) !== cwd &&
        !resolve(cwd, path).startsWith(cwd + "\\"),
    };
  }

  function authorize(base: SharedToolContext, execute: SharedExecutor["execute"],
    executeFile?: SharedExecutor["executeFile"], controller = new AbortController()) {
    const executor: SharedExecutor = { execute, executeFile: executeFile ?? (async () => output("unused")), close: async () => {} };
    return { ...base, execution: { authorityId: `${base.identity.launchId}:policy-1`, executor,
      cwd: base.identity.workspace, signal: controller.signal } };
  }

  async function invoke(scope: SharedToolContext, name: string, args: Record<string, unknown>): Promise<Result> {
    const tool = tools.find((entry) => entry.name === name);
    if (!tool) throw new Error(`Missing registered tool ${name}`);
    // Exercise the same schema and wrapped handler as the SDK registration.
    const parsed = await (tool.config.inputSchema as { parseAsync(value: unknown): Promise<Record<string, unknown>> }).parseAsync(args);
    return withSharedToolContext(scope, () => tool.handler(parsed)) as Promise<Result>;
  }

  test.each(["ctx_execute", "ctx_execute_file"])("%s isolates launch executors and workspaces, including a shared durable owner", async (name) => {
    const release = deferred<void>();
    const entered = [deferred<void>(), deferred<void>(), deferred<void>()];
    const inputs: Array<ExecuteInput | ExecuteFileInput> = [];
    const launches = ["launch-a", "launch-b", "launch-c"];
    const scopes = launches.map((launch, i) => {
      const base = context(i === 2 ? "other-conversation" : "same-conversation", launch,
        i === 2 ? "other-workspace" : "workspace");
      writeFileSync(join(base.identity.workspace, "notes.txt"), "owned notes");
      const run = async (input: ExecuteInput | ExecuteFileInput) => {
        inputs[i] = input;
        entered[i].resolve();
        await release.promise;
        const value = "path" in input ? `${launch}: ${readFileSync(resolve(input.cwd!, input.path), "utf8")}` : launch;
        return output(value);
      };
      return authorize(base, run, run);
    });
    const args = { language: "javascript", code: "0", ...(name === "ctx_execute_file" ? { path: "notes.txt" } : {}) };
    const pending = scopes.map((scope) => invoke(scope, name, args));
    try {
      const readiness = await Promise.race([
        Promise.all(entered.map((entry) => entry.promise)).then(() => "entered"),
        Promise.all(pending).then(() => "returned-without-scoped-executors"),
      ]);
      expect(readiness).toBe("entered");
      for (let i = 0; i < scopes.length; i++) {
        expect(inputs[i].cwd).toBe(scopes[i].identity.workspace);
        expect(inputs[i].signal).toBe(scopes[i].execution.signal);
        expect(inputs[i].timeout).toBeUndefined();
      }
    } finally { release.resolve(); }
    const results = await Promise.all(pending);
    for (let i = 0; i < scopes.length; i++) {
      expect(text(results[i])).toContain(launches[i]);
      for (const sibling of launches.filter((launch) => launch !== launches[i])) {
        expect(text(results[i])).not.toContain(sibling);
      }
    }
    expect(legacyExecute).not.toHaveBeenCalled();
    expect(legacyExecuteFile).not.toHaveBeenCalled();
  });

  test.each([1, 2])("batch cancellation stops queued commands at concurrency %i", async (concurrency) => {
    const controller = new AbortController();
    const ready = deferred<void>();
    const active: ExecuteInput[] = [];
    const scope = authorize(context("batch-owner"), async (input) => {
      active.push(input);
      if (active.length === concurrency) ready.resolve();
      return new Promise<ExecResult>((done) => {
        const finish = () => done({ ...output("cancelled"), exitCode: 1, cancelled: true });
        if (controller.signal.aborted) { finish(); return; }
        input.signal?.addEventListener("abort", finish, { once: true });
        controller.signal.addEventListener("abort", finish, { once: true });
      });
    }, undefined, controller);
    const pending = invoke(scope, "ctx_batch_execute", { commands: [1, 2, 3].map((i) => ({ label: `job-${i}`, command: "0" })),
      queries: ["orchard"], concurrency });
    try {
      expect(await Promise.race([ready.promise.then(() => "entered"), pending.then(() => "returned")])).toBe("entered");
      for (const input of active) {
        expect(input.signal).toBe(controller.signal);
        expect(input.cwd).toBe(scope.identity.workspace);
        expect(input.timeout).toBeUndefined();
      }
    } finally { controller.abort(); }
    await pending.catch(() => undefined);
    expect(active).toHaveLength(concurrency);
    expect(store.getStats().chunks).toBe(0);
  });

  test.each([
    ["ctx_execute", { language: "javascript", code: "0" }],
    ["ctx_execute_file", { path: "notes.txt", language: "javascript", code: "0" }],
    ["ctx_batch_execute", { commands: [{ label: "a", command: "0" }], queries: ["orchard"] }],
    ["ctx_fetch_and_index", { url: "https://93.184.216.34/fixture" }],
  ])("%s without trusted execution context refuses before using legacy execution", async (name, args) => {
    const scope = context("missing-policy");
    writeFileSync(join(scope.identity.workspace, "notes.txt"), "owned fixture");
    const result = await invoke(scope, name as string, args as Record<string, unknown>).catch((error) => ({
      isError: true, content: [{ type: "text", text: String(error) }],
    }));
    expect(result.isError).toBe(true);
    expect(result.content.map((part) => part.text).join("\n")).toMatch(/shared.*(execution|authority|policy)|trusted.*execution/i);
    expect(legacyExecute).not.toHaveBeenCalled();
    expect(legacyExecuteFile).not.toHaveBeenCalled();
    expect(store.getStats().chunks).toBe(0);
  });

  test("execution intent search excludes sibling and legacy sources with the same label", async () => {
    store.indexPlainText("orchard siblingsecret", "execute:javascript", undefined, { sessionId: "sibling" });
    store.indexPlainText("orchard legacysecret", "execute:javascript");
    const ownOutput = "orchard ownapples\n" + "fixture filler without matching words\n".repeat(200);
    const scope = authorize(context("intent-owner"), async () => output(ownOutput));
    const response = text(await invoke(scope, "ctx_execute", { language: "javascript", code: "0", intent: "orchard" }));
    expect(response).toContain("ownapples");
    expect(response).not.toMatch(/siblingsecret|legacysecret/);
    expect(store.searchWithFallback("ownapples", 5, undefined, undefined, "exact", new Set([scope.ownerId]),
      { includeUnattributed: false })).toHaveLength(1);
  });

  test.each(["batch", "global"])("batch %s queries restrict results to the current owner and read policy", async (query_scope) => {
    store.indexPlainText("orchard siblingsecret", "batch:notes", undefined, { sessionId: "sibling" });
    store.indexPlainText("orchard legacysecret", "batch:notes");
    const base = context("query-owner");
    const deniedPath = join(base.identity.workspace, "denied.txt");
    writeFileSync(deniedPath, "orchard deniedsecret");
    store.index({ path: deniedPath, source: "other", attribution: { sessionId: base.ownerId } });
    const scope = authorize({ ...base, denyFile: (path) => path === deniedPath }, async () => output("orchard ownapples"));
    const response = text(await invoke(scope, "ctx_batch_execute", {
      commands: [{ label: "notes", command: "0" }], queries: ["orchard"], query_scope,
    }));
    expect(response).toContain("ownapples");
    expect(response).not.toMatch(/siblingsecret|legacysecret|deniedsecret/);
    expect(scope.stats.calls.ctx_batch_execute).toBe(1);
  });

  test("fetch cache is owner-scoped and fetched output retains request ownership", async () => {
    const url = "https://93.184.216.34/fixture";
    const label = composeFetchCacheKey("notes", url);
    store.indexPlainText("orchard siblingsecret", label, undefined, { sessionId: "sibling" });
    const inputs: ExecuteInput[] = [];
    const scope = authorize(context("fetch-owner"), async (input) => {
      inputs.push(input);
      const pathLiteral = input.code.match(/const outputPath = ("(?:[^"\\]|\\.)*");/);
      if (!pathLiteral) throw new Error("Fetch handler did not supply its output artifact path");
      writeFileSync(JSON.parse(pathLiteral[1]), "orchard ownapples");
      return output("__CM_CT__:text");
    });
    const first = text(await invoke(scope, "ctx_fetch_and_index", { url, source: "notes" }));
    expect(first).toContain("ownapples");
    expect(first).not.toContain("siblingsecret");
    expect(inputs).toHaveLength(1);
    expect(inputs[0].signal).toBe(scope.execution.signal);
    expect(inputs[0].cwd).toBe(scope.identity.workspace);
    expect(store.getSourceMeta(label, { sessionId: scope.ownerId })).not.toBeNull();
    expect(store.getSourceMeta(label, { sessionId: "sibling" })).not.toBeNull();
    expect(text(await invoke(scope, "ctx_fetch_and_index", { url, source: "notes" }))).toContain("Cached:");
    expect(inputs).toHaveLength(1);
  });
});
