// Qualification of native paginated userMessage identity. No ingestion or transport.
import { isAbsolute } from "node:path";

const invalid = (code = "CODEX_PROMPT_EVIDENCE_INVALID") => { throw Object.assign(new Error(code), { code }); };
const text = (value, bound) => typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= bound && !/[\x00-\x1f\x7f]/.test(value);
const id = (value) => text(value, 1024) && !/\s/.test(value);
const record = (value) => value && typeof value === "object" && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
  Reflect.ownKeys(value).every((key) => typeof key === "string" && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"));
const scopeFields = ["provider", "home", "workspace", "launchId", "sessionId", "threadId"];

export function validCodexPromptTarget(target) {
  return Boolean(record(target) && Object.keys(target).length === 8 &&
    Object.keys(target).every((key) => [...scopeFields, "flow", "turnId"].includes(key)) &&
    target.provider === "codex" && ["root-A", "resume-A"].includes(target.flow) &&
    ["home", "workspace"].every((key) => text(target[key], 4096) && isAbsolute(target[key])) &&
    ["launchId", "sessionId", "threadId", "turnId"].every((key) => id(target[key])) && target.sessionId === target.threadId);
}

export function validateCodexPromptMetadata(response, target) {
  if (!validCodexPromptTarget(target)) return invalid("CODEX_PROMPT_TARGET_INVALID");
  const thread = record(response) && response.thread;
  // Pinned root startup uses SessionId::from(thread_id); resumed roots preserve that identity.
  if (!record(thread) || thread.id !== target.threadId || thread.sessionId !== target.sessionId ||
      thread.cwd !== target.workspace || thread.parentThreadId !== null || !Array.isArray(thread.turns) || thread.turns.length !== 0) return invalid();
  if (thread.historyMode === "legacy") return invalid("CODEX_PROMPT_HISTORY_UNSUPPORTED");
  if (thread.historyMode !== "paginated") return invalid();
}

export function projectCodexPromptPage(response, target, expectedPrompt) {
  if (!validCodexPromptTarget(target)) return invalid("CODEX_PROMPT_TARGET_INVALID");
  if (!text(expectedPrompt, 65_536) || !record(response) || !Array.isArray(response.data) || response.data.length > 16 ||
      !(response.nextCursor === null || text(response.nextCursor, 4096))) return invalid();
  const ids = [], seen = new Set();
  let matchingPrompts = 0;
  for (const entry of response.data) {
    if (!record(entry) || entry.turnId !== target.turnId || !record(entry.item) || typeof entry.item.type !== "string") return invalid();
    const item = entry.item;
    if (item.type !== "userMessage") continue;
    if (!id(item.id) || seen.has(item.id) || !Array.isArray(item.content)) return invalid();
    seen.add(item.id); ids.push(item.id);
    // This probe submits one known text input. Other content cannot qualify that submission.
    if (item.content.length === 1 && record(item.content[0]) && item.content[0].type === "text" && item.content[0].text === expectedPrompt) matchingPrompts++;
  }
  return { turnId: target.turnId, ids, itemCount: response.data.length, matchingPrompts, nextCursor: response.nextCursor };
}

function validSnapshot(snapshot, turnId) {
  return record(snapshot) && snapshot.turnId === turnId && snapshot.complete === true &&
    Array.isArray(snapshot.ids) && snapshot.ids.length > 0 && snapshot.ids.length <= 64 &&
    snapshot.ids.every(id) && new Set(snapshot.ids).size === snapshot.ids.length &&
    Number.isSafeInteger(snapshot.itemCount) && snapshot.itemCount >= snapshot.ids.length && snapshot.itemCount <= 64 &&
    snapshot.matchingPrompts === snapshot.ids.length;
}

export function qualifyCodexPromptIds(first, resumed) {
  if (!record(first) || !record(resumed) || !validCodexPromptTarget(first.target) || !validCodexPromptTarget(resumed.target) ||
      first.target.flow !== "root-A" || resumed.target.flow !== "resume-A" ||
      scopeFields.some((key) => first.target[key] !== resumed.target[key]) || first.target.turnId === resumed.target.turnId ||
      first.historyMode !== "paginated" || resumed.historyMode !== "paginated" ||
      !Array.isArray(first.snapshots) || first.snapshots.length !== 2 || !Array.isArray(resumed.snapshots) || resumed.snapshots.length !== 3 ||
      !first.snapshots.every((snapshot) => validSnapshot(snapshot, first.target.turnId)) ||
      !validSnapshot(resumed.snapshots[0], first.target.turnId) ||
      !resumed.snapshots.slice(1).every((snapshot) => validSnapshot(snapshot, resumed.target.turnId))) return invalid();
  const equal = (a, b) => a.length === b.length && a.every((value) => b.includes(value));
  const oldIds = first.snapshots[0].ids, newIds = resumed.snapshots[1].ids;
  if (!equal(oldIds, first.snapshots[1].ids) || !equal(oldIds, resumed.snapshots[0].ids) ||
      !equal(newIds, resumed.snapshots[2].ids) || oldIds.some((value) => newIds.includes(value))) return invalid();
  return { qualified: true, rootOccurrences: oldIds.length, resumedOccurrences: newIds.length,
    repeatReadsStable: true, oldTurnStableAfterResume: true, repeatedPromptIdsDistinct: true,
    childPromptsQualified: false, sameTurnSteeringQualified: false, deliveryRetryQualified: false,
    rollbackQualified: false, compactionQualified: false, recoveryConsumptionQualified: false };
}
