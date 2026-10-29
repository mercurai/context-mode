// Stop timing qualification: real loopback identity state, synthetic reader peers, deterministic clocks.
// No installed client, model call, operational history or memory-store write.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createProbeServer } from "./server.mjs";
import { projectMemoryHook } from "./memory-hooks.mjs";
import { readCodexPromptPhase } from "./codex-hook-trust.mjs";
import { runClient, validateCodexPromptStopOptions } from "./run.mjs";

const workspace = process.platform === "win32" ? process.cwd().toLowerCase() : process.cwd();
const home = "/OMIT-HOME", root = "OMIT-ROOT", other = "OMIT-OTHER", turn = "OMIT-TURN-A";
const launchCap = "OMIT-LAUNCH", prompt = "OMIT-SYNTHETIC-PROMPT";
const selected = { codexPromptStop: true, codexPromptIds: true, backend: "diagnostic",
  which: "codex", hookType: "command", memoryHooks: true };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

test("Stop option is disabled by default and requires the existing prompt-ID qualification", () => {
  assert.equal(validateCodexPromptStopOptions({}), false);
  assert.equal(validateCodexPromptStopOptions(selected), true);
  assert.throws(() => validateCodexPromptStopOptions({ ...selected, codexPromptIds: false }), { code: "CODEX_PROMPT_STOP_OPTIONS_INVALID" });
  assert.throws(() => validateCodexPromptStopOptions({ ...selected, which: "claude" }), { code: "CODEX_PROMPT_STOP_OPTIONS_INVALID" });
});

async function setup(t, { names = ["root-A", "resume-A"], read = async () => {}, enabled = true } = {}) {
  let now = 0;
  const probe = createProbeServer({ launches: [{ provider: "codex", home, workspace, capability: launchCap }],
    memoryHooks: { flows: names.map((name) => ({ provider: "codex", name })) },
    ...(enabled ? { codexPromptStop: { read, now: () => now } } : {}) });
  const port = await probe.listen();
  t.after(() => probe.close());
  async function post(path, body, cap = launchCap, signal = AbortSignal.timeout(5000)) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", redirect: "error",
      headers: { "content-type": "application/json", authorization: `Bearer ${cap}` },
      body: JSON.stringify(body), signal });
    return { status: response.status, body: await response.json() };
  }
  const native = (event, fields = {}) => ({ hook_event_name: event, session_id: root, cwd: workspace, ...fields });
  const envelope = (event, fields) => ({ memory: projectMemoryHook("codex", JSON.stringify(native(event, fields))) });
  const deliver = (cap, event, fields, signal) => post("/hook", envelope(event, fields), cap, signal);
  async function register(id = root) {
    assert.equal((await post("/hook", native("SessionStart", { session_id: id }))).status, 200);
  }
  async function call(id = root) {
    const result = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "identity_echo", arguments: {}, _meta: { threadId: id, sessionId: id },
    } });
    assert.equal(result.status, 200); assert.ok(result.body.result);
  }
  async function begin(name = "root-A", turnId = turn) {
    const cap = probe.beginMemoryFlow(launchCap, name);
    assert.equal((await deliver(cap, "UserPromptSubmit", { turn_id: turnId })).status, 202);
    return cap;
  }
  return { probe, port, register, call, begin, deliver, envelope, time: (value) => { now = value; } };
}

test("Stop derives its reader target from this invocation's actual bound root and final native identity", async (t) => {
  const reads = [];
  const f = await setup(t, { read: async (target, options) => { reads.push({ target, options }); } });
  await f.register();
  for (const [name, turnId] of [["root-A", turn], ["resume-A", "OMIT-TURN-B"]]) {
    const cap = await f.begin(name, turnId); await f.call();
    assert.equal(reads.length, name === "root-A" ? 0 : 1);
    assert.equal((await f.deliver(cap, "Stop", { turn_id: turnId })).status, 202);
    assert.deepEqual(reads.at(-1), { target: { provider: "codex", home, workspace, launchId: "l1",
      sessionId: root, threadId: root, flow: name, turnId }, options: { phaseBudgetMs: 8000 } });
    f.probe.finishMemoryFlow(cap, root, true, { codexPromptTarget: true });
  }
  assert.deepEqual(f.probe.report().codexPromptStop, { status: "complete", reads: 2, nativeMatches: 2 });
  assert.ok(!JSON.stringify(f.probe.report()).includes("OMIT-"));
});

for (const [label, arrange, fields] of [
  ["registration without any MCP proof", async (f) => { await f.register(); return f.begin(); }, {}],
  ["historical MCP call before this invocation", async (f) => { await f.register(); await f.call(); return f.begin(); }, {}],
  ["hook root conflicting with the current MCP root", async (f) => { await f.register(); await f.register(other); const cap = await f.begin(); await f.call(); return cap; }, { session_id: other }],
  ["ambiguous current MCP roots", async (f) => { await f.register(); await f.register(other); const cap = await f.begin(); await f.call(); await f.call(other); return cap; }, {}],
  ["Stop turn conflicting with its prompt", async (f) => { await f.register(); const cap = await f.begin(); await f.call(); return cap; }, { turn_id: "OMIT-OTHER-TURN" }],
  ["child claim on a root flow", async (f) => { await f.register(); const cap = await f.begin(); await f.call(); return cap; }, { agent_id: "OMIT-CHILD" }],
]) {
  test(`${label} is rejected before any history read`, async (t) => {
    let reads = 0;
    const f = await setup(t, { read: async () => { reads++; } });
    const cap = await arrange(f);
    assert.equal((await f.deliver(cap, "Stop", { turn_id: turn, ...fields })).status, 409);
    assert.equal(reads, 0); assert.equal(f.probe.report().codexPromptStop.status, "failed");
    assert.ok(!JSON.stringify(f.probe.report()).includes("OMIT-"));
  });
}

test("disabled mode and unselected flows never enter Stop reading", async (t) => {
  for (const [enabled, name] of [[false, "root-A"], [true, "root-B"]]) {
    let reads = 0;
    const f = await setup(t, { enabled, names: [name], read: async () => { reads++; } });
    await f.register(); const cap = await f.begin(name); await f.call();
    assert.equal((await f.deliver(cap, "Stop", { turn_id: turn })).status, 202);
    f.probe.finishMemoryFlow(cap, root, true);
    assert.equal(reads, 0);
    if (!enabled) assert.equal(Object.hasOwn(f.probe.report(), "codexPromptStop"), false);
  }
});

test("body delivery consumes the same eight-second budget before reader admission", async (t) => {
  const budgets = [];
  const f = await setup(t, { read: async (_target, { phaseBudgetMs }) => { budgets.push(phaseBudgetMs); } });
  await f.register(); const cap = await f.begin(); await f.call();
  const arrived = deferred(); f.probe.server.once("request", () => arrived.resolve());
  const response = deferred();
  const request = http.request({ hostname: "127.0.0.1", port: f.port, path: "/hook", method: "POST",
    headers: { authorization: `Bearer ${cap}`, "content-type": "application/json" } }, (reply) => {
    reply.resume(); reply.on("end", () => response.resolve(reply.statusCode));
  });
  request.on("error", () => response.resolve(0)); t.after(() => request.destroy());
  request.flushHeaders(); await arrived.promise;
  f.time(3000); request.end(JSON.stringify(f.envelope("Stop", { turn_id: turn })));
  assert.equal(await response.promise, 202); assert.deepEqual(budgets, [5000]);
});

test("an expired request budget never starts a reader", async (t) => {
  let reads = 0;
  const f = await setup(t, { read: async () => { reads++; } });
  await f.register(); const cap = await f.begin(); await f.call();
  const arrived = deferred(); f.probe.server.once("request", () => arrived.resolve());
  const response = deferred();
  const request = http.request({ hostname: "127.0.0.1", port: f.port, path: "/hook", method: "POST",
    headers: { authorization: `Bearer ${cap}`, "content-type": "application/json" } }, (reply) => {
    reply.resume(); reply.on("end", () => response.resolve(reply.statusCode));
  });
  request.on("error", () => response.resolve(0)); t.after(() => request.destroy());
  request.flushHeaders(); await arrived.promise;
  f.time(8001); request.end(JSON.stringify(f.envelope("Stop", { turn_id: turn })));
  assert.equal(await response.promise, 503); assert.equal(reads, 0);
  assert.equal(f.probe.report().codexPromptStop.failure, "CODEX_PROMPT_TIMEOUT");
});

test("reader overrun and arbitrary failure cannot produce visible-at-Stop success", async (t) => {
  for (const mode of ["overrun", "error"]) {
    const f = await setup(t, { read: async () => {
      if (mode === "error") throw new Error("OMIT-HISTORY-CONTENT");
      f.time(8001);
    } });
    await f.register(); const cap = await f.begin(); await f.call();
    assert.equal((await f.deliver(cap, "Stop", { turn_id: turn })).status, 503);
    assert.deepEqual(f.probe.report().codexPromptStop, { status: "failed",
      failure: mode === "overrun" ? "CODEX_PROMPT_TIMEOUT" : "CODEX_PROMPT_EVIDENCE_INVALID" });
    assert.ok(!JSON.stringify(f.probe.report()).includes("OMIT-"));
  }
});

async function pendingRead(t) {
  const entered = deferred(), released = deferred();
  let reads = 0;
  // Register release before server cleanup so a failed assertion cannot deadlock close().
  t.after(() => released.resolve());
  const f = await setup(t, { read: async () => { reads++; entered.resolve(); await released.promise; } });
  await f.register(); const cap = await f.begin(); await f.call();
  const controller = new AbortController();
  const disconnected = deferred();
  f.probe.server.once("request", (_request, response) => response.once("close", disconnected.resolve));
  const response = f.deliver(cap, "Stop", { turn_id: turn }, controller.signal).catch(() => ({ status: 0 }));
  t.after(async () => { released.resolve(); await response; });
  // This races only observations, never abandons a reader: teardown always releases and joins response.
  assert.equal(await Promise.race([entered.promise.then(() => true), response.then(() => false)]), true);
  return { ...f, cap, response, release: released.resolve, disconnect: () => controller.abort(),
    disconnected: disconnected.promise, reads: () => reads };
}

test("one global Stop reader rejects a concurrent request and drains its owned work", async (t) => {
  const f = await pendingRead(t);
  const secondCap = await f.begin("resume-A", "OMIT-TURN-B"); await f.call();
  assert.equal((await f.deliver(secondCap, "Stop", { turn_id: "OMIT-TURN-B" })).status, 429);
  assert.equal(f.reads(), 1);
  f.release(); await f.response;
  assert.equal(f.probe.report().codexPromptStop.status, "failed");
});

test("revocation during a Stop read invalidates its result", async (t) => {
  const f = await pendingRead(t);
  f.probe.finishMemoryFlow(f.cap, undefined, false);
  f.release(); assert.equal((await f.response).status, 409);
  assert.equal(f.probe.report().codexPromptStop.status, "failed");
});

test("a disconnected Stop request cannot publish the reader's late success", async (t) => {
  const f = await pendingRead(t);
  f.disconnect(); assert.equal((await f.response).status, 0);
  await f.disconnected;
  f.release(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.probe.report().codexPromptStop.status, "failed");
});

test("shutdown waits for admitted Stop cleanup and never publishes its late result", async (t) => {
  const f = await pendingRead(t);
  let closed = false;
  const close = f.probe.close().then(() => { closed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  f.release(); await close; await f.response;
  assert.equal(closed, true); assert.deepEqual(f.probe.report().codexPromptStop, { status: "closed" });
});

test("duplicate Stop does not start another reader", async (t) => {
  let reads = 0;
  const f = await setup(t, { read: async () => { reads++; } });
  await f.register(); const cap = await f.begin(); await f.call();
  assert.equal((await f.deliver(cap, "Stop", { turn_id: turn })).status, 202);
  assert.equal((await f.deliver(cap, "Stop", { turn_id: turn })).status, 409);
  assert.equal(reads, 1); assert.equal(f.probe.report().codexPromptStop.status, "failed");
});

test("native completion must match the root whose history was read", async (t) => {
  const f = await setup(t);
  await f.register(); await f.register(other); const cap = await f.begin(); await f.call();
  assert.equal((await f.deliver(cap, "Stop", { turn_id: turn })).status, 202);
  assert.throws(() => f.probe.finishMemoryFlow(cap, other, true, { codexPromptTarget: true }), { code: "CODEX_PROMPT_STOP_IDENTITY" });
  assert.equal(f.probe.report().codexPromptStop.status, "failed");
});

const fixture = fileURLToPath(new URL("./codex-app-server.fixture.mjs", import.meta.url));
const target = { provider: "codex", home, workspace, launchId: "l1", sessionId: root, threadId: root, flow: "root-A", turnId: turn };
function reader(extra = {}) {
  return { command: process.execPath, commandPrefix: [fixture], configArgs: [], cwd: workspace,
    target, expectedPrompt: prompt, env: { CODEX_HOME: home, PROBE_TEST_SPEC: JSON.stringify({ promptRead: true,
      mode: "valid", configArgs: [], cwd: workspace, target, expectedPrompt: prompt }) }, ...extra };
}
test("reader optional phase budget bounds all RPCs and cleanup without changing the default", async () => {
  for (const phaseBudgetMs of [8000, undefined]) {
    let now = 0; const children = [];
    const options = reader({ now: () => now, spawnProcess: (...args) => {
      const child = spawn(...args); children.push(child); child.on("close", () => { now += 3000; }); return child;
    }, ...(phaseBudgetMs === undefined ? {} : { phaseBudgetMs }) });
    if (phaseBudgetMs === undefined) assert.equal((await readCodexPromptPhase(options)).snapshots.length, 2);
    else await assert.rejects(readCodexPromptPhase(options), { code: "CODEX_PROMPT_TIMEOUT" });
    assert.equal(children.length, 3);
    assert.ok(children.every((child) => child.exitCode !== null || child.signalCode !== null));
  }
});
test("reader refuses invalid phase budgets before process creation", async () => {
  let starts = 0;
  for (const phaseBudgetMs of [0, -1, NaN, Infinity, 30_001]) {
    await assert.rejects(readCodexPromptPhase(reader({ phaseBudgetMs,
      spawnProcess: () => { starts++; throw new Error("unexpected child"); } })), { code: "CODEX_PROMPT_TARGET_INVALID" });
  }
  assert.equal(starts, 0);
});

test("actual CLI Stop opt-in preserves the existing dry-run plan and rejects missing prompt-ID opt-in", async () => {
  const runner = fileURLToPath(new URL("./run.mjs", import.meta.url));
  const env = { PATH: dirname(process.execPath), CODEX_HOME: "/nonexistent/probe-home", CLAUDE_CONFIG_DIR: "/nonexistent/probe-home",
    HOME: "/nonexistent/probe-home", USERPROFILE: "/nonexistent/probe-home", CONTEXT_MODE_DIR: "/nonexistent/probe-store" };
  const args = [runner, "--client", "codex", "--memory-hooks", "--hook-type", "command", "--dry-run"];
  const baseline = await runClient(process.execPath, [...args, "--codex-prompt-ids"], env, workspace);
  const enabled = await runClient(process.execPath, [...args, "--codex-prompt-ids", "--codex-prompt-stop"], env, workspace);
  const invalid = await runClient(process.execPath, [...args, "--codex-prompt-stop"], env, workspace);
  assert.equal(baseline.code, 0); assert.equal(enabled.code, 0); assert.equal(enabled.stdout, baseline.stdout);
  assert.equal(invalid.code, 1); assert.equal(invalid.stdout, "");
});
