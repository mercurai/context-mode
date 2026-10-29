// Synthetic protocol fixtures only. Never load native homes or persist client output.
import test from "node:test";
import assert from "node:assert/strict";
import { parseNativeEvidence, parseCodexChildEvidence, parseCodexParentEvidence, verifyToolEvidence } from "./production-evidence.mjs";

const session = "synthetic-root", child = "synthetic-child", cwd = "/synthetic/workspace";
const marker = "orchardalphafruit", foreign = "orchardbetafruit";
const textResult = (text) => ({ content: [{ type: "text", text }] });
const calls = () => [
  { id: "index-1", name: "ctx_index", args: { content: `Orchard ${marker}.`, source: "probe" }, text: "Indexed 1 sections from: probe" },
  { id: "search-1", name: "ctx_search", args: { queries: ["orchard"], limit: 20 }, text: `Orchard ${marker}.` },
  { id: "stats-1", name: "ctx_stats", args: {}, text: "context-mode: 2 calls" },
];
function codexEvents(items = calls()) {
  return [{ type: "thread.started", thread_id: session }, ...items.map((call) => ({ type: "item.completed", item: {
    id: call.id, type: "mcp_tool_call", server: "probe", tool: call.name, arguments: call.args,
    status: "completed", result: textResult(call.text), error: null,
  } })), { type: "turn.completed", usage: {} }];
}
function claudeEvents(items = calls(), parent = null) {
  return items.flatMap((call) => [
    { type: "assistant", session_id: session, parent_tool_use_id: parent, message: { content: [
      { type: "tool_use", id: call.id, name: `mcp__probe__${call.name}`, input: call.args },
    ] } },
    { type: "user", session_id: session, parent_tool_use_id: parent, message: { content: [
      { type: "tool_result", tool_use_id: call.id, content: [{ type: "text", text: call.text }], is_error: false },
    ] } },
  ]);
}
const claudeComplete = (events = claudeEvents()) => [
  { type: "system", subtype: "init", session_id: session }, ...events,
  { type: "result", subtype: "success", is_error: false, session_id: session, result: "done" },
];
const parse = (client, events, extra = {}) => parseNativeEvidence({ client, stdout: events.map((v) => JSON.stringify(v)).join("\n"), ...extra });
const expectCalls = (evidence) => {
  assert.equal(evidence.sessionId, session);
  assert.deepEqual(evidence.calls, calls().map((call) => ({ ...call, owner: "root" })));
  assert.deepEqual(evidence.children, []);
};

for (const client of ["codex", "claude"]) {
  test(`${client}: completed native tool results retain private correlation, not final prose`, () => {
    expectCalls(parse(client, client === "codex" ? codexEvents() : claudeComplete(), { expectedSessionId: session }));
  });
  test(`${client}: resume must return the exact requested native conversation`, () => {
    assert.throws(() => parse(client, client === "codex" ? codexEvents() : claudeComplete(),
      { expectedSessionId: "other-root" }), { code: "PRODUCTION_EVIDENCE_INVALID" });
  });
  test(`${client}: malformed or excessive native output fails with redacted error`, () => {
    for (const stdout of ["synthetic private invalid json", "x".repeat(101)]) {
      assert.throws(() => parseNativeEvidence({ client, stdout, maxOutputBytes: 100 }), (error) => {
        assert.equal(error.code, "PRODUCTION_EVIDENCE_INVALID");
        assert.ok(!error.message.includes("private") && !error.message.includes("xxx"));
        return true;
      });
    }
  });
}

test("Claude joins interleaved tool results by tool_use_id and exact parent tool lineage", () => {
  const rootCalls = calls(), childCalls = calls().map((call) => ({ ...call, id: `child-${call.id}` }));
  const events = claudeEvents(rootCalls);
  events.push({ type: "assistant", session_id: session, parent_tool_use_id: null, message: { content: [
    { type: "tool_use", id: "agent-call", name: "Agent", input: { prompt: "synthetic omitted" } },
  ] } });
  const kid = claudeEvents(childCalls, "agent-call");
  events.push({ type: "user", session_id: session, parent_tool_use_id: "agent-call",
    message: { content: "Forwarded synthetic child prompt, not tool evidence" } });
  // Two starts followed by their reverse-order results tests correlation, not adjacent pairs.
  events.push(kid[0], kid[2], kid[3], kid[1], ...kid.slice(4));
  events.push({ type: "user", session_id: session, parent_tool_use_id: null, message: { content: [
    { type: "tool_result", tool_use_id: "agent-call", content: "done", is_error: false },
  ] } });
  const evidence = parse("claude", claudeComplete(events));
  assert.deepEqual(evidence.children, [{ id: "agent-call", parentId: session }]);
  assert.equal(evidence.calls.filter((call) => call.owner === "agent-call").length, 3);
  assert.deepEqual(evidence.calls.find((call) => call.id === "child-index-1").args, rootCalls[0].args);
});

for (const name of ["Agent", "Task"]) {
  for (const mode of ["missing", "failed"]) {
    test(`Claude ${name} requires its own successful terminal result: ${mode}`, () => {
      const events = [{ type: "assistant", session_id: session, parent_tool_use_id: null, message: { content: [
        { type: "tool_use", id: "agent-call", name, input: { prompt: "synthetic" } },
      ] } }, ...claudeEvents(calls(), "agent-call")];
      if (mode === "failed") events.push({ type: "user", session_id: session, parent_tool_use_id: null, message: { content: [
        { type: "tool_result", tool_use_id: "agent-call", content: "synthetic failure", is_error: true },
      ] } });
      assert.throws(() => parse("claude", claudeComplete(events)), { code: "PRODUCTION_EVIDENCE_INVALID" });
    });
  }
}

for (const mode of ["unknown-result", "duplicate-result", "missing-result", "failed-result", "wrong-parent", "unknown-parent", "failed-turn"]) {
  test(`Claude rejects ${mode} instead of accepting the assistant's summary`, () => {
    const events = claudeComplete();
    if (mode === "unknown-result") events[2].message.content[0].tool_use_id = "unseen";
    if (mode === "duplicate-result") events.splice(3, 0, structuredClone(events[2]));
    if (mode === "missing-result") events.splice(2, 1);
    if (mode === "failed-result") events[2].message.content[0].is_error = true;
    if (mode === "wrong-parent") events[2].parent_tool_use_id = "different";
    if (mode === "unknown-parent") { events[1].parent_tool_use_id = "unseen"; events[2].parent_tool_use_id = "unseen"; }
    if (mode === "failed-turn") events.at(-1).is_error = true;
    assert.throws(() => parse("claude", events), { code: "PRODUCTION_EVIDENCE_INVALID" });
  });
}

test("Codex records only exact completed spawn ids for later read-only child lookup", () => {
  const events = codexEvents();
  events.splice(-1, 0, { type: "item.completed", item: { type: "collab_tool_call", id: "spawn-1",
    tool: "spawn_agent", status: "completed", sender_thread_id: session, receiver_thread_ids: [child],
    agents_states: { [child]: { status: "running", message: null } } } });
  const evidence = parse("codex", events);
  assert.deepEqual(evidence.children, [{ id: child, parentId: session }]);
  assert.equal(evidence.calls.length, 3); // Child prose is never a child tool result.
});

for (const mode of ["failed-tool", "duplicate-tool", "wrong-server", "missing-completion", "conflicting-thread"]) {
  test(`Codex rejects ${mode} native evidence`, () => {
    const events = codexEvents();
    if (mode === "failed-tool") events[1].item.status = "failed";
    if (mode === "duplicate-tool") events.splice(2, 0, structuredClone(events[1]));
    if (mode === "wrong-server") events[1].item.server = "foreign";
    if (mode === "missing-completion") events.pop();
    if (mode === "conflicting-thread") events.splice(1, 0, { type: "thread.started", thread_id: "foreign" });
    assert.throws(() => parse("codex", events), { code: "PRODUCTION_EVIDENCE_INVALID" });
  });
}

function parentResponse() {
  return { thread: { id: session, cwd, model: "synthetic-model", preview: "private parent prose",
    path: "/private/native-history", turns: [{ id: "parent-turn", itemsView: "full", status: "completed", error: null,
      items: [{ type: "subAgentActivity", id: "spawn-native", kind: "started", agentThreadId: child,
        agentPath: "/root/probe_child", model: "synthetic-model", reasoningEffort: null },
      { type: "subAgentActivity", id: "complete-native", kind: "completed", agentThreadId: child,
        agentPath: "/root/probe_child", model: null, reasoningEffort: null },
      { type: "agentMessage", id: "prose", text: "private parent output" }] }] } };
}
test("Codex exact-parent V2 projection keeps native child identity and drops raw history", () => {
  assert.deepEqual(parseCodexParentEvidence(parentResponse(), { parentId: session, cwd }), {
    sessionId: session, model: "synthetic-model", children: [{ id: child, parentId: session }],
    startedActivities: 1, completedActivities: 1,
  });
});
test("Codex parent activity permits absent completion notification without claiming child completion", () => {
  const response = parentResponse();
  response.thread.turns[0].items.splice(1, 1);
  const evidence = parseCodexParentEvidence(response, { parentId: session, cwd });
  assert.equal(evidence.startedActivities, 1);
  assert.equal(evidence.completedActivities, 0);
  assert.deepEqual(evidence.children, [{ id: child, parentId: session }]);
  assert.equal(evidence.calls, undefined);
});
// Pinned native V2 wait.rs:113-129 emits a completed mailbox wait with no receivers.
// Wire enums/fields: rust-v0.164.0 app-server-protocol/schema/typescript/v2/ThreadItem.ts,
// CollabAgentTool.ts and CollabAgentToolCallStatus.ts. A completed wait is not child completion.
function nativeV2Wait() {
  return { type: "collabAgentToolCall", id: "native-wait", tool: "wait", status: "completed",
    senderThreadId: session, receiverThreadIds: [], prompt: null, model: null, reasoningEffort: null,
    agentsStates: {} };
}
test("Codex exact-parent V2 accepts documented completed mailbox wait alongside native spawn activity", () => {
  const response = parentResponse();
  response.thread.turns[0].items.push(nativeV2Wait());
  assert.deepEqual(parseCodexParentEvidence(response, { parentId: session, cwd }), {
    sessionId: session, model: "synthetic-model", children: [{ id: child, parentId: session }],
    startedActivities: 1, completedActivities: 1,
  });
});
test("Codex completed V2 mailbox wait never supplies missing native started child proof", () => {
  const response = parentResponse();
  response.thread.turns[0].items = [nativeV2Wait()];
  assert.throws(() => parseCodexParentEvidence(response, { parentId: session, cwd }), (error) => {
    assert.equal(error.code, "PRODUCTION_EVIDENCE_INVALID");
    assert.equal(error.parentValidationReason, "activity-cardinality"); return true;
  });
});
for (const mode of ["wrong-sender", "receiver-child", "agent-state", "failed", "inProgress", "interrupted", "duplicate"]) {
  test("Codex V2 mailbox wait compatibility rejects " + mode, () => {
    const response = parentResponse(), wait = nativeV2Wait();
    if (mode === "wrong-sender") wait.senderThreadId = "private-other-parent";
    if (mode === "receiver-child") wait.receiverThreadIds = ["private-other-child"];
    if (mode === "agent-state") wait.agentsStates = { private: { status: "completed", message: "private output" } };
    if (["failed", "inProgress", "interrupted"].includes(mode)) wait.status = mode;
    response.thread.turns[0].items.push(wait);
    if (mode === "duplicate") response.thread.turns[0].items.push({ ...wait });
    assert.throws(() => parseCodexParentEvidence(response, { parentId: session, cwd }), (error) => {
      assert.equal(error.code, "PRODUCTION_EVIDENCE_INVALID");
      assert.ok(!JSON.stringify(error).includes("private")); return true;
    });
  });
}
for (const [mode, reason] of Object.entries({
  "wrong-parent": "parent-id", "wrong-cwd": "workspace", "invalid-model": "model",
  "missing-turns": "turns", "empty-turns": "turns", "invalid-turn": "turn-shape",
  "partial-turn": "turn-shape", "running-turn": "turn-shape", "error-turn": "turn-shape",
  "duplicate-turn": "turn-shape", "missing-turn-id": "turn-shape", "invalid-item": "item-shape",
  "zero-children": "activity-cardinality", "multiple-children": "activity-cardinality",
  "duplicate-start": "activity-cardinality", "duplicate-item": "activity-shape",
  "malformed-activity": "activity-shape", "self-child": "activity-shape", "unknown-kind": "activity-shape",
  "completed-other-child": "activity-conflict", "conflicting-path": "activity-conflict", "mixed-v1": "mixed-v1",
})) {
  test("Codex exact-parent V2 projection rejects " + mode, () => {
    const response = parentResponse(), turn = response.thread.turns[0], items = turn.items;
    if (mode === "wrong-parent") response.thread.id = "private-other-parent";
    if (mode === "wrong-cwd") response.thread.cwd = "/private/other-workspace";
    if (mode === "invalid-model") response.thread.model = { private: "native model payload" };
    if (mode === "missing-turns") delete response.thread.turns;
    if (mode === "invalid-turn") response.thread.turns = [null];
    if (mode === "invalid-item") items.push(null);
    if (mode === "partial-turn") turn.itemsView = "summary";
    if (mode === "running-turn") turn.status = "inProgress";
    if (mode === "error-turn") turn.error = { message: "private native error" };
    if (mode === "empty-turns") response.thread.turns = [];
    if (mode === "zero-children") turn.items = [];
    if (mode === "multiple-children") items.push({ ...items[0], id: "other-spawn", agentThreadId: "other-child" });
    if (mode === "duplicate-start") items.push({ ...items[0], id: "second-spawn" });
    if (mode === "duplicate-item") items.push({ ...items[1] });
    if (mode === "malformed-activity") delete items[0].agentThreadId;
    if (mode === "self-child") items[0].agentThreadId = session;
    if (mode === "completed-other-child") items[1].agentThreadId = "private-other-child";
    if (mode === "conflicting-path") items[1].agentPath = "/root/private-other-path";
    if (mode === "mixed-v1") items.push({ type: "collabAgentToolCall", id: "v1-spawn", tool: "spawnAgent",
      status: "completed", senderThreadId: session, receiverThreadIds: ["private-v1-child"] });
    if (mode === "unknown-kind") items[1].kind = "private-unknown-kind";
    if (mode === "duplicate-turn") response.thread.turns.push(structuredClone(turn));
    if (mode === "missing-turn-id") delete turn.id;
    assert.throws(() => parseCodexParentEvidence(response, { parentId: session, cwd }), (error) => {
      assert.equal(error.code, "PRODUCTION_EVIDENCE_INVALID");
      assert.equal(error.parentValidationReason, reason);
      assert.ok(!error.message.includes("private"));
      assert.ok(!JSON.stringify(error).includes("private"));
      return true;
    });
  });
}

function childResponse() {
  return { thread: { id: child, cwd, source: { subAgent: { thread_spawn: { parent_thread_id: session, depth: 1,
    agent_path: null, agent_nickname: null, agent_role: null } } }, turns: [{ id: "turn-child", itemsView: "full",
    status: "completed", error: null, items: calls().map((call) => ({ id: call.id, type: "mcpToolCall",
      server: "probe", tool: call.name, status: "completed", arguments: call.args, result: textResult(call.text), error: null })) }] } };
}
test("Codex child history uses pinned app-server camelCase items and native snake_case lineage", () => {
  const evidence = parseCodexChildEvidence(childResponse(), { childId: child, parentId: session, cwd });
  assert.equal(evidence.sessionId, session);
  assert.deepEqual(evidence.calls, calls().map((call) => ({ ...call, owner: child })));
});
for (const mode of ["wrong-child", "wrong-parent", "wrong-workspace", "partial-history", "unfinished-turn", "failed-tool"]) {
  test(`Codex child lookup rejects ${mode}`, () => {
    const response = childResponse();
    if (mode === "wrong-child") response.thread.id = "other-child";
    if (mode === "wrong-parent") response.thread.source.subAgent.thread_spawn.parent_thread_id = "other-parent";
    if (mode === "wrong-workspace") response.thread.cwd = "/other";
    if (mode === "partial-history") response.thread.turns[0].itemsView = "summary";
    if (mode === "unfinished-turn") response.thread.turns[0].status = "inProgress";
    if (mode === "failed-tool") response.thread.turns[0].items[0].error = { message: "private diagnostic" };
    assert.throws(() => parseCodexChildEvidence(response, { childId: child, parentId: session, cwd }),
      { code: "PRODUCTION_EVIDENCE_INVALID" });
  });
}

const privateEvidence = () => ({ sessionId: session, children: [], calls: calls().map((call) => ({ ...call, owner: "root" })) });
const expectation = { owner: "root", marker, foreignMarkers: [foreign], query: "orchard", indexRequired: true };
test("verified tool receipt exposes only observed call counts and visibility booleans", () => {
  assert.deepEqual(verifyToolEvidence(privateEvidence(), expectation), {
    indexCalls: 1, searchCalls: 1, statsCalls: 1, ownMarkerVisible: true, foreignMarkersAbsent: true,
  });
});
test("resume search proves durable content without indexing it again", () => {
  const evidence = privateEvidence();
  evidence.calls.shift();
  assert.equal(verifyToolEvidence(evidence, { ...expectation, indexRequired: false }).indexCalls, 0);
});
for (const args of [{ queries: ["orchard"] }, { queries: ["orchard"], limit: 1 },
  { queries: ["orchard"], limit: 19 }, { queries: ["orchard"], limit: 20, source: "probe" },
  { queries: ["orchard"], limit: 20, contentType: "prose" }, { queries: ["orchard"], limit: 20, project: "local" },
  { queries: ["orchard"], limit: 20, sort: "timeline" }]) {
  test(`visibility requires exact broad search arguments: ${JSON.stringify(args)}`, () => {
    const evidence = privateEvidence();
    evidence.calls[1].args = args;
    assert.throws(() => verifyToolEvidence(evidence, expectation), { code: "PRODUCTION_EVIDENCE_INVALID" });
  });
}
for (const mode of ["foreign-marker", "missing-marker", "missing-search", "wrong-query", "wrong-owner", "wrong-index", "duplicate-stats", "prose-only"]) {
  test(`tool verification rejects ${mode} rather than trusting supplied booleans`, () => {
    const evidence = privateEvidence();
    if (mode === "foreign-marker") evidence.calls[1].text += ` ${foreign}`;
    if (mode === "missing-marker") evidence.calls[1].text = "No results";
    if (mode === "missing-search") evidence.calls.splice(1, 1);
    if (mode === "wrong-query") evidence.calls[1].args.queries = ["other"];
    if (mode === "wrong-owner") evidence.calls[1].owner = child;
    if (mode === "wrong-index") evidence.calls[0].args.content = "Other content";
    if (mode === "duplicate-stats") evidence.calls.push({ ...evidence.calls[2], id: "stats-2" });
    if (mode === "prose-only") { evidence.calls = []; evidence.result = `${marker} all checks passed`; }
    evidence.ownMarkerVisible = true; evidence.foreignMarkersAbsent = true;
    assert.throws(() => verifyToolEvidence(evidence, expectation), { code: "PRODUCTION_EVIDENCE_INVALID" });
  });
}
