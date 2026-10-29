// Private, in-memory native output parsing. Only verifyToolEvidence's allowlisted
// booleans/counts may enter a receipt; native ids, arguments and tool text may not.
const TOOLS = new Set(["ctx_index", "ctx_search", "ctx_stats"]);
const invalid = () => { throw Object.assign(new Error("Invalid production native evidence"), { code: "PRODUCTION_EVIDENCE_INVALID" }); };
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const id = (value) => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
function resultText(content) {
  if (typeof content === "string" && content.length) return content;
  if (!Array.isArray(content)) return invalid();
  const text = content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
  return text.length ? text : invalid();
}
function mcpCall(item, owner) {
  if (!id(item.id) || !TOOLS.has(item.tool) || item.server !== "probe" || item.status !== "completed" ||
      item.error || !object(item.arguments) || !object(item.result) || item.result.isError === true) return invalid();
  return { id: item.id, owner, name: item.tool, args: item.arguments, text: resultText(item.result.content) };
}
function uniqueCalls(calls) {
  if (new Set(calls.map((call) => `${call.owner}\0${call.id}`)).size !== calls.length) return invalid();
  return calls;
}

function codex(events) {
  let sessionId, completed = false;
  const calls = [], children = [];
  for (const event of events) {
    if (event.type === "thread.started") {
      if (sessionId || !id(event.thread_id)) return invalid();
      sessionId = event.thread_id;
    }
    if (["turn.failed", "error"].includes(event.type)) return invalid();
    if (event.type === "turn.completed") {
      if (completed || !sessionId) return invalid();
      completed = true;
    }
    if (event.type !== "item.completed") continue;
    if (!sessionId || completed || !object(event.item)) return invalid();
    const item = event.item;
    if (item.type === "mcp_tool_call" && (item.server === "probe" || TOOLS.has(item.tool))) calls.push(mcpCall(item, "root"));
    if (item.type === "collab_tool_call" && item.tool === "spawn_agent") {
      if (item.status !== "completed" || item.sender_thread_id !== sessionId ||
          !Array.isArray(item.receiver_thread_ids) || item.receiver_thread_ids.length !== 1 ||
          !id(item.receiver_thread_ids[0]) || item.receiver_thread_ids[0] === sessionId) return invalid();
      children.push({ id: item.receiver_thread_ids[0], parentId: sessionId });
    }
  }
  if (!completed || new Set(children.map((child) => child.id)).size !== children.length) return invalid();
  return { sessionId, calls: uniqueCalls(calls), children };
}

function claude(events) {
  let sessionId, completed = false;
  const starts = new Map(), calls = [], children = new Map(), results = new Set();
  for (const event of events) {
    const parent = event.parent_tool_use_id ?? null;
    if ((event.type === "system" && event.subtype === "init") || event.type === "result") {
      if (!id(event.session_id) || (sessionId && sessionId !== event.session_id)) return invalid();
      sessionId = event.session_id;
    }
    if (event.type === "result") {
      if (completed || event.is_error !== false || event.subtype !== "success") return invalid();
      completed = true;
    }
    if (!["assistant", "user"].includes(event.type)) continue;
    if (completed || !sessionId || !event.message ||
        (parent === null && event.session_id !== sessionId)) return invalid();
    if (parent !== null && (!id(parent) || !children.has(parent))) return invalid();
    // The forwarded first subagent user message can carry a string prompt.
    // Text is not tool evidence and must not be mistaken for a tool result.
    if (event.type === "user" && typeof event.message.content === "string") continue;
    if (!Array.isArray(event.message.content)) return invalid();
    for (const part of event.message.content) {
      if (part.type === "tool_use") {
        if (!id(part.id) || starts.has(part.id)) return invalid();
        const own = typeof part.name === "string" && part.name.startsWith("mcp__probe__");
        const name = own ? part.name.slice("mcp__probe__".length) : part.name;
        if (own && (!TOOLS.has(name) || !object(part.input))) return invalid();
        starts.set(part.id, { id: part.id, owner: parent ?? "root", name, args: part.input, own });
        if (["Agent", "Task"].includes(name)) {
          if (parent !== null) return invalid(); // This probe deliberately qualifies one direct child only.
          children.set(part.id, { id: part.id, parentId: sessionId });
        }
      }
      if (part.type === "tool_result") {
        const start = starts.get(part.tool_use_id);
        if (!start || results.has(part.tool_use_id) || start.owner !== (parent ?? "root")) return invalid();
        results.add(part.tool_use_id);
        if (part.is_error === true && (start.own || children.has(start.id))) return invalid();
        if (start.own) {
          const { own, ...call } = start;
          calls.push({ ...call, text: resultText(part.content) });
        }
      }
    }
  }
  if (!completed || [...starts.values()].some((start) => (start.own || children.has(start.id)) && !results.has(start.id))) return invalid();
  return { sessionId, calls: uniqueCalls(calls), children: [...children.values()] };
}

export function parseNativeEvidence({ client, stdout, expectedSessionId, maxOutputBytes = 1_048_576 } = {}) {
  if (!["claude", "codex"].includes(client) || typeof stdout !== "string" ||
      !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0 || Buffer.byteLength(stdout) > maxOutputBytes) return invalid();
  let events;
  try { events = stdout.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line)); }
  catch { return invalid(); }
  if (!events.length || events.some((event) => !object(event))) return invalid();
  const evidence = client === "codex" ? codex(events) : claude(events);
  if (expectedSessionId !== undefined && evidence.sessionId !== expectedSessionId) return invalid();
  return evidence;
}

// V2 spawn activity is omitted by exec JSONL; read only its exact native parent.
// A started activity proves the child identity, never the child's completion.
export function parseCodexParentEvidence(response, { parentId, cwd } = {}) {
  const reject = (parentValidationReason) => {
    throw Object.assign(new Error("Invalid production native evidence"), {
      code: "PRODUCTION_EVIDENCE_INVALID", parentValidationReason,
    });
  };
  const thread = response?.thread;
  if (!id(parentId) || thread?.id !== parentId) return reject("parent-id");
  if (!id(cwd) || thread.cwd !== cwd) return reject("workspace");
  if (thread.model !== null && !id(thread.model)) return reject("model");
  if (!Array.isArray(thread.turns) || !thread.turns.length) return reject("turns");
  const turns = new Set(), activityIds = new Set(), activities = [];
  for (const turn of thread.turns) {
    if (!id(turn?.id) || turns.has(turn.id) || turn.itemsView !== "full" || turn.status !== "completed" ||
        turn.error !== null || !Array.isArray(turn.items)) return reject("turn-shape");
    turns.add(turn.id);
    for (const item of turn.items) {
      if (!object(item)) return reject("item-shape");
      if (item.type === "collabAgentToolCall") {
        // Native V2 mailbox waits share this item type with V1 spawn events.
        // Waiting supplies neither a child identity nor proof of child completion.
        if (!id(item.id) || activityIds.has(item.id) || item.tool !== "wait" || item.status !== "completed" ||
            item.senderThreadId !== parentId || !Array.isArray(item.receiverThreadIds) || item.receiverThreadIds.length ||
            !object(item.agentsStates) || Object.keys(item.agentsStates).length ||
            item.prompt !== null || item.model !== null || item.reasoningEffort !== null) return reject("mixed-v1");
        activityIds.add(item.id);
        continue;
      }
      if (item.type !== "subAgentActivity") continue;
      if (!id(item.id) || activityIds.has(item.id) || !id(item.agentThreadId) || item.agentThreadId === parentId ||
          !id(item.agentPath) || !["started", "interacted", "interrupted", "completed"].includes(item.kind)) return reject("activity-shape");
      activityIds.add(item.id);
      activities.push(item);
    }
  }
  const starts = activities.filter((item) => item.kind === "started");
  if (starts.length !== 1) return reject("activity-cardinality");
  if (activities.some((item) => item.agentThreadId !== starts[0].agentThreadId ||
      item.agentPath !== starts[0].agentPath)) return reject("activity-conflict");
  return { sessionId: parentId, model: thread.model,
    children: [{ id: starts[0].agentThreadId, parentId }], startedActivities: 1,
    completedActivities: activities.filter((item) => item.kind === "completed").length };
}

export function parseCodexChildEvidence(response, { childId, parentId, cwd } = {}) {
  const thread = response?.thread;
  if (!id(childId) || !id(parentId) || childId === parentId || !id(cwd) || thread?.id !== childId || thread.cwd !== cwd ||
      thread.source?.subAgent?.thread_spawn?.parent_thread_id !== parentId ||
      !Array.isArray(thread.turns) || !thread.turns.length) return invalid();
  const calls = [];
  for (const turn of thread.turns) {
    if (turn.itemsView !== "full" || turn.status !== "completed" || turn.error || !Array.isArray(turn.items)) return invalid();
    for (const item of turn.items) {
      if (item?.type === "mcpToolCall" && (item.server === "probe" || TOOLS.has(item.tool))) calls.push(mcpCall(item, childId));
    }
  }
  return { sessionId: parentId, calls: uniqueCalls(calls), children: [{ id: childId, parentId }] };
}

export function verifyToolEvidence(evidence, { owner, marker, foreignMarkers, query, indexRequired } = {}) {
  if (!id(owner) || !id(marker) || !id(query) || !Array.isArray(foreignMarkers) ||
      foreignMarkers.some((value) => !id(value) || value === marker) || typeof indexRequired !== "boolean" ||
      !Array.isArray(evidence?.calls)) return invalid();
  const calls = uniqueCalls(evidence.calls.filter((call) => call.owner === owner));
  const names = indexRequired ? ["ctx_index", "ctx_search", "ctx_stats"] : ["ctx_search", "ctx_stats"];
  if (calls.length !== names.length || calls.some((call, index) => call.name !== names[index])) return invalid();
  const indexed = calls.find((call) => call.name === "ctx_index");
  const searched = calls.find((call) => call.name === "ctx_search");
  const stats = calls.find((call) => call.name === "ctx_stats");
  if (indexed && (indexed.args?.content !== `Orchard ${marker}.` || indexed.args?.source !== "probe" ||
      !/^Indexed [1-9]\d* sections\b/.test(indexed.text))) return invalid();
  if (!object(searched?.args) || Object.keys(searched.args).length !== 2 || searched.args.limit !== 20 ||
      JSON.stringify(searched.args.queries) !== JSON.stringify([query]) ||
      typeof searched.text !== "string" || !searched.text.includes(marker) ||
      foreignMarkers.some((value) => searched.text.includes(value)) || typeof stats?.text !== "string" || !stats.text.length) return invalid();
  return { indexCalls: indexed ? 1 : 0, searchCalls: 1, statsCalls: 1, ownMarkerVisible: true, foreignMarkersAbsent: true };
}
