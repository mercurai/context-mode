// Native qualification of production SessionStart recovery. Synthetic seed events
// are deliberately out of band: the clue never appears in a native prompt/history.
import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { productionClientConfig, productionRootIdentity, runClient, shellQuote } from "./run.mjs";
import { parseNativeEvidence } from "./production-evidence.mjs";
import { createProductionProbe } from "./production.mjs";
import { prepareCodexHookTrust } from "./codex-hook-trust.mjs";
import { runSharedHook } from "../../../hooks/shared-service.mjs";

function invalid() { throw new Error("Recovery evidence invalid"); }

export function recoveryClientConfig(options) {
  const result = productionClientConfig({ ...options, hookType: "command" });
  Object.assign(result.env, { CONTEXT_MODE_SHARED_HOOK_URL: options.launch.hookUrl,
    CONTEXT_MODE_SHARED_HOOK_CAP: options.launch.hookCapability,
    CONTEXT_MODE_SHARED_PROVIDER: options.launch.provider === "claude" ? "claude-code" : "codex",
    CONTEXT_MODE_SHARED_MCP_SERVER: "probe" });
  if (options.launch.provider === "claude") {
    for (const event of ["SessionStart", "SubagentStart"]) {
      result.files.settings.hooks[event] = [{ hooks: [{ type: "command", command: options.hookCommand, timeout: 15 }] }];
    }
  }
  return result;
}

function claudeAnswer(events) {
  if (events.some((e) => !["system", "assistant", "result", "rate_limit_event"].includes(e.type))) return invalid();
  for (const event of events.filter((e) => e.type === "assistant")) {
    if (!Array.isArray(event.message?.content) || event.message.content.some((c) =>
      !["text", "thinking", "redacted_thinking"].includes(c.type))) return invalid();
  }
  const starts = events.filter((e) => e.type === "system" && e.subtype === "init");
  const ends = events.filter((e) => e.type === "result");
  if (starts.length !== 1 || ends.length !== 1 || ends[0] !== events.at(-1) ||
      ends[0].subtype !== "success" || ends[0].is_error !== false || ends[0].session_id !== starts[0].session_id ||
      events.some((e) => e.session_id !== undefined && e.session_id !== starts[0].session_id)) return invalid();
  return { sessionId: starts[0].session_id, answer: ends[0].result };
}

function codexAnswer(events) {
  const allowed = ["thread.started", "turn.started", "turn.completed", "item.started", "item.updated", "item.completed"];
  if (events.some((e) => !allowed.includes(e.type))) return invalid();
  const starts = events.filter((e) => e.type === "thread.started");
  const turns = events.filter((e) => e.type === "turn.started");
  const ends = events.filter((e) => e.type === "turn.completed");
  const items = events.filter((e) => e.type.startsWith("item."));
  if (starts.length !== 1 || turns.length !== 1 || ends.length !== 1 || ends[0] !== events.at(-1) ||
      items.some((e) => !["agent_message", "reasoning"].includes(e.item?.type))) return invalid();
  const answers = items.filter((e) => e.type === "item.completed" && e.item.type === "agent_message");
  if (answers.length !== 1) return invalid();
  return { sessionId: starts[0].thread_id, answer: answers[0].item.text };
}

export function verifyRecoveryAnswer({ client, run, expectedSessionId, expected, foreign }) {
  if (!["claude", "codex"].includes(client) || run?.code !== 0 || run.timedOut || run.failure || run.cleanup === "unconfirmed" ||
      typeof run.stdout !== "string" || Buffer.byteLength(run.stdout) > 1_048_576 ||
      typeof expected !== "string" || !expected || !Array.isArray(foreign) || foreign.some((x) => typeof x !== "string" || !x)) return invalid();
  let events;
  try { events = run.stdout.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l)); } catch { return invalid(); }
  if (!events.length || events.some((e) => !e || typeof e !== "object" || Array.isArray(e))) return invalid();
  const { sessionId, answer } = client === "claude" ? claudeAnswer(events) : codexAnswer(events);
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 512 || /[\s\x00-\x1f\x7f]/.test(sessionId) ||
      (expectedSessionId !== undefined && sessionId !== expectedSessionId) || typeof answer !== "string" ||
      answer.trim() !== expected || foreign.some((marker) => answer.includes(marker))) return invalid();
  return { sessionId, answerMatched: true };
}

const INITIAL_PROMPT = "Call ctx_stats on the probe MCP server exactly once with {}. Do not call other tools or spawn agents. Reply only ready.";
const RECOVERY_PROMPT = "Use only the recovered session context already injected into this turn. " +
  "If it lists a file whose basename starts with recoveryclue, reply only that basename without its .md extension. " +
  "If no such file is listed, reply only none. Do not call any tools, read files, search memory, or spawn agents.";

async function seedClue(env, sessionId, workspace, marker) {
  // The registry keys tool observations within the launch, across its roots.
  const toolUseId = `synthetic-recovery-${randomBytes(16).toString("hex")}`;
  for (const hook_event_name of ["PreToolUse", "PostToolUse"]) {
    const native = { hook_event_name, session_id: sessionId, cwd: workspace,
      tool_use_id: toolUseId, tool_name: "Read",
      ...(hook_event_name === "PostToolUse" ? { tool_input: { file_path: join(workspace, `${marker}.md`) },
        tool_response: "Synthetic recovery fixture; no file was opened." } : {}) };
    const output = await runSharedHook({ env, input: Readable.from([JSON.stringify(native)]), signal: AbortSignal.timeout(10_000) });
    if (Object.keys(output).length) return invalid();
  }
}

export async function qualifyProductionRecovery({ clients, binaries, env = process.env, timeoutMs = 240_000 }) {
  if (!Array.isArray(clients) || !clients.length || clients.length > 2 || new Set(clients).size !== clients.length ||
      clients.some((p) => !["claude", "codex"].includes(p) || typeof binaries?.[p] !== "string" || !binaries[p]) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 240_000) return invalid();
  // Resolve caller-selected profiles before allocating any task-owned directory.
  const profiles = clients.map((provider) => ({ name: provider, provider,
    home: realpathSync(env[provider === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"] ??
      join(homedir(), provider === "codex" ? ".codex" : ".claude")), userHome: realpathSync(homedir()) }));
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "ctx-production-recovery-")));
  const command = `${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(new URL("../../../hooks/shared-service.mjs", import.meta.url)))}`;
  const receipt = { qualification: "native-production-recovery", passed: false, observedOn: process.platform,
    nativeInvocations: 0, flows: [], hookTrust: [], serviceRestarted: false, cleanupConfirmed: false,
    syntheticSeed: true, nativePromptCaptureQualified: false };
  let probe, unconfirmed = false;
  const roots = new Map(), clues = new Map(), trust = new Map();
  const launches = profiles.map((profile) => ({ ...profile, workspace: directory }));
  const configure = (client, prompt, resumeId, qualified = true) => recoveryClientConfig({
    launch: probe.launch(client), env, prompt, resumeId, hookCommand: command,
    files: { mcp: join(directory, `${client}-mcp.json`), settings: join(directory, `${client}-settings.json`) },
    ...(client === "codex" && qualified ? { qualifiedConfigArgs: trust.get(client)?.configArgs } : {}) });
  async function preflight() {
    if (!clients.includes("codex")) return;
    const config = configure("codex", INITIAL_PROMPT, undefined, false);
    let qualified;
    try {
      qualified = await prepareCodexHookTrust({ command: binaries.codex, configArgs: config.configArgs,
        cwd: directory, env: config.env, hookCommand: command });
    } catch (error) {
      unconfirmed ||= error?.code === "HOOK_TRUST_CLEANUP";
      throw error;
    }
    trust.set("codex", qualified);
    receipt.hookTrust.push({ epoch: probe.report().epoch, ...qualified.evidence });
  }
  async function invoke(client, name, prompt, resumeId) {
    const config = configure(client, prompt, resumeId);
    if (client === "claude") {
      writeFileSync(join(directory, `${client}-mcp.json`), JSON.stringify(config.files.mcp));
      writeFileSync(join(directory, `${client}-settings.json`), JSON.stringify(config.files.settings));
    }
    const flow = { provider: client, name, passed: false };
    receipt.flows.push(flow); receipt.nativeInvocations++;
    const result = await runClient(binaries[client], config.args, config.env, directory, { timeoutMs });
    unconfirmed ||= result.cleanup === "unconfirmed" || result.failure === "cleanup-unconfirmed";
    if (result.code !== 0 || result.failure || result.timedOut) { result.stdout = ""; return invalid(); }
    return { result, flow, config };
  }
  try {
    probe = await createProductionProbe({ launches });
    await preflight();
    for (const client of clients) {
      const owners = [], markers = [];
      for (const name of ["root-a", "root-b"]) {
        const { result, flow, config } = await invoke(client, name, INITIAL_PROMPT);
        let evidence;
        try { evidence = parseNativeEvidence({ client, stdout: result.stdout }); } finally { result.stdout = ""; }
        if (evidence.children.length || evidence.calls.length !== 1 || evidence.calls[0].name !== "ctx_stats") return invalid();
        const identity = productionRootIdentity(evidence, `p${receipt.nativeInvocations}`);
        if (owners.some((owner) => owner.sessionId === identity.sessionId)) return invalid();
        const marker = `recoveryclue${randomBytes(12).toString("hex")}`;
        await seedClue(config.env, identity.sessionId, directory, marker);
        owners.push(identity); markers.push(marker); flow.passed = true;
      }
      roots.set(client, owners); clues.set(client, markers);
    }
    await probe.restart(); receipt.serviceRestarted = true; trust.clear(); await preflight();
    for (const client of clients) {
      const allClues = [...clues.values()].flat();
      for (const index of [-1, 0, 1]) {
        const sessionId = index < 0 ? undefined : roots.get(client)[index].sessionId;
        const expected = index < 0 ? "none" : clues.get(client)[index];
        const { result, flow } = await invoke(client, index < 0 ? "fresh-exclusion" : `resume-${index === 0 ? "a" : "b"}`, RECOVERY_PROMPT, sessionId);
        let verified;
        try { verified = verifyRecoveryAnswer({ client, run: result, expectedSessionId: sessionId, expected,
          foreign: allClues.filter((marker) => marker !== expected) }); } finally { result.stdout = ""; }
        if (index < 0 && roots.get(client).some((owner) => owner.sessionId === verified.sessionId)) return invalid();
        flow.passed = true;
      }
    }
    receipt.passed = receipt.flows.length === clients.length * 5 && receipt.flows.every((flow) => flow.passed);
  } catch { receipt.passed = false; receipt.failure = "recovery-qualification-failed"; }
  finally {
    try { await probe?.close(); receipt.cleanupConfirmed = !unconfirmed; }
    catch { receipt.passed = false; receipt.failure = "cleanup-failed"; }
    if (unconfirmed) { receipt.passed = false; receipt.failure = "cleanup-unconfirmed"; }
    roots.clear(); clues.clear(); trust.clear();
    if (receipt.cleanupConfirmed) rmSync(directory, { recursive: true, force: true });
  }
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
  const client = option("--client", "all");
  try {
    if (!["claude", "codex", "all"].includes(client)) invalid();
    const result = await qualifyProductionRecovery({ clients: ["claude", "codex"].filter((p) => client === "all" || p === client),
      binaries: { claude: option("--claude-bin", "claude"), codex: option("--codex-bin", "codex") } });
    console.log(JSON.stringify(result));
    if (!result.passed) process.exitCode = 1;
  } catch { console.log(JSON.stringify({ qualification: "native-production-recovery", passed: false, failure: "configuration-invalid" })); process.exitCode = 1; }
}
