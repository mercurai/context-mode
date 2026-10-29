#!/usr/bin/env node
/** Managed command hook: ephemeral HTTP client, with no database or legacy fallback. */
import { Readable, addAbortSignal } from "node:stream";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_BYTES = 65_536;
// Native envelopes include tool input even when the outgoing event needs only
// identity. Keep the input admission limit separate from the projected wire cap.
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const DEADLINE_MS = 10_000;
const IDENTITY_FIELDS = ["hook_event_name", "session_id", "agent_id", "cwd", "tool_use_id", "tool_name"];
const START_EVENTS = ["SessionStart", "SubagentStart"];
const MEMORY_EVENTS = [...START_EVENTS, "PreToolUse", "UserPromptSubmit", "PostToolUse", "PostToolUseFailure"];

class SharedHookFailure extends Error {
  constructor(code) { super(`Shared hook ${code}`); }
}
function fail(code) { throw new SharedHookFailure(code); }
function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid");
  return value;
}
function exactKeys(value, keys) {
  record(value);
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) fail("invalid");
}

function configuration(env) {
  const raw = env.CONTEXT_MODE_SHARED_HOOK_URL;
  if (typeof raw !== "string" || !/^http:\/\/(127\.0\.0\.1|\[::1\]):[1-9]\d*\/hooks$/.test(raw)) fail("invalid");
  let url;
  try { url = new URL(raw); } catch { fail("invalid"); }
  const capability = env.CONTEXT_MODE_SHARED_HOOK_CAP;
  const provider = env.CONTEXT_MODE_SHARED_PROVIDER;
  const server = env.CONTEXT_MODE_SHARED_MCP_SERVER;
  if (typeof capability !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(capability) ||
      !["claude-code", "codex"].includes(provider) ||
      typeof server !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(server)) fail("invalid");
  return { url, capability, provider, server };
}

async function readBounded(stream, signal, limit = MAX_BYTES) {
  const parts = [];
  let bytes = 0;
  try {
    for await (const part of addAbortSignal(signal, stream)) {
      if (!Buffer.isBuffer(part) && typeof part !== "string" && !(part instanceof Uint8Array)) fail("invalid");
      const buffer = Buffer.from(part);
      bytes += buffer.length;
      if (bytes > limit) fail("capacity");
      parts.push(buffer);
    }
    signal.throwIfAborted();
    return Buffer.concat(parts).toString("utf8");
  } finally { parts.length = 0; }
}

function project(input, config) {
  record(input);
  const event = input.hook_event_name;
  if (!MEMORY_EVENTS.includes(event) ||
      (config.provider === "codex" && ["UserPromptSubmit", "PostToolUseFailure"].includes(event))) fail("unsupported");
  const identity = Object.fromEntries(IDENTITY_FIELDS.filter((key) => Object.hasOwn(input, key)).map((key) => [key, input[key]]));
  const memory = { ...identity };
  const fields = event === "UserPromptSubmit" ? ["prompt_id", "prompt"] :
    ["PostToolUse", "PostToolUseFailure"].includes(event) ? ["tool_input", "tool_response", "error"] : [];
  for (const key of fields) if (Object.hasOwn(input, key)) memory[key] = input[key];
  const register = config.provider === "codex" ? START_EVENTS.includes(event) :
    event === "PreToolUse" && typeof input.tool_name === "string" && input.tool_name.startsWith(`mcp__${config.server}__`);
  return { event, identity, memory, register };
}

function serialize(value) {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > MAX_BYTES) fail("capacity");
  return body;
}

async function post(config, body, signal) {
  signal.throwIfAborted();
  const response = await fetch(config.url, { method: "POST", redirect: "error", signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${config.capability}` }, body });
  if (response.status !== 202 || !response.body) {
    await response.body?.cancel();
    fail("unavailable");
  }
  const raw = await readBounded(Readable.fromWeb(response.body), signal);
  try { return JSON.parse(raw); } catch { fail("invalid"); }
}

function recoveryOutput(reply, event) {
  exactKeys(reply, ["memory"]);
  const value = record(reply.memory);
  if (START_EVENTS.includes(event)) {
    exactKeys(value, ["status", "recovery"]);
    // The service builds a bounded summary with searchable overflow sections.
    // Reject a protocol violation instead of cutting a recovery document here.
    if (value.status !== "recovered" || typeof value.recovery !== "string" || value.recovery.length > 10_000) fail("invalid");
    return { hookSpecificOutput: { hookEventName: event, additionalContext: value.recovery } };
  }
  exactKeys(value, ["status"]);
  const allowed = event === "PreToolUse" ? ["registered"] : ["applied", "duplicate"];
  if (!allowed.includes(value.status)) fail("invalid");
  return {};
}

/** The launch owner supplies configuration and the whole-operation abort signal. */
export async function runSharedHook({ env, input, signal }) {
  try {
    const config = configuration(env);
    let raw = await readBounded(input, signal, MAX_INPUT_BYTES);
    let native;
    try { native = JSON.parse(raw); } catch { fail("invalid"); }
    raw = undefined;
    const projected = project(native, config);
    native = undefined;
    // Validate both body bounds before any registration can mutate service state.
    if (["PostToolUse", "PostToolUseFailure"].includes(projected.event)) {
      const { prepareToolMemory } = await import("../build/shared/memory-projection.js");
      projected.memory = prepareToolMemory(projected.memory);
    }
    const body = serialize({ memory: projected.memory });
    const registration = projected.register ? serialize(projected.identity) : undefined;
    if (registration) {
      const receipt = await post(config, registration, signal);
      exactKeys(receipt, ["registered"]);
      if (receipt.registered !== true) fail("invalid");
    }
    return recoveryOutput(await post(config, body, signal), projected.event);
  } catch (error) {
    if (error instanceof SharedHookFailure) throw error;
    // Network/parser/stream errors may include native input or URLs. Never expose them.
    fail("unavailable");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), DEADLINE_MS);
  try {
    const output = await runSharedHook({ env: process.env, input: process.stdin, signal: controller.signal });
    process.stdout.write(JSON.stringify(output) + "\n");
  } catch {
    process.stderr.write("context-mode shared hook failed\n");
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    process.stdin.destroy();
  }
}
