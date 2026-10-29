// Runner orchestration with real diagnostic HTTP/identity state and synthetic client results.
// No native clients/history, model turns, operational homes, or memory-store writes.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runClient, validateCodexPromptOptions, runDiagnosticPromptFlow } from "./run.mjs";
import { createProbeServer } from "./server.mjs";
import { projectMemoryHook } from "./memory-hooks.mjs";

const rootId = "OMIT-ROOT", home = "/OMIT-HOME";
const workspace = process.platform === "win32" ? process.cwd().toLowerCase() : process.cwd();
const prompt = "OMIT-SYNTHETIC-PROMPT", launchCapability = "OMIT-LAUNCH";
const validOptions = { codexPromptIds: true, backend: "diagnostic", which: "codex", hookType: "command", memoryHooks: true };
const runner = fileURLToPath(new URL("./run.mjs", import.meta.url));
const success = () => ({ code: 0, timedOut: false, failure: undefined,
  stdout: JSON.stringify({ type: "thread.started", thread_id: rootId }) });
const expectedQualification = {
  qualified: true, rootOccurrences: 1, resumedOccurrences: 1,
  repeatReadsStable: true, oldTurnStableAfterResume: true, repeatedPromptIdsDistinct: true,
  childPromptsQualified: false, sameTurnSteeringQualified: false, deliveryRetryQualified: false,
  rollbackQualified: false, compactionQualified: false, recoveryConsumptionQualified: false,
};
const snapshot = (turnId, id) => ({ turnId, ids: [id], itemCount: 1, matchingPrompts: 1, complete: true });
function phase(target, priorTarget) {
  const current = snapshot(target.turnId, target.flow === "root-A" ? "OMIT-PROMPT-A" : "OMIT-PROMPT-B");
  return { target: { ...target }, historyMode: "paginated", snapshots: [
    ...(priorTarget ? [snapshot(priorTarget.turnId, "OMIT-PROMPT-A")] : []), current, structuredClone(current),
  ] };
}

test("prompt qualification is opt-in and disabled options preserve both existing backends", () => {
  for (const backend of ["diagnostic", "production"]) {
    assert.equal(validateCodexPromptOptions({ backend, which: "all", hookType: "http", memoryHooks: false }), false);
    assert.equal(validateCodexPromptOptions({ ...validOptions, backend, codexPromptIds: false }), false);
  }
});
for (const which of ["codex", "all"]) {
  test(`prompt option accepts diagnostic command memory collection with ${which}`, () => {
    assert.equal(validateCodexPromptOptions({ ...validOptions, which }), true);
  });
}
for (const [label, change] of [
  ["production backend", { backend: "production" }], ["Claude only", { which: "claude" }],
  ["disabled memory hooks", { memoryHooks: false }], ["HTTP hooks", { hookType: "http" }],
]) {
  test(`prompt option rejects ${label}`, () => {
    assert.throws(() => validateCodexPromptOptions({ ...validOptions, ...change }), { code: "CODEX_PROMPT_OPTIONS_INVALID" });
  });
}

async function setup(t, names = ["root-A", "resume-A"], provider = "codex") {
  const probe = createProbeServer({ launches: [{ provider, home, workspace, capability: launchCapability }],
    memoryHooks: { flows: names.map((name) => ({ provider, name })) } });
  const port = await probe.listen();
  t.after(() => probe.close());
  async function post(path, body, capability) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", redirect: "error",
      headers: { "content-type": "application/json", authorization: `Bearer ${capability}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return response.status;
  }
  const native = (event, fields = {}) => ({ hook_event_name: event, session_id: rootId, cwd: workspace, ...fields });
  async function registration() {
    const body = provider === "codex" ? native("SessionStart") : native("PreToolUse", {
      tool_use_id: "OMIT-TOOL", tool_name: "mcp__probe__identity_echo" });
    assert.equal(await post("/hook", body, launchCapability), 200);
    assert.equal(await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "identity_echo", arguments: {}, _meta: provider === "codex" ? { threadId: rootId, sessionId: rootId } :
        { "claudecode/toolUseId": "OMIT-TOOL" },
    } }, launchCapability), 200);
  }
  const deliver = (capability, event, fields) => post("/hook", {
    memory: projectMemoryHook(provider, JSON.stringify(native(event, fields))),
  }, capability);
  async function flow(name, { register = true, turnId = name === "resume-A" ? "OMIT-TURN-B" : "OMIT-TURN-A", stopTurn = turnId } = {}) {
    if (register) await registration();
    const memoryCapability = probe.beginMemoryFlow(launchCapability, name);
    assert.equal(await deliver(memoryCapability, "UserPromptSubmit", { turn_id: turnId }), 202);
    assert.equal(await deliver(memoryCapability, "Stop", { turn_id: stopTurn }), 202);
    const env = { CODEX_HOME: home, PROBE_MEMORY_CAP: memoryCapability, PROBE_MEMORY_PROVIDER: provider };
    return { client: provider, name, probe, memoryCapability, env, expectedPrompt: prompt, qualifyPrompts: true,
      readerOptions: { command: "OMIT-BINARY", configArgs: ["-c", "OMIT-CONFIG"], cwd: workspace, env },
      run: async () => provider === "codex" ? success() : { ...success(), stdout: JSON.stringify({ session_id: rootId }) } };
  }
  return { probe, flow, deliver };
}

test("root and resume qualify the existing two runs after trusted completion and capability revocation", async (t) => {
  const { probe, flow, deliver } = await setup(t);
  let runs = 0, reads = 0, active = 0;
  const readPhase = async (options) => {
    assert.equal(++active, 1);
    try {
      reads++;
      assert.equal(options.target.provider, "codex"); assert.equal(options.target.sessionId, rootId);
      assert.equal(options.target.threadId, rootId); assert.equal(options.target.home, home);
      assert.equal(options.target.workspace, workspace); assert.equal(options.target.launchId, "l1");
      assert.equal(options.command, "OMIT-BINARY"); assert.deepEqual(options.configArgs, ["-c", "OMIT-CONFIG"]);
      assert.equal(options.cwd, workspace); assert.equal(options.expectedPrompt, prompt);
      assert.equal(options.env.PROBE_MEMORY_CAP, "");
      assert.equal(await deliver(lastCapability, "Stop", { turn_id: options.target.turnId }), 401);
      if (options.target.flow === "root-A") assert.equal(options.priorTarget, undefined);
      else assert.equal(options.priorTarget.turnId, "OMIT-TURN-A");
      return phase(options.target, options.priorTarget);
    } finally { active--; }
  };
  let lastCapability;
  const first = await flow("root-A"); lastCapability = first.memoryCapability;
  const initial = await runDiagnosticPromptFlow({ ...first, run: async () => { runs++; return success(); } }, { readPhase });
  assert.equal(initial.root, rootId); assert.equal(initial.promptPhase.target.flow, "root-A");
  assert.equal(initial.promptQualification, undefined);
  const second = await flow("resume-A"); lastCapability = second.memoryCapability;
  const resumed = await runDiagnosticPromptFlow({ ...second, priorPhase: initial.promptPhase,
    run: async () => { runs++; return success(); } }, { readPhase });
  assert.equal(runs, 2); assert.equal(reads, 2); assert.equal(active, 0);
  assert.deepEqual(resumed.promptQualification, expectedQualification);
  assert.equal(resumed.promptPhase, undefined);
  assert.equal(resumed.promptFailure, undefined);
  assert.ok(!JSON.stringify(resumed.promptQualification).includes("OMIT-"));
  assert.ok(!JSON.stringify(probe.report()).includes("OMIT-"));
});

for (const name of ["root-B", "child", "concurrent-1", "concurrent-2", "mixed"]) {
  test(`${name} retains normal flow completion without a prompt history read`, async (t) => {
    const { flow } = await setup(t, [name]);
    const input = await flow(name);
    const result = await runDiagnosticPromptFlow(input, { readPhase: async () => assert.fail("unselected flow read") });
    assert.equal(result.root, rootId); assert.equal(result.promptPhase, undefined);
    assert.equal(result.promptQualification, undefined); assert.equal(input.env.PROBE_MEMORY_CAP, "");
  });
}
test("disabled prompt qualification preserves memory completion without requesting a target", async (t) => {
  const { flow } = await setup(t, ["root-A"]);
  const input = await flow("root-A", { turnId: undefined, stopTurn: "OMIT-OTHER" });
  const result = await runDiagnosticPromptFlow({ ...input, qualifyPrompts: false }, {
    readPhase: async () => assert.fail("disabled prompt read"),
  });
  assert.equal(result.root, rootId); assert.equal(result.memoryFailure, undefined);
  assert.equal(result.promptPhase, undefined); assert.equal(input.env.PROBE_MEMORY_CAP, "");
});
test("Claude flow never enters Codex prompt qualification", async (t) => {
  const { flow } = await setup(t, ["root-A"], "claude");
  const input = await flow("root-A");
  const result = await runDiagnosticPromptFlow(input, { readPhase: async () => assert.fail("Claude prompt read") });
  assert.equal(result.root, rootId); assert.equal(result.promptPhase, undefined);
  assert.equal(result.memoryFailure, undefined); assert.equal(input.env.PROBE_MEMORY_CAP, "");
});

for (const [label, overrides] of [
  ["failed native exit", { code: 1 }], ["native timeout", { timedOut: true }],
  ["native output failure", { failure: "output-limit" }], ["missing native root", { stdout: "{}" }],
]) {
  test(`${label} retires the capability and never reads history`, async (t) => {
    const { flow, deliver, probe } = await setup(t, ["root-A"]);
    const input = await flow("root-A");
    const result = await runDiagnosticPromptFlow({ ...input, run: async () => ({ ...success(), ...overrides }) }, {
      readPhase: async () => assert.fail("failed native run read"),
    });
    assert.equal(result.promptPhase, undefined); assert.equal(result.promptQualification, undefined);
    assert.equal(input.env.PROBE_MEMORY_CAP, "");
    assert.equal(await deliver(input.memoryCapability, "Stop", { turn_id: "OMIT-TURN-A" }), 401);
    assert.equal(probe.report().memory.status, "failed");
  });
}
test("thrown native run still finishes the memory flow and clears its environment capability", async (t) => {
  const { flow, deliver, probe } = await setup(t, ["root-A"]);
  const input = await flow("root-A");
  const failure = new Error("OMIT-RUN-FAILURE");
  await assert.rejects(runDiagnosticPromptFlow({ ...input, run: async () => { throw failure; } }, {
    readPhase: async () => assert.fail("thrown run read"),
  }), (error) => error === failure);
  assert.equal(input.env.PROBE_MEMORY_CAP, "");
  assert.equal(await deliver(input.memoryCapability, "Stop", { turn_id: "OMIT-TURN-A" }), 401);
  assert.equal(probe.report().memory.status, "failed");
});
for (const [label, settings, failureCode] of [
  ["unregistered root", { register: false }, "MEMORY_HOOK_UNBOUND"],
  ["conflicting prompt/stop turns", { stopTurn: "OMIT-OTHER" }, "CODEX_PROMPT_TARGET_INVALID"],
]) {
  test(`${label} fails before reader spawn and revokes collection`, async (t) => {
    const { flow, deliver } = await setup(t, ["root-A"]);
    const input = await flow("root-A", settings);
    const result = await runDiagnosticPromptFlow(input, { readPhase: async () => assert.fail("untrusted history read") });
    assert.equal(result.memoryFailure ?? result.promptFailure, failureCode);
    assert.equal(result.promptPhase, undefined); assert.equal(result.promptQualification, undefined);
    assert.equal(input.env.PROBE_MEMORY_CAP, "");
    assert.equal(await deliver(input.memoryCapability, "Stop", { turn_id: "OMIT-TURN-A" }), 401);
  });
}
for (const [label, readerError, expectedCode] of [
  ["bounded reader failure", Object.assign(new Error("OMIT-HISTORY"), { code: "CODEX_PROMPT_TIMEOUT" }), "CODEX_PROMPT_TIMEOUT"],
  ["arbitrary reader error", new Error("OMIT-HISTORY"), "CODEX_PROMPT_EVIDENCE_INVALID"],
]) {
  test(`${label} exposes only a stable failure code after capability cleanup`, async (t) => {
    const { flow, deliver } = await setup(t, ["root-A"]);
    const input = await flow("root-A");
    const result = await runDiagnosticPromptFlow(input, { readPhase: async () => { throw readerError; } });
    assert.equal(result.promptFailure, expectedCode); assert.equal(result.promptQualification, undefined);
    assert.equal(result.promptPhase, undefined); assert.equal(input.env.PROBE_MEMORY_CAP, "");
    assert.equal(await deliver(input.memoryCapability, "Stop", { turn_id: "OMIT-TURN-A" }), 401);
    assert.ok(!String(result.promptFailure).includes("OMIT-"));
  });
}
test("resume without prior qualified root phase fails without a history read", async (t) => {
  const { flow } = await setup(t, ["resume-A"]);
  const input = await flow("resume-A");
  const result = await runDiagnosticPromptFlow(input, { readPhase: async () => assert.fail("orphan resume read") });
  assert.equal(result.promptFailure, "CODEX_PROMPT_TARGET_INVALID");
  assert.equal(result.promptQualification, undefined); assert.equal(input.env.PROBE_MEMORY_CAP, "");
});
test("resume cannot publish qualification when native occurrence IDs are reused", async (t) => {
  const { flow } = await setup(t);
  const first = await runDiagnosticPromptFlow(await flow("root-A"), { readPhase: async ({ target }) => phase(target) });
  const second = await runDiagnosticPromptFlow({ ...await flow("resume-A"), priorPhase: first.promptPhase }, {
    readPhase: async ({ target, priorTarget }) => {
      const result = phase(target, priorTarget);
      result.snapshots[1].ids = ["OMIT-PROMPT-A"]; result.snapshots[2].ids = ["OMIT-PROMPT-A"];
      return result;
    },
  });
  assert.equal(second.promptFailure, "CODEX_PROMPT_EVIDENCE_INVALID");
  assert.equal(second.promptQualification, undefined); assert.equal(second.promptPhase, undefined);
});

const cli = (argv) => runClient(process.execPath, [runner, ...argv, "--dry-run"], {
  PATH: dirname(process.execPath), CODEX_HOME: "/nonexistent/probe-home", CLAUDE_CONFIG_DIR: "/nonexistent/probe-home",
  HOME: "/nonexistent/probe-home", USERPROFILE: "/nonexistent/probe-home", CONTEXT_MODE_DIR: "/nonexistent/probe-store",
}, workspace, { timeoutMs: 5000 });
for (const [label, args] of [
  ["production", ["--backend", "production", "--client", "codex"]],
  ["Claude-only", ["--client", "claude", "--hook-type", "command", "--memory-hooks"]],
  ["memory disabled", ["--client", "codex", "--hook-type", "command"]],
]) {
  test(`actual CLI rejects prompt IDs with ${label} before any native work`, async () => {
    const result = await cli([...args, "--codex-prompt-ids"]);
    assert.equal(result.code, 1); assert.equal(result.failure, undefined); assert.equal(result.stdout, "");
  });
}
test("actual opt-in dry-run uses exactly the existing command-memory flow plan", async () => {
  const args = ["--client", "codex", "--hook-type", "command", "--memory-hooks"];
  const baseline = await cli(args), enabled = await cli([...args, "--codex-prompt-ids"]);
  assert.equal(baseline.code, 0); assert.equal(enabled.code, 0); assert.equal(enabled.stdout, baseline.stdout);
  assert.equal(enabled.stdout.trim().split("\n").length, 5);
});

test("actual opt-in preflight starts only hook-list peers and makes no prompt qualification claim", async (t) => {
  const isolated = realpathSync(mkdtempSync(join(tmpdir(), "ctx-prompt-preflight-")));
  t.after(() => rmSync(isolated, { recursive: true, force: true }));
  const fixture = fileURLToPath(new URL("./codex-app-server.fixture.mjs", import.meta.url));
  // Override only process creation before loading the real entrypoint. Existing hook qualification,
  // runner branches and cleanup remain real; Node is the only executable available to this peer.
  const program = `
    import childProcess from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    import { pathToFileURL } from "node:url";
    const originalSpawn = childProcess.spawn;
    let appServerStarts = 0, otherStarts = 0;
    childProcess.spawn = (command, argv, options) => {
      if (command !== process.execPath || argv[0] !== "app-server") {
        otherStarts++; throw new Error("unexpected native invocation");
      }
      appServerStarts++;
      const configArgs = argv.slice(2).filter((arg, index, all) =>
        !arg.startsWith("hooks.state=") && !(arg === "-c" && all[index + 1]?.startsWith("hooks.state=")));
      const hookDeclaration = configArgs.find((arg) => arg.startsWith("hooks.SessionStart="));
      const encodedCommand = hookDeclaration.match(/command=("(?:[^"\\\\]|\\\\.)*")/)[1];
      const spec = { memoryHooks: true, cwd: options.cwd, configArgs, hookCommand: JSON.parse(encodedCommand) };
      return originalSpawn(process.execPath, [${JSON.stringify(fixture)}, ...argv], {
        ...options, env: { ...options.env, PROBE_TEST_SPEC: JSON.stringify(spec) },
      });
    };
    syncBuiltinESMExports();
    process.argv = [process.execPath, ${JSON.stringify(runner)}, "--client", "codex", "--hook-type", "command",
      "--memory-hooks", "--codex-prompt-ids", "--preflight-only", "--codex-bin", process.execPath];
    process.once("beforeExit", () => console.log(JSON.stringify({ appServerStarts, otherStarts })));
    await import(pathToFileURL(${JSON.stringify(runner)}).href);
  `;
  const result = await runClient(process.execPath, ["--input-type=module", "-e", program], {
    PATH: dirname(process.execPath), CODEX_HOME: isolated, CLAUDE_CONFIG_DIR: isolated,
    HOME: isolated, USERPROFILE: isolated, CONTEXT_MODE_DIR: join(isolated, "storage"),
  }, isolated, { timeoutMs: 15_000 });
  assert.equal(result.code, 0); assert.equal(result.failure, undefined);
  const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines, [
    { codexHookTrust: { status: "trusted", discovered: 6, verified: 6 }, modelCalls: 0 },
    { appServerStarts: 2, otherStarts: 0 },
  ]);
  assert.ok(!result.stdout.includes("OMIT-") && !result.stdout.includes(isolated));
});
