// Pure optional diagnostic helpers. Native clients and existing probe modes do
// not import this module until its behavior is separately qualified and wired.
// Projections contain transient native identifiers; only summaries are receipts.
const PROVIDERS = ["claude", "codex"];
const EVENTS = ["SessionStart", "SubagentStart", "UserPromptSubmit", "PreToolUse", "PostToolUse",
  "PostToolUseFailure", "PreCompact", "PostCompact", "Stop", "SubagentStop", "SessionEnd"];
const FIELDS = new Set(["hook_event_name", "session_id", "cwd", "agent_id", "agent_type", "prompt_id", "turn_id",
  "tool_use_id", "tool_name", "prompt", "tool_input", "tool_response", "transcript_path", "permission_mode",
  "source", "trigger", "model", "last_assistant_message", "stop_hook_active", "reason", "error"]);
const CANDIDATES = { agent_id: "agentId", prompt_id: "promptId", turn_id: "turnId", tool_use_id: "toolUseId", tool_name: "toolName" };
const FLOWS = new Set(["root-A", "root-B", "resume-A", "child", "concurrent-1", "concurrent-2", "mixed"]);
const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure"]);
const RECOVERY_EVENTS = new Set(["SessionStart", "SubagentStart", "PreCompact", "PostCompact", "Stop", "SubagentStop", "SessionEnd"]);
const MAX_BODY_BYTES = 64 * 1024;
const MAX_FIELDS = 64;
const MAX_BOUND = 10_000;
const invalidProjection = () => { throw new Error("Invalid memory hook projection"); };
const invalidObservation = () => { throw new Error("Invalid memory hook observation"); };
const identifier = (value, maximum = 1024) => typeof value === "string" && value.length > 0 &&
  Buffer.byteLength(value) <= maximum && !/[\s\x00-\x1f\x7f]/.test(value);
const absolutePath = (value) => typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 4096 &&
  !/[\x00-\x1f\x7f]/.test(value) && (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value)) &&
  !value.split(/[\\/]/).some((part) => part === "." || part === "..");
const supported = (provider, event) => PROVIDERS.includes(provider) && EVENTS.includes(event) &&
  !(provider === "codex" && event === "PostToolUseFailure");

function record(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value);
  return keys.every((key) => typeof key === "string" && allowed.includes(key) &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"));
}

/** Discard content before it reaches the diagnostic peer; do not enumerate nested payloads. */
export function projectMemoryHook(provider, rawJson) {
  if (!PROVIDERS.includes(provider) || typeof rawJson !== "string" || Buffer.byteLength(rawJson) > MAX_BODY_BYTES) return invalidProjection();
  let input;
  try { input = JSON.parse(rawJson); } catch { return invalidProjection(); }
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalidProjection();
  const keys = Object.keys(input);
  if (keys.length > MAX_FIELDS || !supported(provider, input.hook_event_name) ||
      !identifier(input.session_id) || !absolutePath(input.cwd)) return invalidProjection();
  const projected = { event: input.hook_event_name, fields: keys.filter((key) => FIELDS.has(key)).sort(),
    unknownFields: keys.filter((key) => !FIELDS.has(key)).length, sessionId: input.session_id, cwd: input.cwd };
  for (const [source, target] of Object.entries(CANDIDATES)) {
    if (!Object.hasOwn(input, source)) continue;
    if (!identifier(input[source]) || (target === "toolName" && !/^[\w:.-]+$/.test(input[source]))) return invalidProjection();
    projected[target] = input[source];
  }
  return projected;
}

function validObservation(value) {
  if (!record(value, ["scope", "identity", "flow", "hook"])) return false;
  const { scope, identity, hook, flow } = value;
  if (!FLOWS.has(flow) || !record(scope, ["provider", "home", "workspace", "launchId"]) ||
      !PROVIDERS.includes(scope.provider) || !absolutePath(scope.home) || !absolutePath(scope.workspace) || !identifier(scope.launchId) ||
      !record(identity, ["provider", "home", "workspace", "launchId", "sessionId", "threadId", "agentId"]) ||
      !PROVIDERS.includes(identity.provider) || !absolutePath(identity.home) || !absolutePath(identity.workspace) ||
      !identifier(identity.launchId) || !identifier(identity.sessionId)) return false;
  for (const key of ["threadId", "agentId"]) if (Object.hasOwn(identity, key) && !identifier(identity[key])) return false;
  return validMemoryHookProjection(scope.provider, hook);
}

// The diagnostic HTTP boundary reuses the same fixed projection validation.
export function validMemoryHookProjection(provider, hook) {
  if (!record(hook, ["event", "fields", "unknownFields", "sessionId", "cwd", ...Object.values(CANDIDATES)]) ||
      !supported(provider, hook.event) || !identifier(hook.sessionId) || !absolutePath(hook.cwd) ||
      !Number.isSafeInteger(hook.unknownFields) || hook.unknownFields < 0 || hook.unknownFields > MAX_FIELDS ||
      !Array.isArray(hook.fields) || hook.fields.length > FIELDS.size || new Set(hook.fields).size !== hook.fields.length ||
      hook.fields.some((field) => !FIELDS.has(field)) ||
      ["hook_event_name", "session_id", "cwd"].some((field) => !hook.fields.includes(field))) return false;
  for (const [source, target] of Object.entries(CANDIDATES)) {
    if (Object.hasOwn(hook, target) !== hook.fields.includes(source)) return false;
    if (Object.hasOwn(hook, target) && (!identifier(hook[target]) ||
        (target === "toolName" && !/^[\w:.-]+$/.test(hook[target])))) return false;
  }
  return true;
}

function boundToOwner({ scope, identity, hook }) {
  if (["provider", "home", "workspace", "launchId"].some((key) => identity[key] !== scope[key]) || hook.cwd !== scope.workspace) return false;
  if (scope.provider === "claude") return identity.threadId === undefined &&
    hook.sessionId === identity.sessionId && hook.agentId === identity.agentId;
  if (identity.agentId !== undefined || !identity.threadId) return false;
  if (identity.threadId === identity.sessionId) return hook.sessionId === identity.sessionId && hook.agentId === undefined;
  // Qualification observes which native session field shape the installed child
  // emits; both must still name the exact registered child and its known root.
  return hook.agentId === identity.threadId &&
    (hook.sessionId === identity.sessionId || hook.sessionId === identity.threadId);
}

function providerReport() {
  return { observations: 0, bound: 0, unbound: 0, nativeRetryObserved: false,
    prompt: { observations: 0, occurrenceIds: 0, distinctOccurrences: 0, distinctAcrossFlows: false, eligible: false },
    tools: { pre: 0, post: 0, matched: 0, unmatched: 0, conflicts: 0, eligible: false },
    recovery: { observations: 0, eligible: false },
    events: Object.fromEntries(EVENTS.map((event) => [event, { observations: 0, bound: 0, unbound: 0, fields: [], unknownFields: 0 }])) };
}

function addPrompt(state, ownerKey, observation, reserve) {
  const { hook, flow, scope } = observation;
  // Pinned Codex hook stdin has no native prompt occurrence identifier. Neither
  // turn_id nor an injected prompt_id can upgrade that source contract.
  if (scope.provider !== "claude" || !hook.promptId) return;
  const key = JSON.stringify([ownerKey, "prompt", hook.promptId]);
  reserve(key); state.report.prompt.occurrenceIds++; state.promptIds.add(key);
  let flows = state.promptFlows.get(ownerKey);
  if (!flows) { flows = new Map(); state.promptFlows.set(ownerKey, flows); }
  let ids = flows.get(flow);
  if (!ids) { ids = new Set(); flows.set(flow, ids); }
  ids.add(hook.promptId);
}

function addTool(state, ownerKey, hook, reserve) {
  if (!hook.toolUseId || !hook.toolName) { state.report.tools.unmatched++; return; }
  const key = JSON.stringify([ownerKey, "tool", hook.toolUseId]);
  reserve(key);
  let tool = state.tools.get(key);
  if (!tool) { tool = { name: hook.toolName, pre: false, completion: undefined, conflict: false }; state.tools.set(key, tool); }
  if (tool.name !== hook.toolName) tool.conflict = true;
  if (hook.event === "PreToolUse") tool.pre = true;
  else {
    if (tool.completion && tool.completion !== hook.event) tool.conflict = true;
    tool.completion = hook.event;
  }
}

function finish(state) {
  const { report } = state;
  report.prompt.distinctOccurrences = state.promptIds.size;
  let witnessedPair = false, repeatedOccurrence = false;
  for (const flows of state.promptFlows.values()) {
    const start = flows.get("root-A"), resumed = flows.get("resume-A");
    if (!start?.size || !resumed?.size) continue;
    witnessedPair = true;
    if ([...resumed].some((id) => start.has(id))) repeatedOccurrence = true;
  }
  report.prompt.distinctAcrossFlows = witnessedPair && !repeatedOccurrence;
  report.prompt.eligible = report.unbound === 0 && report.prompt.observations > 1 &&
    report.prompt.occurrenceIds === report.prompt.observations && report.prompt.distinctAcrossFlows;
  for (const tool of state.tools.values()) {
    if (tool.conflict) report.tools.conflicts++;
    else if (tool.pre && tool.completion) report.tools.matched++;
    else report.tools.unmatched++;
  }
  report.tools.eligible = report.unbound === 0 && report.tools.matched > 0 &&
    report.tools.unmatched === 0 && report.tools.conflicts === 0;
  report.recovery.eligible = report.unbound === 0 && report.recovery.observations > 0;
  return report;
}

/** Registry-resolved identity and runner flow are trusted arguments, never hook-supplied claims. */
export function summarizeMemoryHooks(observations, bounds = { maxObservations: 512, maxIdentities: 512 }) {
  if (!record(bounds, ["maxObservations", "maxIdentities"]) ||
      [bounds.maxObservations, bounds.maxIdentities].some((value) => !Number.isSafeInteger(value) || value < 1 || value > MAX_BOUND)) {
    throw new Error("Invalid memory hook bounds");
  }
  if (!Array.isArray(observations)) return invalidObservation();
  if (observations.length > bounds.maxObservations) throw new Error("Memory hook observation capacity exceeded");
  const identities = new Set();
  const reserve = (key) => {
    if (!identities.has(key) && identities.size >= bounds.maxIdentities) throw new Error("Memory hook identity capacity exceeded");
    identities.add(key);
  };
  const states = Object.fromEntries(PROVIDERS.map((provider) => [provider,
    { report: providerReport(), promptIds: new Set(), promptFlows: new Map(), tools: new Map() }]));
  for (const observation of observations) {
    if (!validObservation(observation)) return invalidObservation();
    const { scope, identity, hook } = observation;
    const state = states[scope.provider], report = state.report, event = report.events[hook.event];
    report.observations++; event.observations++;
    event.fields = [...new Set([...event.fields, ...hook.fields])].sort();
    event.unknownFields += hook.unknownFields;
    if (hook.event === "UserPromptSubmit") report.prompt.observations++;
    if (hook.event === "PreToolUse") report.tools.pre++;
    else if (TOOL_EVENTS.has(hook.event)) report.tools.post++;
    if (RECOVERY_EVENTS.has(hook.event)) report.recovery.observations++;
    if (!boundToOwner(observation)) { report.unbound++; event.unbound++; continue; }
    report.bound++; event.bound++;
    const ownerKey = JSON.stringify([scope.provider, scope.home, scope.workspace, scope.launchId,
      identity.sessionId, identity.threadId ?? identity.agentId ?? identity.sessionId]);
    reserve(ownerKey);
    if (hook.event === "UserPromptSubmit") addPrompt(state, ownerKey, observation, reserve);
    if (TOOL_EVENTS.has(hook.event)) addTool(state, ownerKey, hook, reserve);
  }
  return { providers: Object.fromEntries(PROVIDERS.map((provider) => [provider, finish(states[provider])])) };
}
