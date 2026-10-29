// Synchronous command-hook collector. Native identity fields travel only to the authenticated loopback probe.
// Prompt, transcript, tool input and authentication values never reach stdout, disk or the receipt.
import { projectMemoryHook } from "./memory-hooks.mjs";
const fields = ["hook_event_name", "session_id", "agent_id", "cwd", "tool_use_id", "tool_name"];

async function deliver(url, body, capability, receiptField, signal) {
  const response = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${capability}` },
    body: JSON.stringify(body), signal, redirect: "error",
  });
  if (receiptField && response.status === 202) {
    const parts = [];
    let bytes = 0;
    for await (const part of response.body) {
      bytes += part.length;
      if (bytes > 4096) throw new Error("hook response limit");
      parts.push(part);
    }
    const receipt = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (receipt?.[receiptField] !== true) throw new Error("hook registration rejected");
  } else {
    await response.body?.cancel();
    if (receiptField || !response.ok) throw new Error("hook registration rejected");
  }
}

async function main() {
  const url = new URL(process.env.PROBE_HOOK_URL ?? "");
  const production = url.pathname === "/hooks";
  const capability = production ? process.env.PROBE_HOOK_CAP : process.env.PROBE_CAP;
  const memoryCapability = process.env.PROBE_MEMORY_CAP;
  const provider = process.env.PROBE_MEMORY_PROVIDER;
  if (memoryCapability && (production || !["claude", "codex"].includes(provider))) throw new Error("invalid memory hook scope");
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !["/hook", "/hooks"].includes(url.pathname) ||
      url.username || url.password || url.search || url.hash || !capability) throw new Error("invalid hook scope");
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > (memoryCapability ? 65_536 : 1_048_576)) throw new Error("hook input limit");
    chunks.push(chunk);
  }
  let raw = Buffer.concat(chunks).toString("utf8");
  chunks.length = 0;
  const projected = memoryCapability ? projectMemoryHook(provider, raw) : undefined;
  let input = JSON.parse(raw);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid hook input");
  const body = Object.fromEntries(fields.filter((field) => typeof input[field] === "string").map((field) => [field, input[field]]));
  raw = undefined; input = undefined;
  const registers = !memoryCapability || (provider === "codex" ? ["SessionStart", "SubagentStart"].includes(body.hook_event_name) :
    body.hook_event_name === "PreToolUse" && body.tool_name === "mcp__probe__identity_echo");
  const signal = AbortSignal.timeout(10_000);
  if (registers) await deliver(url, body, capability, production ? "registered" : undefined, signal);
  if (projected) await deliver(url, { memory: projected }, memoryCapability, "observed", signal);
  process.stdout.write("{}");
}

main().catch(() => {
  process.stderr.write("identity probe hook failed\n");
  process.exitCode = 1;
});
