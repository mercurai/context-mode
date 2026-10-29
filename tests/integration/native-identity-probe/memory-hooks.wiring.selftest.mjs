// Synthetic HTTP/collector/stdio peers only. No native clients, model turns or memory-store writes.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createProbeServer } from "./server.mjs";
import { projectMemoryHook } from "./memory-hooks.mjs";
import { prepareCodexHookTrust } from "./codex-hook-trust.mjs";

const file = (name) => fileURLToPath(new URL(name, import.meta.url));
const names = ["root-A", "root-B", "resume-A", "child", "concurrent-1", "concurrent-2", "mixed"];
const launches = ["claude", "codex"].map((provider) => ({ provider, home: "/OMIT-HOME", workspace: "/OMIT-WORKSPACE", capability: `OMIT-${provider}-LAUNCH` }));
const flowSpec = (providers = ["claude", "codex"], flows = names) => ({ flows: providers.flatMap((provider) => flows.map((name) => ({ provider, name }))) });
const native = (event, extra = {}) => ({ hook_event_name: event, session_id: "OMIT-ROOT", cwd: launches[0].workspace, ...extra });
const envelope = (provider, event, extra) => ({ memory: projectMemoryHook(provider, JSON.stringify(native(event, extra))) });
const call = (provider, id = "OMIT-ROOT") => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
  name: "identity_echo", arguments: {}, _meta: provider === "codex" ? { threadId: id, sessionId: "OMIT-ROOT" } : { "claudecode/toolUseId": id },
} });

async function setup(t, memoryHooks = flowSpec()) {
  const probe = createProbeServer({ launches, ...(memoryHooks === false ? {} : { memoryHooks }) });
  t.after(() => probe.close());
  const port = await probe.listen();
  async function post(path, body, capability) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", redirect: "error",
      headers: { "content-type": "application/json", authorization: `Bearer ${capability}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  }
  const grant = (provider, flow = "root-A") => probe.beginMemoryFlow(launches.find((value) => value.provider === provider).capability, flow);
  const deliver = (capability, provider, event, extra) => post("/hook", envelope(provider, event, extra), capability);
  async function register(provider, { root = "OMIT-ROOT", agent, tool = "OMIT-TOOL" } = {}) {
    const scope = launches.find((value) => value.provider === provider);
    const body = provider === "codex" ? native(agent ? "SubagentStart" : "SessionStart", { session_id: root, ...(agent ? { agent_id: agent } : {}) }) :
      native("PreToolUse", { session_id: root, ...(agent ? { agent_id: agent } : {}), tool_use_id: tool, tool_name: "mcp__probe__identity_echo" });
    assert.equal((await post("/hook", body, scope.capability)).status, 200);
    const request = call(provider, provider === "codex" ? agent ?? root : tool);
    if (provider === "codex") request.params._meta.sessionId = root;
    assert.ok((await post("/mcp", request, scope.capability)).body.result);
  }
  return { probe, post, grant, deliver, register };
}

test("default diagnostic has no memory receipt and rejects opt-in API use", async (t) => {
  const { probe } = await setup(t, false);
  assert.equal(Object.hasOwn(probe.report(), "memory"), false);
  assert.throws(() => probe.beginMemoryFlow(launches[0].capability, "root-A"), { code: "MEMORY_DIAGNOSTICS_DISABLED" });
});

test("configured flows are bounded to fourteen unique fixed provider/name pairs", () => {
  for (const flows of [Array(15).fill({ provider: "claude", name: "root-A" }),
    [{ provider: "claude", name: "root-A" }, { provider: "claude", name: "root-A" }],
    [{ provider: "claude", name: "OMIT-UNTRUSTED-FLOW" }]]) {
    assert.throws(() => createProbeServer({ launches, memoryHooks: { flows } }), { code: "MEMORY_FLOW_CONFIGURATION" });
  }
});

test("flow grants allow at most two active and cannot be reminted or issued outside configuration", async (t) => {
  const { probe, grant } = await setup(t, flowSpec(["claude"], ["root-A", "root-B", "resume-A"]));
  const a = grant("claude"), b = grant("claude", "root-B");
  assert.notEqual(a, b);
  assert.throws(() => grant("claude", "resume-A"), { code: "MEMORY_FLOW_CAPACITY" });
  probe.finishMemoryFlow(a, undefined, false);
  assert.equal(typeof grant("claude", "resume-A"), "string");
  assert.throws(() => grant("claude"), { code: "MEMORY_FLOW_INVALID" });
  assert.throws(() => grant("codex"), { code: "MEMORY_FLOW_INVALID" });
});

for (const provider of ["claude", "codex"]) {
  test(`${provider} observation capability cannot register identity or dispatch MCP`, async (t) => {
    const { probe, grant, post, deliver } = await setup(t);
    const cap = grant(provider), scope = launches.find((value) => value.provider === provider);
    const event = provider === "codex" ? "SessionStart" : "PreToolUse";
    const fields = provider === "claude" ? { tool_use_id: "OMIT-TOOL", tool_name: "mcp__probe__identity_echo" } : {};
    assert.equal((await deliver(cap, provider, event, fields)).status, 202);
    assert.equal(probe.report().stats.hookRegistered, 0);
    assert.equal((await post("/hook", native(event, fields), cap)).status, 403);
    assert.equal((await post("/mcp", call(provider, provider === "codex" ? "OMIT-ROOT" : "OMIT-TOOL"), cap)).status, 401);
    const unbound = await post("/mcp", call(provider, provider === "codex" ? "OMIT-ROOT" : "OMIT-TOOL"), scope.capability);
    assert.equal(unbound.body.error.message, "unbound identity");
    assert.throws(() => probe.finishMemoryFlow(cap, "OMIT-ROOT", true), { code: "MEMORY_HOOK_UNBOUND" });
    assert.equal((await deliver(cap, provider, event, fields)).status, 401);
  });
}

test("launch capabilities and request flow claims cannot authorize observation envelopes", async (t) => {
  const { grant, post } = await setup(t);
  const body = envelope("claude", "SessionStart"), cap = grant("claude");
  assert.equal((await post("/hook", body, launches[0].capability)).status, 403);
  for (const key of ["flow", "provider", "home", "workspace", "identity"]) {
    assert.equal((await post("/hook", { ...body, [key]: "OMIT-FORGED" }, cap)).status, 400);
  }
});

test("early Claude prompts resolve only after existing tool registration and bound MCP evidence", async (t) => {
  const { probe, grant, deliver, register } = await setup(t, flowSpec(["claude"], ["root-A"]));
  const cap = grant("claude");
  assert.equal((await deliver(cap, "claude", "UserPromptSubmit", { prompt_id: "OMIT-PROMPT-A" })).status, 202);
  await register("claude");
  probe.finishMemoryFlow(cap, "OMIT-ROOT", true);
  assert.equal(probe.report().memory.status, "complete");
  assert.equal(probe.report().memory.summary.providers.claude.bound, 1);
});

test("resume uses the same trusted launch grouping with distinct invocation capabilities", async (t) => {
  const { probe, grant, deliver, register } = await setup(t, flowSpec(["claude"], ["root-A", "resume-A"]));
  await register("claude");
  const first = grant("claude");
  await deliver(first, "claude", "UserPromptSubmit", { prompt_id: "OMIT-PROMPT-A" });
  probe.finishMemoryFlow(first, "OMIT-ROOT", true);
  const resumed = grant("claude", "resume-A");
  assert.notEqual(first, resumed);
  await deliver(resumed, "claude", "UserPromptSubmit", { prompt_id: "OMIT-PROMPT-B" });
  probe.finishMemoryFlow(resumed, "OMIT-ROOT", true);
  const receipt = probe.report().memory;
  assert.equal(receipt.summary.providers.claude.prompt.distinctAcrossFlows, true);
  assert.equal(receipt.summary.providers.claude.prompt.eligible, true);
  assert.ok(!JSON.stringify(receipt).includes("OMIT-"));
  assert.ok(!JSON.stringify(receipt).includes(first) && !JSON.stringify(receipt).includes(resumed));
});

test("concurrent flow completion cannot adopt another registered root", async (t) => {
  const { probe, grant, deliver, register } = await setup(t);
  await register("codex"); await register("codex", { root: "OMIT-OTHER" });
  const a = grant("codex", "concurrent-1"), b = grant("codex", "concurrent-2");
  await deliver(a, "codex", "Stop", { session_id: "OMIT-OTHER" });
  await deliver(b, "codex", "Stop", { session_id: "OMIT-ROOT" });
  assert.throws(() => probe.finishMemoryFlow(a, "OMIT-ROOT", true), { code: "MEMORY_HOOK_UNBOUND" });
  assert.throws(() => probe.finishMemoryFlow(b, "OMIT-OTHER", true), { code: "MEMORY_HOOK_UNBOUND" });
  assert.equal(probe.report().memory.status, "failed");
});

test("registered Codex child binds to its exact root without treating turn IDs as prompt IDs", async (t) => {
  const { probe, grant, deliver, register } = await setup(t, flowSpec(["codex"], ["child"]));
  await register("codex"); await register("codex", { agent: "OMIT-CHILD" });
  const cap = grant("codex", "child");
  await deliver(cap, "codex", "UserPromptSubmit", { agent_id: "OMIT-CHILD", turn_id: "OMIT-TURN" });
  probe.finishMemoryFlow(cap, "OMIT-ROOT", true);
  const summary = probe.report().memory.summary.providers.codex;
  assert.equal(summary.bound, 1); assert.equal(summary.prompt.occurrenceIds, 0); assert.equal(summary.prompt.eligible, false);
});

for (const [label, extra] of [["unknown child", { agent_id: "OMIT-UNKNOWN" }], ["wrong workspace", { cwd: "/OMIT-OTHER-WORKSPACE" }]]) {
  test(`${label} cannot use another owner or the most recently registered root`, async (t) => {
    const { probe, grant, deliver, register } = await setup(t);
    await register("codex");
    const cap = grant("codex");
    await deliver(cap, "codex", "Stop", extra);
    assert.throws(() => probe.finishMemoryFlow(cap, "OMIT-ROOT", true), { code: "MEMORY_HOOK_UNBOUND" });
    assert.equal(probe.report().memory.status, "failed");
  });
}

test("failed or missing native completion revokes the flow and cannot report qualification", async (t) => {
  const { probe, grant, deliver } = await setup(t);
  const cap = grant("claude");
  probe.finishMemoryFlow(cap, undefined, false);
  assert.equal((await deliver(cap, "claude", "Stop")).status, 401);
  assert.equal(probe.report().memory.status, "failed");
  assert.equal(probe.report().memory.failure, "MEMORY_FLOW_FAILED");
});

test("zero observations cannot complete a configured native flow", async (t) => {
  const { probe, grant, register } = await setup(t);
  await register("claude");
  assert.throws(() => probe.finishMemoryFlow(grant("claude"), "OMIT-ROOT", true), { code: "MEMORY_HOOK_MISSING" });
});

test("closing the diagnostic server retires unfinished capabilities and retained observations", async (t) => {
  const { probe, grant, deliver } = await setup(t);
  const cap = grant("claude");
  await deliver(cap, "claude", "UserPromptSubmit", { prompt_id: "OMIT-PROMPT" });
  await probe.close();
  assert.deepEqual(probe.report().memory, { status: "closed" });
  assert.throws(() => grant("claude", "root-B"), { code: "MEMORY_DIAGNOSTICS_CLOSED" });
  assert.throws(() => probe.finishMemoryFlow(cap, "OMIT-ROOT", true), { code: "MEMORY_DIAGNOSTICS_CLOSED" });
});

test("diagnostic envelopes have a 64KiB transport bound and cannot retain arbitrary fields", async (t) => {
  const { probe, grant, post } = await setup(t);
  const cap = grant("claude");
  const body = { ...envelope("claude", "Stop"), padding: "x".repeat(65_536) };
  assert.equal((await post("/hook", body, cap)).status, 413);
  assert.equal(probe.report().memory.status, "failed");
  assert.ok(!JSON.stringify(probe.report()).includes("padding"));
});

test("observation overflow is rejected while receiving, before unbounded retention", async (t) => {
  const { probe, grant, deliver } = await setup(t);
  const cap = grant("claude");
  for (let index = 0; index < 512; index++) assert.equal((await deliver(cap, "claude", "Stop")).status, 202);
  assert.equal((await deliver(cap, "claude", "Stop")).status, 429);
  assert.equal(probe.report().memory.status, "failed");
});

async function command(argv, env = {}, stdin = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, { env: { ...process.env, ...env }, windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"], timeout: 5000, killSignal: "SIGKILL" });
    let stdout = "", stderr = "", bytes = 0;
    for (const [stream, save] of [[child.stdout, (text) => { stdout += text; }], [child.stderr, (text) => { stderr += text; }]]) {
      stream.on("data", (chunk) => { bytes += chunk.length; if (bytes > 131072) child.kill("SIGKILL"); else save(chunk.toString()); });
    }
    child.on("error", reject); child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.on("error", (error) => { if (error.code !== "EPIPE") reject(error); });
    child.stdin.end(stdin);
  });
}

async function collector(t, { event = "PreToolUse", extra = {}, memory = true, path = "/hook", status = 202 } = {}) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    requests.push({ auth: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    const isMemory = request.headers.authorization === "Bearer OMIT-FLOW-CAP";
    response.writeHead(isMemory ? status : 200, { "content-type": "application/json" });
    response.end(JSON.stringify(isMemory ? { observed: true } : {}));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const result = await command([file("hook.mjs")], { PROBE_CAP: "OMIT-CLAUDE-LAUNCH", PROBE_HOOK_CAP: "", PROBE_MEMORY_CAP: memory ? "OMIT-FLOW-CAP" : "",
    PROBE_MEMORY_PROVIDER: "claude", PROBE_HOOK_URL: `http://127.0.0.1:${server.address().port}${path}` }, JSON.stringify(native(event, {
      tool_use_id: "OMIT-TOOL", tool_name: "mcp__probe__identity_echo", prompt_id: "OMIT-PROMPT", prompt: "OMIT-CONTENT",
      transcript_path: "/OMIT-TRANSCRIPT", tool_input: { token: "OMIT-INPUT" }, authorization: "OMIT-AUTH", ...extra,
    })));
  return { ...result, requests };
}

test("collector keeps original registration authority separate from projected observation authority", async (t) => {
  const result = await collector(t);
  assert.equal(result.code, 0); assert.equal(result.stdout, "{}"); assert.equal(result.requests.length, 2);
  assert.equal(result.requests[0].auth, "Bearer OMIT-CLAUDE-LAUNCH");
  assert.equal(result.requests[0].body.hook_event_name, "PreToolUse");
  assert.equal(result.requests[1].auth, "Bearer OMIT-FLOW-CAP");
  assert.equal(result.requests[1].body.memory.event, "PreToolUse");
  const wire = JSON.stringify(result.requests);
  for (const value of ["OMIT-CONTENT", "OMIT-TRANSCRIPT", "OMIT-INPUT", "OMIT-AUTH"]) assert.ok(!wire.includes(value));
});

test("collector sends prompt observations without inventing identity registration", async (t) => {
  const result = await collector(t, { event: "UserPromptSubmit" });
  assert.equal(result.code, 0); assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].auth, "Bearer OMIT-FLOW-CAP");
  assert.equal(result.requests[0].body.memory.promptId, "OMIT-PROMPT");
});

test("collector rejects oversized UTF-8 content before forwarding either request", async (t) => {
  const result = await collector(t, { extra: { prompt: "🍎".repeat(17_000) } });
  assert.equal(result.code, 1); assert.equal(result.requests.length, 0);
  assert.equal(result.stdout, ""); assert.equal(result.stderr, "identity probe hook failed\n");
});

test("collector fails on rejected observation without printing payload or capability", async (t) => {
  const result = await collector(t, { status: 403 });
  assert.equal(result.requests.length, 2); assert.equal(result.code, 1);
  assert.equal(result.stdout, ""); assert.equal(result.stderr, "identity probe hook failed\n");
});

test("collector default remains one legacy request without diagnostic envelope", async (t) => {
  const result = await collector(t, { memory: false });
  assert.equal(result.code, 0); assert.equal(result.requests.length, 1);
  assert.equal(Object.hasOwn(result.requests[0].body, "memory"), false);
});

test("optional diagnostic plan keeps the default invocation count and exact prompts", async () => {
  const base = [file("run.mjs"), "--client", "codex", "--hook-type", "command", "--dry-run"];
  const before = await command(base), after = await command([...base, "--memory-hooks"]);
  assert.equal(before.code, 0); assert.equal(after.code, 0);
  const prompts = (text) => text.trim().split("\n").map((line) => line.match(/(?:Call|First call).*done\./)?.[0]);
  assert.deepEqual(prompts(after.stdout), prompts(before.stdout));
  assert.equal(prompts(before.stdout).length, 5); assert.ok(prompts(before.stdout).every(Boolean));
  for (const event of ["SessionStart", "SubagentStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]) assert.ok(after.stdout.includes(`hooks.${event}=`));
});

for (const extra of [["--backend", "production", "--hook-type", "command"], ["--hook-type", "http"]]) {
  test(`memory diagnostics reject incompatible options ${extra.join(" ")}`, async () => {
    const result = await command([file("run.mjs"), "--memory-hooks", "--dry-run", ...extra]);
    assert.equal(result.code, 1); assert.equal(result.stdout, "");
    assert.match(result.stderr, /invalid memory hook options/);
  });
}

const hookCommand = "node /reviewed/identity-collector.mjs";
const configArgs = ["-c", "features.hooks=true", ...["SessionStart", "SubagentStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]
  .flatMap((event) => ["-c", `hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(hookCommand)},timeout=15}]}]`])];
function trustOptions(mode = "valid") {
  const cwd = process.cwd();
  return { command: process.execPath, commandPrefix: [file("codex-app-server.fixture.mjs")], configArgs, cwd, hookCommand, memoryHooks: true,
    env: { ...process.env, PROBE_TEST_SPEC: JSON.stringify({ mode, cwd, hookCommand, configArgs, memoryHooks: true }) }, timeoutMs: 5000, maxOutputBytes: 16384 };
}
test("optional Codex trust lists and verifies all six exact declarations", async () => {
  const result = await prepareCodexHookTrust(trustOptions());
  assert.deepEqual(result.evidence, { status: "trusted", discovered: 6, verified: 6 });
  assert.equal((result.configArgs.at(-1).match(/trusted_hash/g) ?? []).length, 6);
  assert.ok(!result.configArgs.at(-1).includes("unrelated"));
});
for (const [mode, code] of [["missing", "HOOK_TRUST_DECLARATION"], ["duplicate", "HOOK_TRUST_DECLARATION"],
  ["wrong-command", "HOOK_TRUST_DECLARATION"], ["changed-second", "HOOK_TRUST_VERIFICATION"]]) {
  test(`optional Codex trust rejects ${mode}`, async () => {
    await assert.rejects(prepareCodexHookTrust(trustOptions(mode)), { code });
  });
}
