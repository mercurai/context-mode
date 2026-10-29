import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegisteredCtxTool } from "../../src/server.js";

type Result = { content: Array<{ text: string }>; isError?: boolean };
type Stats = {
  session_start: number;
  bytes_indexed: number;
  bytes_sandboxed: number;
  by_tool: Record<string, { calls: number; bytes: number }>;
};

describe("legacy handlers persist statistics from real work", () => {
  let root: string;
  let workspace: string;
  let storage: string;
  let fixture: string;
  let clock: number;
  let tools: RegisteredCtxTool[];
  let exitListeners: ReturnType<typeof process.listeners>;
  const payload = Buffer.alloc(137, 65);

  beforeEach(async () => {
    tools = [];
    root = realpathSync(mkdtempSync(join(tmpdir(), "ctx-legacy-statistics-")));
    workspace = join(root, "workspace");
    storage = join(root, "storage");
    const temporary = join(root, "tmp");
    const home = join(root, "home");
    for (const path of [workspace, temporary, home]) mkdirSync(path, { recursive: true });
    fixture = join(workspace, "fixture.txt");
    writeFileSync(fixture, payload);
    // Import only after every legacy storage/cleanup resolver is contained.
    for (const [key, value] of Object.entries({
      HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, ".claude"),
      CODEX_HOME: join(home, ".codex"), CONTEXT_MODE_DIR: storage,
      APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
      XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_STATE_HOME: join(home, ".local", "state"), XDG_CACHE_HOME: join(home, ".cache"),
      COPILOT_HOME: join(home, ".copilot"), KIMI_CODE_HOME: join(home, ".kimi"),
      PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
      CONTEXT_MODE_PROJECT_DIR: workspace, CLAUDE_PROJECT_DIR: workspace,
      CLAUDE_SESSION_ID: "legacy-statistics-fixture", CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS: "1",
      TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    })) vi.stubEnv(key, value);
    clock = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    exitListeners = process.listeners("exit");
    vi.resetModules();
    tools = (await import("../../src/server.js")).REGISTERED_CTX_TOOLS;
  });

  afterEach(async () => {
    try {
      // Closes the real content-store handle before removing this fixture.
      if (tools.length) await invoke("ctx_purge", { confirm: true, scope: "project" });
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      // Batch execution creates its own preload cleanup listener lazily.
      // Its file lives under root/tmp and is removed with this fixture.
      for (const listener of process.listeners("exit")) {
        if (!exitListeners.includes(listener)) process.removeListener("exit", listener);
      }
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  async function invoke(name: string, args: Record<string, unknown> = {}, expectError = false): Promise<Result> {
    clock += 1_000; // Advance the persistence throttle without a wall-clock wait.
    const tool = tools.find((entry) => entry.name === name)!;
    const schema = tool.config.inputSchema as { parseAsync(value: unknown): Promise<Record<string, unknown>> };
    const result = await tool.handler(await schema.parseAsync(args)) as Result;
    if (expectError) expect(result.isError).toBe(true);
    else expect(result.isError, result.content.map((part) => part.text).join("\n")).not.toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    return result;
  }

  async function snapshot(): Promise<Stats> {
    await invoke("ctx_stats");
    return JSON.parse(readFileSync(join(storage, "sessions", "stats-legacy-statistics-fixture.json"), "utf8"));
  }

  test("project purge removes indexed content and resets accumulated counters", async () => {
    const content = "# Orchard\n\nOrchard data contains purgeproofapples.";
    await invoke("ctx_index", { content, source: "purge-fixture" });
    const before = await snapshot();
    expect(before.bytes_indexed).toBe(Buffer.byteLength(content));
    expect(before.by_tool.ctx_index.calls).toBe(1);
    const purged = await invoke("ctx_purge", { confirm: true, scope: "project" });
    expect(purged.content.map((part) => part.text).join("\n")).toContain("Purged:");
    const resetAt = clock;
    const after = await snapshot();
    expect(after.bytes_indexed).toBe(0);
    expect(after.bytes_sandboxed).toBe(0);
    expect(after.by_tool.ctx_index).toBeUndefined();
    // The purge response itself belongs to the new statistics interval.
    expect(after.by_tool.ctx_purge.calls).toBe(1);
    expect(after.by_tool.ctx_stats.calls).toBe(1);
    expect(after.session_start).toBe(resetAt);
    const searched = await invoke("ctx_search", { queries: ["purgeproofapples"] }, true);
    const searchText = searched.content.map((part) => part.text).join("\n");
    expect(searchText).toMatch(/knowledge base is empty/i);
    expect(searchText).not.toContain("Orchard data contains");
    expect(existsSync(fixture)).toBe(true);
  });

  test("execute counts actual file bytes and hides internal FS markers", async () => {
    const result = await invoke("ctx_execute", {
      language: "javascript",
      code: `console.log('read-ok', require('fs').readFileSync(${JSON.stringify(fixture)}).length)`,
      timeout: 10_000,
    });
    const output = result.content.map((part) => part.text).join("\n");
    expect(output).toContain("read-ok 137");
    expect(output).not.toContain("__CM_FS__");
    const stats = await snapshot();
    expect(stats.bytes_sandboxed).toBe(payload.length);
    expect(stats.by_tool.ctx_execute.calls).toBe(1);
  });

  test("batch execute counts subprocess file bytes and hides internal FS markers", async () => {
    const result = await invoke("ctx_batch_execute", {
      commands: [{ label: "read-fixture", command: 'node -e "console.log(\'batchreadproof\', require(\'fs\').readFileSync(\'fixture.txt\').length)"' }],
      queries: ["batchreadproof"], cwd: workspace, concurrency: 1, timeout: 10_000,
    });
    const output = result.content.map((part) => part.text).join("\n");
    expect(output).toContain("batchreadproof 137");
    expect(output).not.toContain("__CM_FS__");
    const stats = await snapshot();
    expect(stats.bytes_sandboxed).toBe(payload.length);
    expect(stats.by_tool.ctx_batch_execute.calls).toBe(1);
  });
});
