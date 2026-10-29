// Runs the installed native Claude Code / Codex clients against the synthetic probe server and prints a redacted
// receipt (versions, key names, aliased identities, booleans, counts). Foreground and sequential; stops only its own
// server and children. Usage: node run.mjs [--client claude|codex|all] [--hook-type http|command] [--dry-run]
// Every client call is a real model turn with a one-line synthetic prompt.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createProbeServer } from "./server.mjs";
import { prepareCodexHookTrust, readCodexChild, readCodexParent, readCodexPromptPhase } from "./codex-hook-trust.mjs";
import { qualifyCodexPromptIds, validCodexPromptTarget } from "./codex-prompt-evidence.mjs";
import { parseNativeEvidence, verifyToolEvidence } from "./production-evidence.mjs";
import { createProductionProbe } from "./production.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const dryRun = args.includes("--dry-run");
const preflightOnly = args.includes("--preflight-only");
const which = option("--client", "all");
const backend = option("--backend", "diagnostic");
const hookType = option("--hook-type", "http");
const memoryHooks = args.includes("--memory-hooks");
const codexPromptIds = args.includes("--codex-prompt-ids");
const codexPromptStop = args.includes("--codex-prompt-stop");
const MEMORY_HOOK_EVENTS = ["SessionStart", "SubagentStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"];
const codexBin = option("--codex-bin", "codex");
const TIMEOUT_MS = Number(option("--timeout-s", "240")) * 1000;
const PROMPT_FOR = {};
const PROMPT = "Call the mcp__probe__identity_echo tool exactly once with no arguments, then reply with the single word done.";
const CODEX_PROMPT = "Call the identity_echo tool of the probe MCP server exactly once with no arguments, then reply with the single word done.";
PROMPT_FOR.claude = PROMPT;
PROMPT_FOR.codex = CODEX_PROMPT;
const CHILD_PROMPT = "First call the identity_echo tool of the probe MCP server yourself, once, with no arguments. Then launch exactly one subagent whose only task is to call the same identity_echo tool once with no arguments. Reply with the single word done.";

export function validateCodexPromptOptions(options = {}) {
  if (options.codexPromptIds !== true) return false;
  if (options.backend !== "diagnostic" || !["codex", "all"].includes(options.which) ||
      options.hookType !== "command" || options.memoryHooks !== true) {
    throw Object.assign(new Error("invalid Codex prompt options"), { code: "CODEX_PROMPT_OPTIONS_INVALID" });
  }
  return true;
}

export function validateCodexPromptStopOptions(options = {}) {
  if (options.codexPromptStop !== true) return false;
  try {
    if (!validateCodexPromptOptions(options)) throw new Error();
  } catch {
    throw Object.assign(new Error("invalid Codex Stop options"), { code: "CODEX_PROMPT_STOP_OPTIONS_INVALID" });
  }
  return true;
}

const promptFailureCodes = new Set(["CODEX_PROMPT_TARGET_INVALID", "CODEX_PROMPT_EVIDENCE_INVALID",
  "CODEX_PROMPT_HISTORY_UNSUPPORTED", "CODEX_PROMPT_TIMEOUT", "CODEX_PROMPT_LIMIT"]);

// The caller keeps promptPhase transient and publishes only promptQualification or a fixed failure code.
export async function runDiagnosticPromptFlow(options, { readPhase = readCodexPromptPhase } = {}) {
  const { client, name, run, probe, memoryCapability, env } = options;
  const selected = options.qualifyPrompts === true && client === "codex" && ["root-A", "resume-A"].includes(name);
  let result, root, succeeded = false, memoryFailure, promptFailure, target;
  try {
    result = await run();
    root = nativeId(client, result.stdout);
    succeeded = result.code === 0 && !result.timedOut && !result.failure && Boolean(root);
  } finally {
    if (memoryCapability) {
      try {
        target = probe.finishMemoryFlow(memoryCapability, root, succeeded,
          ...(selected ? [{ codexPromptTarget: true }] : []));
      } catch (error) {
        if (selected && promptFailureCodes.has(error?.code)) promptFailure = error.code;
        else memoryFailure = /^MEMORY_[A-Z_]+$/.test(error?.code ?? "") ? error.code : "MEMORY_FLOW_FAILED";
      } finally { env.PROBE_MEMORY_CAP = ""; }
    }
  }
  const output = { result, root, ...(memoryFailure ? { memoryFailure } : {}), ...(promptFailure ? { promptFailure } : {}) };
  if (!selected || !succeeded || memoryFailure || promptFailure) return output;
  try {
    if (!validCodexPromptTarget(target) || (name === "resume-A" && !validCodexPromptTarget(options.priorPhase?.target))) {
      throw Object.assign(new Error("CODEX_PROMPT_TARGET_INVALID"), { code: "CODEX_PROMPT_TARGET_INVALID" });
    }
    const observed = await readPhase({ ...options.readerOptions, target, expectedPrompt: options.expectedPrompt,
      ...(name === "resume-A" ? { priorTarget: options.priorPhase.target } : {}) });
    if (name === "root-A") output.promptPhase = observed;
    else output.promptQualification = qualifyCodexPromptIds(options.priorPhase, observed);
  } catch (error) {
    output.promptFailure = promptFailureCodes.has(error?.code) ? error.code : "CODEX_PROMPT_EVIDENCE_INVALID";
  }
  return output;
}

export function version(command, { args = ["--version"], timeoutMs = 5000, maxOutputBytes = 4096 } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: maxOutputBytes, windowsHide: true, killSignal: "SIGKILL" });
  if (result.error?.code === "ETIMEDOUT") return { status: "timeout" };
  if (result.error?.code === "ENOBUFS") return { status: "output-limit" };
  if (result.error) return { status: "spawn-error" };
  if (result.status !== 0 || !result.stdout?.trim()) return { status: "failed" };
  return { status: "ok", value: result.stdout.trim() };
}
const binary = (client) => (client === "codex" ? codexBin : client);
export const shellQuote = (value) => process.platform === "win32" ? `"${value.replaceAll('"', '""')}"` : `'${value.replaceAll("'", "'\\''")}'`;
const hookCommand = () => `${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(new URL("./hook.mjs", import.meta.url)))}`;
const homeVariable = (client) => client === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
const clientHome = (client) => realpathSync(process.env[homeVariable(client)] ?? join(homedir(), client === "codex" ? ".codex" : ".claude"));

// Production configuration references separate grant environment variables only.
// Kept pure so offline tests can inspect argv/files without loading native homes.
export function productionClientConfig(options = {}) {
  const fail = () => { throw Object.assign(new Error("Invalid production native configuration"), { code: "PRODUCTION_CONFIG_INVALID" }); };
  const { launch, files, prompt, resumeId, qualifiedConfigArgs, hookCommand: command, env: inherited = {}, hookType: kind } = options;
  if (!launch || !["claude", "codex"].includes(launch.provider) || !["http", "command"].includes(kind) ||
      [launch.home, launch.workspace, launch.mcpCapability, launch.hookCapability, command, prompt].some((value) => typeof value !== "string" || !value) ||
      launch.mcpCapability === launch.hookCapability || (resumeId !== undefined && (typeof resumeId !== "string" || !resumeId))) return fail();
  try {
    const urls = [new URL(launch.mcpUrl), new URL(launch.hookUrl)];
    if (urls.some((url) => url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port ||
        url.username || url.password || url.search || url.hash) || urls[0].pathname !== "/mcp" ||
        urls[1].pathname !== "/hooks" || urls[0].origin !== urls[1].origin) return fail();
  } catch { return fail(); }
  const env = { ...inherited, [homeVariable(launch.provider)]: launch.home,
    PROBE_MCP_CAP: launch.mcpCapability, PROBE_HOOK_CAP: launch.hookCapability, PROBE_HOOK_URL: launch.hookUrl };
  delete env.PROBE_CAP;
  if (launch.provider === "claude") {
    if (!files?.mcp || !files?.settings || qualifiedConfigArgs !== undefined) return fail();
    const hook = kind === "command" ? { type: "command", command } : { type: "http", url: launch.hookUrl,
      headers: { Authorization: "Bearer $PROBE_HOOK_CAP" }, allowedEnvVars: ["PROBE_HOOK_CAP"] };
    return { env, configArgs: [], files: {
      mcp: { mcpServers: { probe: { type: "http", url: launch.mcpUrl, headers: { Authorization: "Bearer ${PROBE_MCP_CAP}" } } } },
      settings: { hooks: { PreToolUse: [{ matcher: "mcp__probe__.*", hooks: [hook] }] } },
    }, args: ["-p", prompt, "--output-format", "stream-json", "--verbose", "--strict-mcp-config",
      "--mcp-config", files.mcp, "--settings", files.settings, "--setting-sources", "project", "--allowedTools",
      "mcp__probe__ctx_index,mcp__probe__ctx_search,mcp__probe__ctx_stats,Task,Agent", ...(resumeId ? ["--resume", resumeId] : [])] };
  }
  const configArgs = ["-c", `mcp_servers.probe.url=${JSON.stringify(launch.mcpUrl)}`, "-c",
    'mcp_servers.probe.bearer_token_env_var="PROBE_MCP_CAP"', "-c", "features.hooks=true"];
  for (const event of ["SessionStart", "SubagentStart"]) {
    configArgs.push("-c", `hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(command)},timeout=15}]}]`);
  }
  if (qualifiedConfigArgs !== undefined) {
    if (!Array.isArray(qualifiedConfigArgs) || qualifiedConfigArgs.length !== configArgs.length + 2 ||
        configArgs.some((arg, index) => arg !== qualifiedConfigArgs[index]) || qualifiedConfigArgs.at(-2) !== "-c" ||
        typeof qualifiedConfigArgs.at(-1) !== "string" || !qualifiedConfigArgs.at(-1).startsWith("hooks.state={")) return fail();
    configArgs.push(...qualifiedConfigArgs.slice(-2));
  }
  const common = ["--json", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", ...configArgs];
  return { env, configArgs, files: {}, args: resumeId ? ["exec", "resume", ...common, resumeId, prompt] :
    ["exec", "-C", launch.workspace, "-s", "read-only", ...common, prompt] };
}

function claudeFiles(dir, port) {
  const mcp = join(dir, "claude-mcp.json");
  writeFileSync(mcp, JSON.stringify({ mcpServers: { probe: { type: "http", url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: "Bearer ${PROBE_CAP}" } } } }));
  const hook =
    hookType === "command"
      ? { type: "command", command: hookCommand() }
      : { type: "http", url: `http://127.0.0.1:${port}/hook`, headers: { Authorization: "Bearer $PROBE_CAP" }, allowedEnvVars: ["PROBE_CAP"] };
  const settings = join(dir, "claude-settings.json");
  const hooks = memoryHooks ? Object.fromEntries([...MEMORY_HOOK_EVENTS, "PostToolUseFailure"].map((event) => [event,
    [{ ...(["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(event) ? { matcher: "mcp__probe__.*" } : {}), hooks: [hook] }]])) :
    { PreToolUse: [{ matcher: "mcp__probe__.*", hooks: [hook] }] };
  writeFileSync(settings, JSON.stringify({ hooks }));
  return { mcp, settings };
}

const claudeArgs = ({ mcp, settings }, prompt, extra = []) => [
  "-p", prompt, "--output-format", "json", "--strict-mcp-config", "--mcp-config", mcp, "--settings", settings,
  "--setting-sources", "project", "--allowedTools", "mcp__probe__identity_echo,Task,Agent", ...extra,
];

const codexConfig = (port) => {
  const config = ["-c", `mcp_servers.probe.url="http://127.0.0.1:${port}/mcp"`, "-c", 'mcp_servers.probe.bearer_token_env_var="PROBE_CAP"', "-c", "features.hooks=true"];
  for (const event of memoryHooks ? MEMORY_HOOK_EVENTS : ["SessionStart", "SubagentStart"]) {
    config.push("-c", `hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(hookCommand())},timeout=15}]}]`);
  }
  return config;
};

const codexArgs = (port, dir, prompt, resumeId, config = codexConfig(port)) => {
  const common = ["--json", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", ...config];
  // `exec resume` takes no sandbox flag: the resumed session keeps the one it was created with.
  return resumeId
    ? ["exec", "resume", ...common, resumeId, prompt]
    : ["exec", "-C", dir, "-s", "read-only", ...common, prompt];
};

function plan(port = "<port>", dir = "<tmp>") {
  const files = { mcp: `${dir}/claude-mcp.json`, settings: `${dir}/claude-settings.json` };
  return [
    ["claude", "root-A", claudeArgs(files, PROMPT)],
    ["claude", "root-B", claudeArgs(files, PROMPT)],
    ["claude", "resume-A", claudeArgs(files, PROMPT, ["--resume", "<session-A>"])],
    ["claude", "child", claudeArgs(files, CHILD_PROMPT)],
    ["codex", "root-A", codexArgs(port, dir, CODEX_PROMPT)],
    ["codex", "root-B", codexArgs(port, dir, CODEX_PROMPT)],
    ["codex", "resume-A", codexArgs(port, dir, CODEX_PROMPT, "<thread-A>")],
    ["codex", "child", codexArgs(port, dir, CHILD_PROMPT)],
    ["claude", "concurrent-1 and concurrent-2 (together)", claudeArgs(files, PROMPT)],
    ["codex", "concurrent-1 and concurrent-2 (together)", codexArgs(port, dir, CODEX_PROMPT)],
  ].filter(([client]) => which === "all" || which === client);
}

function stopOwnedClient(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    const result = spawnSync(join(process.env.SystemRoot ?? "C:/Windows", "System32/taskkill.exe"),
      ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5000 });
    if (result.error || result.status !== 0) child.kill("SIGKILL");
  } else {
    try { process.kill(-child.pid, "SIGKILL"); }
    catch (error) { if (error.code !== "ESRCH") child.kill("SIGKILL"); }
  }
}

export function runClient(command, argv, env, cwd, { maxOutputBytes = 1_048_576, timeoutMs = TIMEOUT_MS,
  cleanupTimeoutMs = 5000, spawnProcess = spawn, stopProcess = stopOwnedClient,
  scheduleTimeout = setTimeout, cancelTimeout = clearTimeout,
  scheduleCleanupTimeout = setTimeout, cancelCleanupTimeout = clearTimeout } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawnProcess(command, argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32", windowsHide: true }); }
    catch { resolve({ code: null, timedOut: false, failure: "spawn-error", stdout: "" }); return; }
    const chunks = [];
    let size = 0, failure, settled = false, cleanupArmed = false, cleanupTimer;
    const finish = (code, cleanup) => {
      if (settled) return;
      settled = true;
      cancelTimeout(timer);
      if (cleanupArmed) cancelCleanupTimeout(cleanupTimer);
      resolve({ code: failure === "spawn-error" ? null : code, timedOut: failure === "timeout", failure,
        stdout: failure ? "" : Buffer.concat(chunks).toString("utf8"), ...(cleanup ? { cleanup } : {}) });
    };
    const awaitCleanup = () => {
      if (cleanupArmed || settled) return;
      cleanupArmed = true;
      cleanupTimer = scheduleCleanupTimeout(() => {
        failure ??= "cleanup-unconfirmed";
        chunks.length = 0;
        // Closing our pipe ends cannot prove the inherited handles or descendants exited.
        finish(child.exitCode, "unconfirmed");
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
      }, cleanupTimeoutMs);
    };
    const stop = (reason) => {
      if (failure || settled) return;
      failure = reason;
      chunks.length = 0;
      awaitCleanup();
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try { stopProcess(child); } catch { /* The cleanup deadline reports unconfirmed ownership. */ }
      }
    };
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxOutputBytes) stop("output-limit");
      else if (!failure) chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxOutputBytes) stop("output-limit");
    });
    const timer = scheduleTimeout(() => stop("timeout"), timeoutMs);
    child.on("error", () => { if (!settled) { failure = "spawn-error"; awaitCleanup(); } });
    child.on("exit", awaitCleanup);
    child.on("close", (code) => finish(code));
  });
}

// Native ids are read from client output in memory only, to drive resume; they are never printed.
function nativeId(client, stdout) {
  if (client === "claude") {
    try {
      const events = JSON.parse(stdout);
      return (Array.isArray(events) ? events : [events]).find((event) => event?.session_id)?.session_id;
    } catch { return undefined; }
  }
  for (const line of stdout.split("\n")) {
    try {
      const event = JSON.parse(line);
      if (event.type === "thread.started" && event.thread_id) return event.thread_id;
    } catch { /* not a JSON line */ }
  }
  return undefined;
}

async function negativeChecks(port, capability) {
  const send = async (headers, body) => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "identity_echo", arguments: { threadId: "forged" } } };
  const noAuth = await send({}, call);
  const unbound = await send({ authorization: `Bearer ${capability}` }, call);
  return { noAuthRejected401: noAuth.status === 401, unboundCallRejectedBeforeTool: unbound.body?.error?.message === "unbound identity" };
}

const PRODUCTION_FLOWS = ["root-A", "root-B", "resume-A", "workspace-B", "child", "isolation-recheck-A", "restart-resume-A", "fresh-after-restart"];
const productionFailure = (code = "PRODUCTION_QUALIFICATION_FAILED") =>
  Object.assign(new Error("Production native qualification failed"), { code });
function productionPrompt(marker, indexRequired, childMarker) {
  const index = (value) => `Call ctx_index on the probe MCP server exactly once with ${JSON.stringify({ content: `Orchard ${value}.`, source: "probe" })}.`;
  const searchAndStats = 'Call ctx_search on the probe MCP server exactly once with {"queries":["orchard"],"limit":20}, then ctx_stats on that server exactly once with {}.';
  const ending = " Use actual tool calls. Do not read files, run shell commands, use other MCP servers or substitute prose for a missing tool. If a required call fails, stop and reply failed; otherwise reply only done.";
  if (childMarker) {
    const childTask = `You are the probe_child isolation verifier. ${index(childMarker)} Then ${searchAndStats} Do not spawn another agent.${ending}`;
    return `You are running a synthetic MCP isolation check. In this order: 1. ${index(marker)} ` +
      `2. Launch exactly one real subagent named probe_child with this complete task: ${JSON.stringify(childTask)} Wait for it to finish. ` +
      `3. ${searchAndStats}${ending}`;
  }
  return `You are running a synthetic MCP storage check. Work in this session without subagents. ` +
    (indexRequired ? `${index(marker)} Then ` : "Retrieve previously indexed content; do not index any content. ") + searchAndStats + ending;
}

async function productionStatus(url, capability) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json",
    ...(capability ? { authorization: `Bearer ${capability}` } : {}) }, body: "{}", signal: AbortSignal.timeout(5000), redirect: "error" });
  await response.body?.cancel();
  return response.status;
}

// Validate one native result before any exact child lookup. Diagnostics expose counts only.
export async function readProductionEvidence({ run, client, expectedSessionId, childExpected, diagnostics, readChild, readParent }) {
  const counts = (calls, owner) => ({
    index: calls.filter((call) => call.owner === owner && call.name === "ctx_index").length,
    search: calls.filter((call) => call.owner === owner && call.name === "ctx_search").length,
    stats: calls.filter((call) => call.owner === owner && call.name === "ctx_stats").length,
  });
  diagnostics.checkpoint = "native-client";
  const readCodes = ["PRODUCTION_EVIDENCE_INVALID", "HOOK_TRUST_PROCESS", "HOOK_TRUST_TIMEOUT",
    "HOOK_TRUST_OUTPUT_LIMIT", "HOOK_TRUST_PROTOCOL", "HOOK_TRUST_CLEANUP",
    "HOOK_TRUST_DECLARATION", "HOOK_TRUST_VERIFICATION"];
  try {
    if (run.code !== 0 || run.failure) {
      diagnostics.clientFailure = ["timeout", "output-limit", "spawn-error", "cleanup-unconfirmed"].includes(run.failure)
        ? run.failure : run.failure ? "unknown" : "nonzero-exit";
      diagnostics.cleanupUnconfirmed = run.cleanup === "unconfirmed" || run.failure === "cleanup-unconfirmed";
      throw productionFailure("PRODUCTION_CLIENT_FAILED");
    }
    diagnostics.checkpoint = "parent-parse";
    const evidence = parseNativeEvidence({ client, stdout: run.stdout, expectedSessionId });
    run.stdout = "";
    diagnostics.checkpoint = "child-count";
    diagnostics.native = { expectedChildren: childExpected ? 1 : 0, completedChildren: evidence.children.length,
      rootTools: counts(evidence.calls, "root") };
    if (client === "codex" && childExpected && evidence.children.length === 0 && typeof readParent === "function") {
      diagnostics.checkpoint = "parent-read";
      diagnostics.parentReadAttempted = true;
      let parent;
      try { parent = await readParent(evidence.sessionId); }
      catch (error) {
        if (error?.code === "PRODUCTION_EVIDENCE_INVALID") {
          const reasons = ["parent-id", "workspace", "model", "turns", "turn-shape", "item-shape",
            "mixed-v1", "activity-shape", "activity-cardinality", "activity-conflict"];
          diagnostics.parentValidationReason = reasons.includes(error.parentValidationReason)
            ? error.parentValidationReason : "unclassified";
        }
        throw productionFailure(readCodes.includes(error?.code) ? error.code : "PRODUCTION_PARENT_READ_FAILED");
      }
      if (parent?.sessionId !== evidence.sessionId || !Array.isArray(parent.children) || parent.children.length !== 1 ||
          parent.children[0].parentId !== evidence.sessionId || parent.children[0].id === evidence.sessionId) {
        throw productionFailure("PRODUCTION_EVIDENCE_INVALID");
      }
      evidence.children = parent.children;
      diagnostics.childObservation = "v2-activity";
      diagnostics.native.parentStartedActivities = parent.startedActivities;
      diagnostics.native.parentCompletedActivities = parent.completedActivities;
      diagnostics.native.completedChildren = evidence.children.length;
    }
    diagnostics.checkpoint = "child-count";
    if (evidence.children.length !== diagnostics.native.expectedChildren) {
      throw productionFailure("PRODUCTION_CHILD_COUNT_MISMATCH");
    }
    if (childExpected && client === "codex") {
      diagnostics.checkpoint = "child-read";
      diagnostics.childReadAttempted = true;
      const child = evidence.children[0];
      let childEvidence;
      try { childEvidence = await readChild(child); }
      catch (error) {
        throw productionFailure(readCodes.includes(error?.code) ? error.code : "PRODUCTION_CHILD_READ_FAILED");
      }
      evidence.calls.push(...childEvidence.calls);
      diagnostics.native.childTools = counts(childEvidence.calls, child.id);
    }
    diagnostics.checkpoint = "evidence-ready";
    return evidence;
  } finally {
    // Native text is private even when parsing, child cardinality or lookup fails.
    run.stdout = "";
  }
}

export function productionRootIdentity(evidence, processId) {
  const stats = evidence.calls.filter((call) => call.owner === "root" && call.name === "ctx_stats");
  if (stats.length !== 1) throw Object.assign(new Error("Invalid production native evidence"), { code: "PRODUCTION_EVIDENCE_INVALID" });
  return { sessionId: evidence.sessionId, toolId: stats[0].id, process: processId };
}

export async function unregisteredProductionCall(launch, root) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "production-probe-negative", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(launch.mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${launch.mcpCapability}` } },
  });
  try {
    await client.connect(transport, { timeout: 5000 });
    const meta = launch.provider === "codex" ? { threadId: root.sessionId, sessionId: root.sessionId } :
      { "claudecode/toolUseId": root.toolId };
    const result = await client.callTool({ name: "ctx_stats", arguments: {}, _meta: meta }, undefined, { timeout: 5000 });
    return result.isError === true;
  } finally { await client.close(); }
}

async function productionMain() {
  const clients = ["claude", "codex"].filter((client) => which === "all" || which === client);
  if (dryRun) {
    console.log(JSON.stringify({ backend: "shared-service", clients, tools: ["ctx_index", "ctx_search", "ctx_stats"],
      flows: PRODUCTION_FLOWS, modelCalls: 0, executionOverlap: "pending" }));
    return;
  }
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ctx-production-probe-")));
  const receipt = { backend: "shared-service", qualification: preflightOnly ? "hook-trust-only" : "native-index-search-stats",
    observedOn: process.platform, passed: false, modelCalls: 0, nativeInvocations: 0, flows: [], codexHookTrust: [], checks: {},
    negatives: {}, executionOverlap: { status: "pending", reason: "scoped-execution-not-qualified" } };
  let probe, phase = "startup";
  try {
    const workspaces = Object.fromEntries(["a", "b"].map((name) => {
      const workspace = join(dir, name); mkdirSync(workspace); return [name, realpathSync(workspace)];
    }));
    const launches = clients.flatMap((provider) => ["a", "b"].map((workspace) => ({
      name: `${provider}-${workspace}`, provider, home: clientHome(provider), userHome: realpathSync(homedir()), workspace: workspaces[workspace],
    })));
    probe = await createProductionProbe({ launches });
    const trust = new Map(), roots = new Map(), aliases = new Map();
    const markers = new Map(clients.map((client) => [client, Object.fromEntries(["a", "b", "workspace", "parent", "child", "fresh"]
      .map((key) => [key, `orchard${randomBytes(12).toString("hex")}`]))]));
    const allMarkers = [...markers.values()].flatMap(Object.values);
    const alias = (client, workspace, nativeId) => {
      const key = `${client}\0${workspace}\0${nativeId}`;
      if (!aliases.has(key)) aliases.set(key, `s${aliases.size + 1}`);
      return aliases.get(key);
    };
    const configuration = (client, workspace, name, prompt, resumeId, qualify = true) => productionClientConfig({
      launch: probe.launch(`${client}-${workspace}`), env: process.env, hookType, hookCommand: hookCommand(), prompt, resumeId,
      files: { mcp: join(dir, `${client}-${name}-mcp.json`), settings: join(dir, `${client}-${name}-settings.json`) },
      ...(client === "codex" && qualify ? { qualifiedConfigArgs: trust.get(workspace)?.configArgs } : {}),
    });
    const qualify = async (workspacesToQualify) => {
      if (!clients.includes("codex")) return;
      phase = "codex-hook-trust";
      trust.clear();
      for (const workspace of workspacesToQualify) {
        const config = configuration("codex", workspace, "preflight", "synthetic preflight only", undefined, false);
        const qualified = await prepareCodexHookTrust({ command: binary("codex"), configArgs: config.configArgs,
          cwd: workspaces[workspace], env: config.env, hookCommand: hookCommand() });
        trust.set(workspace, qualified);
        receipt.codexHookTrust.push({ workspace, epoch: probe.report().epoch, ...qualified.evidence });
      }
    };
    await qualify(["a", "b"]); // Fail before every provider's model calls if Codex qualification is missing.
    if (preflightOnly) {
      if (!clients.includes("codex")) throw productionFailure();
      receipt.passed = true;
      return;
    }
    receipt.versions = { ...Object.fromEntries(clients.map((client) => [client, version(binary(client))])), node: process.version };
    const one = async (client, name, marker, { workspace = "a", resumeId, indexRequired = true, childMarker } = {}) => {
      phase = name;
      const launch = probe.launch(`${client}-${workspace}`);
      if (client === "codex" && !trust.has(workspace)) throw productionFailure();
      const config = configuration(client, workspace, name, productionPrompt(marker, indexRequired, childMarker), resumeId);
      if (client === "claude") {
        // These files contain environment variable references, never grant values.
        writeFileSync(join(dir, `${client}-${name}-mcp.json`), JSON.stringify(config.files.mcp));
        writeFileSync(join(dir, `${client}-${name}-settings.json`), JSON.stringify(config.files.settings));
      }
      const flow = { client, name, workspace, epoch: probe.report().epoch, nativeProcess: `p${++receipt.nativeInvocations}`, passed: false };
      receipt.modelCalls = null; // Native subprocess count is observable; internal provider requests are not.
      receipt.flows.push(flow);
      const run = await runClient(binary(client), config.args, config.env, launch.workspace);
      flow.exit = run.code;
      flow.timedOut = run.timedOut;
      const evidence = await readProductionEvidence({ run, client, expectedSessionId: resumeId,
        childExpected: Boolean(childMarker), diagnostics: flow,
        readParent: (parentId) => readCodexParent({ command: binary("codex"), configArgs: config.configArgs,
          cwd: launch.workspace, env: config.env, parentId }),
        readChild: (child) => readCodexChild({ command: binary("codex"), configArgs: config.configArgs,
          cwd: launch.workspace, env: config.env, childId: child.id, parentId: child.parentId }),
      });
      const expectation = (owner, own, required) => ({ owner, marker: own, foreignMarkers: allMarkers.filter((value) => value !== own),
        query: "orchard", indexRequired: required });
      flow.checkpoint = "root-tools";
      flow.tools = verifyToolEvidence(evidence, expectation("root", marker, indexRequired));
      flow.session = alias(client, workspace, evidence.sessionId);
      if (resumeId) flow.resumedSameConversation = evidence.sessionId === resumeId;
      if (childMarker) {
        const child = evidence.children[0];
        flow.checkpoint = "child-tools";
        flow.child = { lineageAlias: alias(client, workspace, child.id),
          correlation: client === "codex" ? "native-thread" : "native-parent-tool-use", nativeParentMatches: child.parentId === evidence.sessionId,
          tools: verifyToolEvidence(evidence, expectation(child.id, childMarker, true)) };
        flow.checkpoint = "child-lineage";
        if (!flow.child.nativeParentMatches || flow.child.lineageAlias === flow.session) {
          throw productionFailure("PRODUCTION_CHILD_LINEAGE_MISMATCH");
        }
      }
      flow.checkpoint = "verified";
      flow.passed = true;
      return productionRootIdentity(evidence, flow.nativeProcess);
    };
    for (const client of clients) {
      const marker = markers.get(client);
      const a = await one(client, "root-A", marker.a);
      roots.set(client, a);
      const b = await one(client, "root-B", marker.b);
      if (a.sessionId === b.sessionId) throw productionFailure();
      const resumed = await one(client, "resume-A", marker.a, { resumeId: a.sessionId, indexRequired: false });
      await one(client, "workspace-B", marker.workspace, { workspace: "b" });
      await one(client, "child", marker.parent, { childMarker: marker.child });
      receipt.checks[client] = { distinctRootConversations: true, resumeFromSeparateNativeProcess: a.process !== resumed.process };
    }
    // All providers' markers exist before this cross-provider visibility check.
    for (const client of clients) await one(client, "isolation-recheck-A", markers.get(client).a,
      { resumeId: roots.get(client).sessionId, indexRequired: false });
    phase = "restart";
    const old = new Map(clients.map((client) => [client, probe.launch(`${client}-a`)]));
    await probe.restart();
    for (const client of clients) {
      const current = probe.launch(`${client}-a`), previous = old.get(client);
      receipt.negatives[client] = {
        noAuthRejected: await productionStatus(current.mcpUrl) === 401,
        oldMcpCapabilityRejected: await productionStatus(current.mcpUrl, previous.mcpCapability) === 401,
        oldHookCapabilityRejected: await productionStatus(current.hookUrl, previous.hookCapability) === 401,
        hookCapabilityRejectedByMcp: await productionStatus(current.mcpUrl, current.hookCapability) === 401,
        mcpCapabilityRejectedByHook: await productionStatus(current.hookUrl, current.mcpCapability) === 401,
        freshLaunchUnregisteredCallRejected: await unregisteredProductionCall(current, roots.get(client)),
      };
      if (!Object.values(receipt.negatives[client]).every((value) => value === true)) throw productionFailure();
    }
    await qualify(["a"]);
    for (const client of clients) {
      const a = roots.get(client), marker = markers.get(client);
      const restored = await one(client, "restart-resume-A", marker.a, { resumeId: a.sessionId, indexRequired: false });
      const fresh = await one(client, "fresh-after-restart", marker.fresh);
      if (fresh.sessionId === a.sessionId) throw productionFailure();
      Object.assign(receipt.checks[client], { restartRestoredSameConversation: restored.sessionId === a.sessionId,
        restartResumeFromSeparateNativeProcess: restored.process !== a.process, freshConversationExcludedPriorMarkers: true });
    }
    receipt.passed = receipt.flows.length === PRODUCTION_FLOWS.length * clients.length && receipt.flows.every((flow) => flow.passed) &&
      Object.values(receipt.checks).every((checks) => Object.values(checks).every((value) => value === true));
    receipt.service = probe.report();
  } catch (error) {
    receipt.passed = false;
    receipt.failure = { phase, code: /^(?:PRODUCTION_|HOOK_TRUST_)[A-Z_]+$/.test(error?.code ?? "") ? error.code : "PRODUCTION_QUALIFICATION_FAILED" };
  } finally {
    try { await probe?.close(); }
    catch { receipt.passed = false; receipt.cleanupFailed = true; }
    try { rmSync(dir, { recursive: true, force: true }); }
    catch { receipt.passed = false; receipt.cleanupFailed = true; }
    console.log(JSON.stringify(receipt, null, 2));
    if (!receipt.passed) process.exitCode = 1;
  }
}

async function main() {
  if (codexPromptStop) validateCodexPromptStopOptions({ codexPromptStop, codexPromptIds, backend, which, hookType, memoryHooks });
  validateCodexPromptOptions({ codexPromptIds, backend, which, hookType, memoryHooks });
  if (memoryHooks && (backend !== "diagnostic" || hookType !== "command")) throw new Error("invalid memory hook options");
  if (!["claude", "codex", "all"].includes(which) || !["diagnostic", "production"].includes(backend) ||
      !["http", "command"].includes(hookType) || !Number.isFinite(TIMEOUT_MS) || TIMEOUT_MS <= 0) {
    throw new Error("invalid probe options");
  }
  if (backend === "production") return productionMain();
  if (dryRun) {
    for (const [client, name, argv] of plan()) console.log(`${client} ${name}: PROBE_CAP=<in-memory> ${binary(client)} ${argv.join(" ")}`);
    return;
  }
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ctx-identity-probe-")));
  let probe, codexPromptPhase, stopPhase, stopQualification;
  try {
    const clients = ["claude", "codex"].filter((client) => which === "all" || which === client);
    const launches = clients.map((provider) => ({ provider, home: clientHome(provider), workspace: dir, capability: randomBytes(24).toString("base64url") }));
    const memoryFlowNames = ["root-A", "root-B", "resume-A", "child", "concurrent-1", "concurrent-2", ...(clients.length === 2 ? ["mixed"] : [])];
    probe = createProbeServer({ launches,
      ...(memoryHooks ? { memoryHooks: { flows: clients.flatMap((provider) => memoryFlowNames.map((name) => ({ provider, name }))) } } : {}),
      ...(codexPromptStop ? { codexPromptStop: { read: async (target, { phaseBudgetMs }) => {
        const phase = await readCodexPromptPhase({ command: binary("codex"), configArgs: codexTrust.configArgs,
          cwd: dir, env: environmentFor("codex"), target, expectedPrompt: CODEX_PROMPT, phaseBudgetMs,
          ...(target.flow === "resume-A" ? { priorTarget: stopPhase?.target } : {}) });
        if (target.flow === "root-A") stopPhase = phase;
        else {
          try { stopQualification = qualifyCodexPromptIds(stopPhase, phase); }
          finally { stopPhase = undefined; }
        }
      } } } : {}),
    });
    const port = await probe.listen();
    const files = claudeFiles(dir, port);
    const flows = [];
    const launchFor = (client) => launches.find((launch) => launch.provider === client);
    const environmentFor = (client) => {
      const launch = launchFor(client);
      return { ...process.env, PROBE_CAP: launch.capability, PROBE_HOOK_URL: `http://127.0.0.1:${port}/hook`,
        PROBE_MEMORY_CAP: "", PROBE_MEMORY_PROVIDER: "", [homeVariable(client)]: launch.home };
    };
    let codexTrust;
    if (clients.includes("codex")) {
      try {
        codexTrust = await prepareCodexHookTrust({ command: binary("codex"), configArgs: codexConfig(port),
          cwd: dir, env: environmentFor("codex"), hookCommand: hookCommand(), ...(memoryHooks ? { memoryHooks: true } : {}) });
      } catch {
        console.log(JSON.stringify({ passed: false, flows: [], modelCalls: 0, stats: probe.report().stats,
          codexHookTrust: { status: "failed" } }));
        process.exitCode = 1;
        return;
      }
    }
    if (preflightOnly) {
      if (!codexTrust) throw new Error("Codex must be selected for hook trust preflight");
      console.log(JSON.stringify({ codexHookTrust: codexTrust.evidence, modelCalls: 0 }));
      return;
    }
    const aliasFor = (flow) => probe.aliasForKey(flow.nativeKey, launchFor(flow.client).capability);
    const keyOf = (client, id) => (id ? `${client === "codex" ? "codex" : "claude"}:${id}` : undefined);
    let codexPromptQualification, codexPromptFailure;
    const one = async (client, name, prompt, resumeId) => {
      const argv = client === "claude" ? claudeArgs(files, prompt, resumeId ? ["--resume", resumeId] : []) : codexArgs(port, dir, prompt, resumeId, codexTrust.configArgs);
      const env = environmentFor(client);
      const cap = memoryHooks ? probe.beginMemoryFlow(launchFor(client).capability, name) : undefined;
      if (cap) { env.PROBE_MEMORY_CAP = cap; env.PROBE_MEMORY_PROVIDER = client; }
      const observed = await runDiagnosticPromptFlow({ client, name, probe, memoryCapability: cap, env,
        run: () => runClient(binary(client), argv, env, dir), qualifyPrompts: codexPromptIds,
        expectedPrompt: prompt, priorPhase: codexPromptPhase,
        readerOptions: client === "codex" ? { command: binary(client), configArgs: codexTrust.configArgs, cwd: dir, env } : undefined });
      const { result, root, memoryFailure } = observed;
      if (codexPromptIds && client === "codex" && ["root-A", "resume-A"].includes(name)) {
        codexPromptFailure ??= observed.promptFailure ?? memoryFailure;
        if (name === "root-A") codexPromptPhase = observed.promptPhase;
        else {
          codexPromptQualification = observed.promptQualification;
          codexPromptPhase = undefined;
        }
      }
      return { client, name, exit: result.code, timedOut: result.timedOut, failure: result.failure, nativeKey: keyOf(client, root),
        ...(memoryFailure ? { memoryFailure } : {}) };
    };
    for (const client of clients) {
      const sequential = [["root-A", PROMPT_FOR[client]], ["root-B", PROMPT_FOR[client]], ["resume-A", PROMPT_FOR[client]], ["child", CHILD_PROMPT]];
      let rootA;
      for (const [name, prompt] of sequential) {
        if (name === "resume-A" && !rootA) {
          flows.push({ client, name, skipped: "no native id from root-A" });
          continue;
        }
        const before = probe.report().calls.length;
        const flow = await one(client, name, prompt, name === "resume-A" ? rootA : undefined);
        if (name === "root-A") rootA = flow.nativeKey?.slice(flow.nativeKey.indexOf(":") + 1);
        flows.push({ ...flow, calls: probe.report().calls.slice(before) });
      }
      const before = probe.report().calls.length;
      const barrier = probe.armBarrier({ providers: [client, client], timeoutMs: TIMEOUT_MS });
      const pair = await Promise.all(["concurrent-1", "concurrent-2"].map((name) => one(client, name, PROMPT_FOR[client]))).finally(barrier.cancel);
      const pairCalls = probe.report().calls.slice(before);
      flows.push(...pair.map((flow) => ({ ...flow, concurrent: true, calls: pairCalls.filter((call) => call.identity === aliasFor(flow)) })));
    }
    if (clients.length === 2) {
      const before = probe.report().calls.length;
      const barrier = probe.armBarrier({ providers: clients, timeoutMs: TIMEOUT_MS });
      const mixed = await Promise.all(clients.map((client) => one(client, "mixed", PROMPT_FOR[client]))).finally(barrier.cancel);
      const pairCalls = probe.report().calls.slice(before);
      flows.push(...mixed.map((flow) => ({ ...flow, mixed: true, calls: pairCalls.filter((call) => call.identity === aliasFor(flow)) })));
    }
    const report = probe.report();
    for (const flow of flows) {
      const own = flow.nativeKey ? aliasFor(flow) : undefined;
      flow.boundToOwnNativeId = Boolean(flow.nativeKey && own && flow.calls?.some((call) => call.bound && call.identity === own));
      flow.ownAlias = own ?? null;
      delete flow.nativeKey;
    }
    const negatives = await negativeChecks(port, launches[0].capability);
    const receipt = {
      observedOn: process.platform,
      bindingRequired: true,
      overlapRequired: true,
      ...(codexTrust ? { codexHookTrust: codexTrust.evidence } : {}),
      versions: { ...Object.fromEntries(clients.map((client) => [client, version(binary(client))])), node: process.version },
      flows,
      checks: summarize(flows),
      negatives,
      stats: report.stats,
      metaKeys: report.metaKeys,
      hookKeys: report.hookKeys,
      turnMetadataKeys: report.turnMetadataKeys,
      argumentKeys: report.argumentKeys,
      identities: report.identities,
      barriers: report.barriers,
      ...(memoryHooks ? { memory: report.memory } : {}),
      ...(codexPromptIds ? { codexPromptIds: !codexPromptFailure && codexPromptQualification ? codexPromptQualification :
        { qualified: false, failure: codexPromptFailure ?? "CODEX_PROMPT_INCOMPLETE" } } : {}),
      ...(codexPromptStop ? { codexPromptStop: { ...report.codexPromptStop,
        qualified: report.codexPromptStop.status === "complete" && stopQualification?.qualified === true } } : {}),
    };
    receipt.passed = receiptPassed(receipt, clients) && (!codexPromptIds || receipt.codexPromptIds.qualified === true) &&
      (!codexPromptStop || receipt.codexPromptStop.qualified === true);
    console.log(JSON.stringify(receipt, null, 2));
    if (!receipt.passed || (memoryHooks && receipt.memory.status !== "complete")) process.exitCode = 1;
  } finally {
    codexPromptPhase = undefined;
    stopPhase = undefined;
    await probe?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export function summarize(flows) {
  const concurrent = (client) => flows.filter((f) => f.client === client && f.concurrent);
  const bound = (client, name) => flows.find((f) => f.client === client && f.name === name)?.calls?.find((c) => c.bound);
  const out = {};
  for (const client of ["claude", "codex"]) {
    const [a, b, resumed] = ["root-A", "root-B", "resume-A"].map((n) => bound(client, n));
    const pairCalls = flows.find((f) => f.client === client && f.name === "child")?.calls?.filter((c) => c.bound) ?? [];
    const child = pairCalls.find((c) => c.lineage === "child");
    const parent = pairCalls.find((c) => c.lineage === "root");
    const childPair = child && parent ? [parent, child] : null;
    out[client] = {
      twoSessionsDistinct: a && b ? a.identity !== b.identity : null,
      resumeKeepsIdentity: a && resumed ? a.identity === resumed.identity : null,
      resumeUsedNewConnection: a && resumed ? a.connection !== resumed.connection : null,
      concurrentRootsDistinct: concurrent(client).length === 2 && concurrent(client).every((f) => f.ownAlias && f.calls?.length === 1 && f.calls[0].bound && f.calls[0].identity === f.ownAlias) && concurrent(client)[0].ownAlias !== concurrent(client)[1].ownAlias,
      allFlowsBoundToOwnNativeId: flows.filter((f) => f.client === client).length >= 6 && flows.filter((f) => f.client === client).every((f) => f.boundToOwnNativeId === true),
      childLineage: child?.lineage ?? null,
      childSharesRootSession: childPair ? childPair[0].session === childPair[1].session : null,
      childPairDistinct: childPair ? childPair[0].identity !== childPair[1].identity : null,
    };
  }
  return out;
}

export function receiptPassed(receipt, clients) {
  const names = ["root-A", "root-B", "resume-A", "child", "concurrent-1", "concurrent-2"];
  if (!clients.length || new Set(clients).size !== clients.length || clients.some((client) => !["claude", "codex"].includes(client))) return false;
  const mixed = receipt.overlapRequired && clients.length === 2;
  if (mixed) names.push("mixed");
  if (receipt.flows.length !== clients.length * names.length || receipt.stats.bound !== clients.length * (mixed ? 8 : 7) || receipt.stats.unbound !== 0 || receipt.stats.authRejected !== 0) return false;
  if (receipt.negatives.noAuthRejected401 !== true || receipt.negatives.unboundCallRejectedBeforeTool !== true) return false;
  if (receipt.bindingRequired && !receipt.flows.every((flow) => flow.calls?.every((call) => call.workspaceBound === true && typeof call.scope === "string"))) return false;
  if (receipt.overlapRequired && !overlapPassed(receipt, clients, mixed)) return false;
  const actualChecks = summarize(receipt.flows);
  return clients.every((client) => {
    const flows = receipt.flows.filter((flow) => flow.client === client);
    if (!names.every((name) => flows.filter((flow) => flow.name === name).length === 1)) return false;
    if (!flows.every((flow) => flow.exit === 0 && flow.timedOut === false && !flow.failure && !flow.skipped && flow.boundToOwnNativeId === true && flow.calls?.length === (flow.name === "child" ? 2 : 1) && flow.calls.every((call) => call.bound))) return false;
    return [actualChecks[client], receipt.checks[client]].every((checks) => checks && Object.entries(actualChecks[client]).every(([key]) => checks[key] === (key === "childLineage" ? "child" : true)));
  });
}

function overlapPassed(receipt, clients, mixed) {
  if (receipt.barriers?.length !== clients.length + (mixed ? 1 : 0)) return false;
  const groups = clients.map((client) => receipt.flows.filter((flow) => flow.client === client && flow.concurrent));
  if (mixed) groups.push(receipt.flows.filter((flow) => flow.mixed));
  const used = new Set();
  return groups.every((flows) => {
    if (flows.length !== 2 || !flows.every((flow) => flow.calls?.length === 1)) return false;
    const calls = flows.map((flow) => flow.calls[0]);
    const id = calls[0].barrier;
    if (!id || used.has(id) || calls[0].identity === calls[1].identity || !calls.every((call) => call.barrier === id && call.overlapVerified === true)) return false;
    used.add(id);
    const evidence = receipt.barriers.filter((barrier) => barrier.barrier === id);
    return evidence.length === 1 && evidence[0].overlapVerified === true && JSON.stringify([...evidence[0].providers].sort()) === JSON.stringify(flows.map((flow) => flow.client).sort());
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(codexPromptIds ? (error?.code === "CODEX_PROMPT_OPTIONS_INVALID" ? "invalid Codex prompt options" : "Codex prompt probe failed") :
      memoryHooks ? (error?.message === "invalid memory hook options" ? "invalid memory hook options" : "memory probe failed") :
      backend === "production" ? "production probe failed" : `probe failed: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
