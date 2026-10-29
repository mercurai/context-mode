// Native hook trust qualification and exact-id read-only child evidence. No model requests or trust writes.
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";
import { parseCodexChildEvidence, parseCodexParentEvidence } from "./production-evidence.mjs";
import { validCodexPromptTarget, validateCodexPromptMetadata, projectCodexPromptPage } from "./codex-prompt-evidence.mjs";

const EVENTS = new Map([["sessionStart", "session_start"], ["subagentStart", "subagent_start"]]);
const MEMORY_EVENTS = new Map([...EVENTS, ["userPromptSubmit", "user_prompt_submit"], ["preToolUse", "pre_tool_use"], ["postToolUse", "post_tool_use"], ["stop", "stop"]]);
const failure = (code) => Object.assign(new Error(`Codex hook preflight failed (${code})`), { code });
const text = (value, max = 4096) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);

function reviewedHooks(result, options) {
  const events = options.memoryHooks === true ? MEMORY_EVENTS : EVENTS;
  const invalid = () => { throw failure("HOOK_TRUST_DECLARATION"); };
  if (!Array.isArray(result?.data) || result.data.length !== 1) return invalid();
  const entry = result.data[0];
  if (entry.cwd !== options.cwd || !Array.isArray(entry.hooks) ||
      !Array.isArray(entry.warnings) || entry.warnings.length || !Array.isArray(entry.errors) || entry.errors.length) return invalid();
  const owned = entry.hooks.filter((hook) => events.has(hook?.eventName) &&
    (hook.source === "sessionFlags" || hook.command === options.hookCommand));
  if (owned.length !== events.size || new Set(owned.map((hook) => hook.eventName)).size !== events.size) return invalid();
  for (const hook of owned) {
    if (hook.source !== "sessionFlags" || hook.isManaged !== false || hook.handlerType !== "command" ||
        hook.command !== options.hookCommand || hook.async !== false || hook.enabled !== true ||
        hook.matcher !== null || hook.timeoutSec !== 15 || hook.pluginId !== null ||
        !text(hook.sourcePath) || !/[/\\]<session-flags>[/\\]config\.toml$/.test(hook.sourcePath) ||
        hook.key !== `${hook.sourcePath}:${events.get(hook.eventName)}:0:0` || !text(hook.currentHash, 256) ||
        !["untrusted", "trusted", "modified"].includes(hook.trustStatus)) return invalid();
  }
  return owned.sort((a, b) => a.eventName.localeCompare(b.eventName)).map((hook) => ({
    key: hook.key, currentHash: hook.currentHash, trustStatus: hook.trustStatus,
  }));
}

function stopOwnedChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    // Only this live owned PID tree. No image-name/process-wide termination.
    const result = spawnSync(join(process.env.SystemRoot ?? "C:/Windows", "System32/taskkill.exe"),
      ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5000 });
    if (result.error || result.status !== 0) child.kill("SIGKILL");
    return;
  }
  try { process.kill(-child.pid, "SIGKILL"); }
  catch (error) { if (error.code !== "ESRCH") child.kill("SIGKILL"); }
}

function appServerRequest(options, method, params) {
  const { command, commandPrefix = [], configArgs, cwd, env, spawnProcess = spawn,
    timeoutMs = 15_000, maxOutputBytes = 1_048_576, cleanupTimeoutMs = 5000, stopProcess = stopOwnedChild,
    scheduleTimeout = setTimeout, cancelTimeout = clearTimeout,
    scheduleCleanupTimeout = setTimeout, cancelCleanupTimeout = clearTimeout } = options;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(command, [...commandPrefix, "app-server", "--stdio", ...configArgs], {
        cwd, env, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
      });
    } catch { reject(failure("HOOK_TRUST_PROCESS")); return; }
    let failed;
    let result;
    let stopped = false, settled = false, cleanupArmed = false, cleanupTimer;
    let bytes = 0;
    let buffer = "";
    let phase = "initialize";
    const decoder = new StringDecoder("utf8");
    const finish = (unconfirmed = false) => {
      if (settled) return;
      settled = true;
      cancelTimeout(timer);
      if (cleanupArmed) cancelCleanupTimeout(cleanupTimer);
      if (unconfirmed) reject(failure("HOOK_TRUST_CLEANUP"));
      else if (failed) reject(failed);
      else if (result !== undefined) resolve(result);
      else reject(failure("HOOK_TRUST_PROCESS"));
      result = undefined; buffer = "";
    };
    const awaitCleanup = () => {
      if (cleanupArmed || settled) return;
      cleanupArmed = true;
      cleanupTimer = scheduleCleanupTimeout(() => {
        stopped = true;
        finish(true);
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
      }, cleanupTimeoutMs);
    };
    const stop = (code) => {
      if (stopped || settled) return;
      stopped = true;
      if (code) failed = failure(code);
      awaitCleanup();
      child.stdin.destroy();
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try { stopProcess(child); } catch { /* The cleanup deadline prevents accepting an unconfirmed result. */ }
      }
    };
    const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
    const timer = scheduleTimeout(() => stop("HOOK_TRUST_TIMEOUT"), timeoutMs);
    child.stdin.on("error", () => { if (!stopped) stop("HOOK_TRUST_PROCESS"); });
    child.on("error", () => { if (!settled) { failed = failure("HOOK_TRUST_PROCESS"); awaitCleanup(); } });
    child.on("exit", awaitCleanup);
    child.on("close", () => finish());
    const count = (chunk) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) stop("HOOK_TRUST_OUTPUT_LIMIT");
      return !stopped;
    };
    child.stderr.on("data", count);
    child.stdout.on("data", (chunk) => {
      if (!count(chunk)) return;
      buffer += decoder.write(chunk);
      while (!stopped && buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { stop("HOOK_TRUST_PROTOCOL"); break; }
        if (!message || typeof message !== "object" || Array.isArray(message)) { stop("HOOK_TRUST_PROTOCOL"); break; }
        if (message.id === undefined && typeof message.method === "string") continue;
        if (message.id !== (phase === "initialize" ? 1 : 2) || message.error || !message.result || message.method) {
          stop("HOOK_TRUST_PROTOCOL"); break;
        }
        if (phase === "initialize") {
          phase = "request";
          send({ method: "initialized", params: {} });
          send({ id: 2, method, params });
        } else {
          result = message.result;
          stop();
        }
      }
    });
    send({ id: 1, method: "initialize", params: {
      clientInfo: { name: "context_mode_identity_probe", version: "1" }, capabilities: null,
    } });
  });
}

export async function prepareCodexHookTrust(options) {
  if (!options || !text(options.hookCommand) || !Array.isArray(options.configArgs) ||
      options.configArgs.some((arg, i) => typeof arg !== "string" || (i % 2 === 0 ? arg !== "-c" :
        /^(?:hooks\.state|bypass_hook_trust)(?:[.=]|$)/.test(arg))) ||
      options.configArgs.length % 2 ||
      (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)) ||
      (options.maxOutputBytes !== undefined && (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes <= 0))) {
    throw failure("HOOK_TRUST_DECLARATION");
  }
  const configArgs = [...options.configArgs];
  const first = reviewedHooks(await appServerRequest({ ...options, configArgs }, "hooks/list", { cwds: [options.cwd] }), options);
  const state = first.map(({ key, currentHash }) =>
    `${JSON.stringify(key)}={enabled=true,trusted_hash=${JSON.stringify(currentHash)}}`).join(",");
  configArgs.push("-c", `hooks.state={${state}}`);
  let second;
  try { second = reviewedHooks(await appServerRequest({ ...options, configArgs }, "hooks/list", { cwds: [options.cwd] }), options); }
  catch (error) {
    if (error.code === "HOOK_TRUST_DECLARATION") throw failure("HOOK_TRUST_VERIFICATION");
    throw error;
  }
  if (second.some((hook, index) => hook.trustStatus !== "trusted" || hook.key !== first[index].key ||
      hook.currentHash !== first[index].currentHash)) throw failure("HOOK_TRUST_VERIFICATION");
  return { configArgs, evidence: { status: "trusted", discovered: first.length, verified: second.length } };
}

// Qualification only: bounded reads of the two synthetic root turns. No generic RPC or ingestion API.
export async function readCodexPromptPhase(options) {
  const invalid = (code) => { throw Object.assign(new Error(code), { code }); };
  const phaseBudgetMs = options?.phaseBudgetMs ?? 30_000;
  if (!Number.isFinite(phaseBudgetMs) || phaseBudgetMs <= 0 || phaseBudgetMs > 30_000) {
    return invalid("CODEX_PROMPT_TARGET_INVALID");
  }
  const target = options?.target, prior = options?.priorTarget;
  if (!validCodexPromptTarget(target) || !text(options?.expectedPrompt, 65_536) || options.cwd !== target.workspace ||
      options.env?.CODEX_HOME !== target.home || !text(options.command) ||
      !Array.isArray(options.configArgs) || options.configArgs.length % 2 ||
      options.configArgs.some((arg, index) => typeof arg !== "string" || (index % 2 === 0 && arg !== "-c")) ||
      (target.flow === "root-A" ? prior !== undefined : !validCodexPromptTarget(prior) || prior.flow !== "root-A" ||
        prior.turnId === target.turnId || ["provider", "home", "workspace", "launchId", "sessionId", "threadId"].some((key) => prior[key] !== target[key]))) {
    return invalid("CODEX_PROMPT_TARGET_INVALID");
  }
  const now = options.now ?? (() => performance.now());
  const started = now(), deadline = started + phaseBudgetMs;
  const remaining = () => {
    const value = deadline - now();
    if (!Number.isFinite(value) || value <= 0 || value > phaseBudgetMs) return invalid("CODEX_PROMPT_TIMEOUT");
    return value;
  };
  const request = async (method, params) => {
    const budget = remaining();
    // Reserve cleanup inside the same phase budget; do not reset the clock for each child.
    if (budget < 2) return invalid("CODEX_PROMPT_TIMEOUT");
    const reserve = Math.min(5000, Math.floor(budget / 2));
    let result;
    try {
      result = await appServerRequest({ ...options, timeoutMs: Math.min(15_000, budget - reserve), maxOutputBytes: 262_144,
        cleanupTimeoutMs: reserve,
        scheduleCleanupTimeout: (callback, delay) => (options.scheduleCleanupTimeout ?? setTimeout)(callback,
          Math.max(1, Math.min(delay, deadline - now()))),
      }, method, params);
    } catch (error) {
      remaining();
      throw error;
    }
    remaining(); // A response is not evidence until its owned child and streams have closed.
    return result;
  };
  let metadata = await request("thread/read", { threadId: target.threadId, includeTurns: false });
  validateCodexPromptMetadata(metadata, target);
  metadata = undefined;
  async function snapshot(current) {
    const ids = [], seenIds = new Set(), cursors = new Set();
    let cursor, itemCount = 0, matchingPrompts = 0;
    for (let page = 0; page < 4; page++) {
      const response = await request("thread/items/list", { threadId: current.threadId, turnId: current.turnId,
        limit: 16, sortDirection: "asc", ...(cursor === undefined ? {} : { cursor }) });
      const projected = projectCodexPromptPage(response, current, options.expectedPrompt);
      itemCount += projected.itemCount; matchingPrompts += projected.matchingPrompts;
      for (const id of projected.ids) {
        if (seenIds.has(id)) return invalid("CODEX_PROMPT_EVIDENCE_INVALID");
        seenIds.add(id); ids.push(id);
      }
      if (projected.nextCursor === null) {
        if (!ids.length) return invalid("CODEX_PROMPT_EVIDENCE_INVALID");
        return { turnId: current.turnId, ids, itemCount, matchingPrompts, complete: true };
      }
      if (!projected.itemCount || cursors.has(projected.nextCursor)) return invalid("CODEX_PROMPT_EVIDENCE_INVALID");
      cursors.add(projected.nextCursor); cursor = projected.nextCursor;
    }
    return invalid("CODEX_PROMPT_LIMIT");
  }
  const snapshots = [];
  if (prior) snapshots.push(await snapshot(prior));
  snapshots.push(await snapshot(target), await snapshot(target));
  remaining();
  return { target: { ...target }, historyMode: "paginated", snapshots };
}

// Read only the parsed parent id when exec JSONL contains no V1 child event.
export async function readCodexParent(options) {
  if (!options || !text(options.parentId, 512) || !text(options.cwd) || !text(options.env?.CODEX_HOME) ||
      !Array.isArray(options.configArgs) || options.configArgs.length % 2 ||
      options.configArgs.some((arg, index) => typeof arg !== "string" || (index % 2 === 0 && arg !== "-c")) ||
      (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)) ||
      (options.maxOutputBytes !== undefined && (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes <= 0))) {
    throw Object.assign(new Error("Invalid production native evidence"), { code: "PRODUCTION_EVIDENCE_INVALID" });
  }
  const result = await appServerRequest(options, "thread/read", { threadId: options.parentId, includeTurns: true });
  return parseCodexParentEvidence(result, options);
}

// Read only a child id returned by this run's native spawn event or exact parent activity.
// Uses the same bounded app-server transport and exact launch home/config/cwd.
export async function readCodexChild(options) {
  if (!options || !text(options.childId, 512) || !text(options.parentId, 512) || options.childId === options.parentId ||
      !text(options.cwd) || !text(options.env?.CODEX_HOME) || !Array.isArray(options.configArgs) ||
      options.configArgs.length % 2 || options.configArgs.some((arg, index) => typeof arg !== "string" || (index % 2 === 0 && arg !== "-c")) ||
      (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)) ||
      (options.maxOutputBytes !== undefined && (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes <= 0))) {
    throw Object.assign(new Error("Invalid production native evidence"), { code: "PRODUCTION_EVIDENCE_INVALID" });
  }
  const result = await appServerRequest(options, "thread/read", { threadId: options.childId, includeTurns: true });
  return parseCodexChildEvidence(result, options);
}
