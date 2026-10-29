// Synthetic qualification only. No native clients/history, model turns, ingestion or elapsed-speed assertions.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { validateCodexPromptMetadata, projectCodexPromptPage, qualifyCodexPromptIds } from "./codex-prompt-evidence.mjs";
import { readCodexPromptPhase } from "./codex-hook-trust.mjs";
import { createProbeServer } from "./server.mjs";
import { projectMemoryHook } from "./memory-hooks.mjs";

const cwd = process.cwd(), home = "/OMIT-HOME", prompt = "OMIT-SYNTHETIC-PROMPT";
const root = { provider: "codex", home, workspace: cwd, launchId: "l1", flow: "root-A",
  sessionId: "OMIT-ROOT", threadId: "OMIT-ROOT", turnId: "OMIT-TURN-A" };
const resumed = { ...root, flow: "resume-A", turnId: "OMIT-TURN-B" };
const metadata = (extra = {}) => ({ thread: { id: root.threadId, sessionId: root.sessionId, cwd,
  parentThreadId: null, historyMode: "paginated", turns: [], preview: "OMIT-PREVIEW", path: "/OMIT-PATH", ...extra } });
const entry = (id = "OMIT-NATIVE-A", turnId = root.turnId) => ({ turnId,
  item: { type: "userMessage", id, clientId: "OMIT-CLIENT-ID", content: [{ type: "text", text: prompt, text_elements: [] }] },
  startedAtMs: 1, completedAtMs: 2 });
const page = (data = [entry()], nextCursor = null) => ({ data, nextCursor, backwardsCursor: null });
const snapshot = (turnId, ids) => ({ turnId, ids, itemCount: ids.length, matchingPrompts: ids.length, complete: true });
function phases() {
  const a = snapshot(root.turnId, ["OMIT-NATIVE-A"]), b = snapshot(resumed.turnId, ["OMIT-NATIVE-B"]);
  return [{ target: { ...root }, historyMode: "paginated", snapshots: [a, structuredClone(a)] },
    { target: { ...resumed }, historyMode: "paginated", snapshots: [structuredClone(a), b, structuredClone(b)] }];
}
const invalidEvidence = { code: "CODEX_PROMPT_EVIDENCE_INVALID" };

test("metadata requires exact root identity and paginated metadata-only history", () => {
  assert.equal(validateCodexPromptMetadata(metadata(), root), undefined);
});
for (const [label, extra, code] of [
  ["legacy history", { historyMode: "legacy" }, "CODEX_PROMPT_HISTORY_UNSUPPORTED"],
  ["different thread", { id: "OMIT-OTHER" }, "CODEX_PROMPT_EVIDENCE_INVALID"],
  ["different session", { sessionId: "OMIT-OTHER" }, "CODEX_PROMPT_EVIDENCE_INVALID"],
  ["different workspace", { cwd: "/OMIT-OTHER" }, "CODEX_PROMPT_EVIDENCE_INVALID"],
  ["child parent", { parentThreadId: "OMIT-PARENT" }, "CODEX_PROMPT_EVIDENCE_INVALID"],
  ["hydrated history", { turns: [{ id: "OMIT-TURN", items: ["OMIT-CONTENT"] }] }, "CODEX_PROMPT_EVIDENCE_INVALID"],
]) {
  test(`metadata rejects ${label} without echoing history`, () => {
    assert.throws(() => validateCodexPromptMetadata(metadata(extra), root), (error) => {
      assert.equal(error.code, code); assert.ok(!error.message.includes("OMIT-")); return true;
    });
  });
}

test("page projection keeps distinct native IDs for identical text without using clientId", () => {
  const result = projectCodexPromptPage(page([entry("OMIT-NATIVE-A"), entry("OMIT-NATIVE-B")]), root, prompt);
  assert.deepEqual(result, { turnId: root.turnId, ids: ["OMIT-NATIVE-A", "OMIT-NATIVE-B"], itemCount: 2, matchingPrompts: 2, nextCursor: null });
  assert.ok(!JSON.stringify(result).includes(prompt));
  assert.ok(!JSON.stringify(result).includes("OMIT-CLIENT-ID"));
});
test("page projection drops all non-userMessage fields and content immediately", () => {
  const result = projectCodexPromptPage(page([entry(), { turnId: root.turnId, item: {
    type: "mcpToolCall", id: "OMIT-TOOL", arguments: { token: "OMIT-ARGUMENT" }, result: "OMIT-RESULT" } }]), root, prompt);
  assert.deepEqual(result.ids, ["OMIT-NATIVE-A"]); assert.equal(result.itemCount, 2);
  assert.ok(!/OMIT-(TOOL|ARGUMENT|RESULT|CLIENT-ID|SYNTHETIC-PROMPT)/.test(JSON.stringify(result)));
});
for (const [label, mutate] of [
  ["wrong turn", (value) => { value.data[0].turnId = "OMIT-OTHER"; }],
  ["missing native ID despite clientId", (value) => { delete value.data[0].item.id; }],
  ["duplicate ID", (value) => { value.data.push(structuredClone(value.data[0])); }],
  ["oversize native ID", (value) => { value.data[0].item.id = "x".repeat(1025); }],
  ["control-character native ID", (value) => { value.data[0].item.id = "bad\nID"; }],
  ["more than sixteen entries", (value) => { value.data = Array.from({ length: 17 }, (_, i) => entry(`native-${i}`)); }],
  ["oversize cursor", (value) => { value.nextCursor = "x".repeat(4097); }],
  ["missing terminal cursor", (value) => { delete value.nextCursor; }],
]) {
  test(`page projection rejects ${label}`, () => {
    const value = page(); mutate(value);
    assert.throws(() => projectCodexPromptPage(value, root, prompt), invalidEvidence);
  });
}

test("qualification proves repeat reads and resume while keeping unsupported capabilities false", () => {
  const result = qualifyCodexPromptIds(...phases());
  assert.deepEqual(result, { qualified: true, rootOccurrences: 1, resumedOccurrences: 1,
    repeatReadsStable: true, oldTurnStableAfterResume: true, repeatedPromptIdsDistinct: true,
    childPromptsQualified: false, sameTurnSteeringQualified: false, deliveryRetryQualified: false,
    rollbackQualified: false, compactionQualified: false, recoveryConsumptionQualified: false });
  assert.ok(!JSON.stringify(result).includes("OMIT-"));
});
for (const [label, mutate] of [
  ["changed repeated read", (a) => { a.snapshots[1].ids = ["OMIT-CHANGED"]; }],
  ["changed old turn after resume", (_a, b) => { b.snapshots[0].ids = ["OMIT-CHANGED"]; }],
  ["reused ID for a new prompt", (a, b) => { b.snapshots[1].ids = [...a.snapshots[0].ids]; b.snapshots[2].ids = [...a.snapshots[0].ids]; }],
  ["zero occurrences", (a) => { a.snapshots.forEach((value) => { value.ids = []; value.matchingPrompts = 0; value.itemCount = 0; }); }],
  ["wrong provider home", (_a, b) => { b.target.home = "/OMIT-OTHER-HOME"; }],
  ["same turn masquerading as resume", (_a, b) => { b.target.turnId = root.turnId; }],
  ["partial snapshot", (a) => { a.snapshots[0].complete = false; }],
  ["nonmatching synthetic prompt", (a) => { a.snapshots[0].matchingPrompts = 0; }],
]) {
  test(`qualification rejects ${label}`, () => {
    const values = phases(); mutate(...values);
    assert.throws(() => qualifyCodexPromptIds(...values), invalidEvidence);
  });
}

async function trustedFlow(t, { name = "root-A", registered = true, promptTurn = root.turnId, stopTurn = root.turnId, agent } = {}) {
  const launchCap = "OMIT-LAUNCH-CAP";
  const probe = createProbeServer({ launches: [{ provider: "codex", home, workspace: cwd, capability: launchCap }],
    memoryHooks: { flows: [{ provider: "codex", name }] } });
  t.after(() => probe.close());
  const port = await probe.listen();
  const post = async (path, body, cap) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { authorization: `Bearer ${cap}`, "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  };
  const hook = (event, turn) => ({ hook_event_name: event, session_id: root.sessionId, cwd, ...(turn ? { turn_id: turn } : {}), ...(agent ? { agent_id: agent } : {}) });
  if (registered) {
    assert.equal((await post("/hook", hook("SessionStart"), launchCap)).status, 200);
    assert.ok((await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "identity_echo", arguments: {}, _meta: { sessionId: root.sessionId, threadId: root.threadId } } }, launchCap)).body.result);
  }
  const cap = probe.beginMemoryFlow(launchCap, name);
  for (const [event, turn] of [["UserPromptSubmit", promptTurn], ["Stop", stopTurn]]) {
    if (turn === null) continue;
    assert.equal((await post("/hook", { memory: projectMemoryHook("codex", JSON.stringify(hook(event, turn))) }, cap)).status, 202);
  }
  return { probe, cap, post };
}
test("trusted root turn target returns internally before summary clears observations, never over HTTP", async (t) => {
  const { probe, cap, post } = await trustedFlow(t);
  const target = probe.finishMemoryFlow(cap, root.sessionId, true, { codexPromptTarget: true });
  assert.deepEqual(target, root);
  assert.equal(probe.report().memory.status, "complete");
  assert.ok(!JSON.stringify(probe.report()).includes("OMIT-"));
  assert.equal((await post("/hook", {}, cap)).status, 401);
});
for (const [label, options, code] of [
  ["missing Stop", { stopTurn: null }, "CODEX_PROMPT_TARGET_INVALID"],
  ["inconsistent prompt and Stop", { stopTurn: "OMIT-OTHER-TURN" }, "CODEX_PROMPT_TARGET_INVALID"],
  ["unregistered owner", { registered: false }, "MEMORY_HOOK_UNBOUND"],
  ["unqualified root-B flow", { name: "root-B" }, "CODEX_PROMPT_TARGET_INVALID"],
  ["unresolved child", { agent: "OMIT-CHILD" }, "MEMORY_HOOK_UNBOUND"],
]) {
  test(`no native-reader target for ${label}`, async (t) => {
    const { probe, cap, post } = await trustedFlow(t, options);
    assert.throws(() => probe.finishMemoryFlow(cap, root.sessionId, true, { codexPromptTarget: true }), { code });
    assert.equal((await post("/hook", {}, cap)).status, 401);
    assert.ok(!JSON.stringify(probe.report()).includes("OMIT-"));
  });
}

const fixture = fileURLToPath(new URL("./codex-app-server.fixture.mjs", import.meta.url));
const configArgs = ["-c", "features.hooks=true", "-c", 'hooks.state={"reviewed"={enabled=true,trusted_hash="synthetic"}}'];
function readerOptions(mode = "valid", target = root, extra = {}) {
  const priorTarget = target.flow === "resume-A" ? root : undefined;
  return { command: process.execPath, commandPrefix: [fixture], configArgs, cwd, target, priorTarget, expectedPrompt: prompt,
    env: { ...process.env, CODEX_HOME: home, PROBE_TEST_SPEC: JSON.stringify({ promptRead: true, mode, configArgs, cwd, target, priorTarget, expectedPrompt: prompt }) }, ...extra };
}
test("reader rejects absent, ambiguous or mismatched launch targets before spawning", async () => {
  const invalid = [undefined, [root, resumed], { ...root, turnId: "" }, { ...root, threadId: "OMIT-CHILD" },
    { ...root, flow: "child" }, { ...root, provider: "claude" }, { ...root, home: "/OMIT-OTHER" }, { ...root, workspace: "/OMIT-OTHER" }];
  for (const target of invalid) {
    let spawns = 0;
    await assert.rejects(readCodexPromptPhase({ ...readerOptions(), target,
      spawnProcess: () => { spawns++; throw new Error("OMIT-FORBIDDEN-SPAWN"); } }), { code: "CODEX_PROMPT_TARGET_INVALID" });
    assert.equal(spawns, 0);
  }
});
test("root and resume reuse exact one-shot reader and need seven children on single-page path", async () => {
  const children = [];
  const spawnProcess = (command, argv, options) => {
    assert.ok(children.every((child) => child.exitCode !== null || child.signalCode !== null));
    assert.deepEqual(argv, [fixture, "app-server", "--stdio", ...configArgs]);
    assert.equal(options.cwd, cwd); assert.equal(options.env.CODEX_HOME, home);
    const child = spawn(command, argv, options); children.push(child); return child;
  };
  const first = await readCodexPromptPhase(readerOptions("valid", root, { spawnProcess }));
  assert.equal(children.length, 3); assert.equal(first.snapshots.length, 2);
  const second = await readCodexPromptPhase(readerOptions("valid", resumed, { spawnProcess }));
  assert.equal(children.length, 7); assert.equal(second.snapshots.length, 3);
  assert.ok(children.every((child) => child.exitCode !== null || child.signalCode !== null));
  assert.equal(qualifyCodexPromptIds(first, second).qualified, true);
  for (const result of [first, second]) assert.ok(!JSON.stringify(result).includes(prompt));
});
test("reader follows opaque pages and returns only native IDs and counts", async () => {
  const result = await readCodexPromptPhase(readerOptions("two-pages"));
  assert.equal(result.snapshots[0].ids.length, 2);
  assert.equal(result.snapshots[0].complete, true);
  assert.ok(!/OMIT-(CLIENT-ID|PREVIEW|HISTORY-PATH|SYNTHETIC-PROMPT)/.test(JSON.stringify(result)));
});
for (const [mode, code] of [["page-overflow", "CODEX_PROMPT_LIMIT"], ["cursor-loop", "CODEX_PROMPT_EVIDENCE_INVALID"],
  ["wrong-turn", "CODEX_PROMPT_EVIDENCE_INVALID"], ["zero", "CODEX_PROMPT_EVIDENCE_INVALID"],
  ["large-page", "HOOK_TRUST_OUTPUT_LIMIT"], ["legacy", "CODEX_PROMPT_HISTORY_UNSUPPORTED"]]) {
  test(`reader rejects ${mode} without retaining or logging native content`, async () => {
    let spawns = 0;
    await assert.rejects(readCodexPromptPhase(readerOptions(mode, root, { spawnProcess: (...args) => { spawns++; return spawn(...args); } })), (error) => {
      assert.equal(error.code, code); assert.ok(!error.message.includes("OMIT-")); return true;
    });
    assert.ok(spawns > 0 && spawns <= 5); // Metadata plus at most four pages; never a fifth page.
    if (mode === "legacy") assert.equal(spawns, 1); // No full-history or pagination fallback.
  });
}
test("one phase deadline includes all RPC children and their cleanup", async () => {
  let now = 0;
  const children = [];
  const spawnProcess = (...args) => {
    const child = spawn(...args); children.push(child);
    child.on("close", () => { now += 10_001; });
    return child;
  };
  await assert.rejects(readCodexPromptPhase(readerOptions("valid", root, { now: () => now, spawnProcess })), { code: "CODEX_PROMPT_TIMEOUT" });
  assert.equal(children.length, 3);
  assert.ok(children.every((child) => child.exitCode !== null || child.signalCode !== null));
});

test("default phase clock cannot gain time from a backward wall-clock adjustment", async (t) => {
  let monotonic = 0, wall = 20_000;
  t.mock.method(performance, "now", () => monotonic);
  t.mock.method(Date, "now", () => wall);
  const children = [];
  const spawnProcess = (...args) => {
    const child = spawn(...args); children.push(child);
    child.on("close", () => {
      monotonic += 10_001;
      // The second completed RPC moves wall time backward, while elapsed time advances.
      wall += children.length === 2 ? -10_000 : 10_001;
    });
    return child;
  };
  // Deliberately omit options.now: this checks the production default clock choice.
  await assert.rejects(readCodexPromptPhase(readerOptions("valid", root, { spawnProcess })), { code: "CODEX_PROMPT_TIMEOUT" });
  assert.equal(children.length, 3);
  assert.equal(monotonic, 30_003);
  assert.equal(wall, 30_002);
  assert.ok(children.every((child) => child.exitCode !== null || child.signalCode !== null));
});

test("cleanup timer cannot extend a native-reader phase beyond its remaining deadline", async () => {
  let now = 0;
  const children = [], cleanup = [];
  const spawnProcess = (...args) => {
    const child = spawn(...args); children.push(child);
    if (children.length === 3) child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("fixture/ready")) now = 29_900;
    });
    child.on("close", () => { now += 9_500; });
    return child;
  };
  await assert.rejects(readCodexPromptPhase(readerOptions("valid", root, {
    now: () => now, spawnProcess,
    scheduleCleanupTimeout: (_callback, delay) => { cleanup.push({ delay, remaining: 30_000 - now }); return cleanup.length; },
    cancelCleanupTimeout: () => {},
  })), { code: "CODEX_PROMPT_TIMEOUT" });
  assert.equal(children.length, 3); assert.equal(cleanup.length, 3);
  assert.ok(cleanup.every(({ delay, remaining }) => delay > 0 && delay <= remaining));
  assert.ok(children.every((child) => child.exitCode !== null || child.signalCode !== null));
});
