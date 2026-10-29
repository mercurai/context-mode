import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const clientUrl = new URL("../../hooks/shared-service.mjs", import.meta.url);
const capability = "synthetic-hook-capability-for-test-only";
const native = (event, extra = {}) => ({ hook_event_name: event, session_id: "root-a",
  cwd: "/synthetic/workspace", ...extra });
const receipt = (status, extra = {}) => ({ memory: { status, ...extra } });
const recover = (event, text) => ({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });

async function fixture(t, handler) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    calls.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(raw) });
    await handler(req, res, calls);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const env = { CONTEXT_MODE_SHARED_HOOK_URL: `http://127.0.0.1:${server.address().port}/hooks`,
    CONTEXT_MODE_SHARED_HOOK_CAP: capability, CONTEXT_MODE_SHARED_PROVIDER: "claude-code",
    CONTEXT_MODE_SHARED_MCP_SERVER: "context-mode" };
  async function run(payload, overrides = {}, signal = new AbortController().signal) {
    const { runSharedHook } = await import(clientUrl);
    return runSharedHook({ env: { ...env, ...overrides },
      input: Readable.from([typeof payload === "string" ? payload : JSON.stringify(payload)]), signal });
  }
  return { env, calls, run };
}

function send(res, body, status = 202) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

test("Claude start projects identity and returns the provider recovery envelope", async (t) => {
  const f = await fixture(t, (_req, res) => send(res, receipt("recovered", { recovery: "remember orchard" })));
  const output = await f.run(native("SessionStart", { transcript_path: "never-read", token: "never-forward", source: "resume" }));
  assert.deepEqual(output, recover("SessionStart", "remember orchard"));
  assert.deepEqual(f.calls, [{ url: "/hooks", authorization: `Bearer ${capability}`,
    body: { memory: native("SessionStart") } }]);
});

for (const event of ["SessionStart", "SubagentStart"]) {
  test(`Codex ${event} registers callable identity before memory recovery`, async (t) => {
    const input = native(event, event === "SubagentStart" ? { agent_id: "child-a" } : {});
    const f = await fixture(t, (_req, res, calls) => send(res,
      calls.length === 1 ? { registered: true } : receipt("recovered", { recovery: "scoped context" })));
    assert.deepEqual(await f.run(input, { CONTEXT_MODE_SHARED_PROVIDER: "codex" }), recover(event, "scoped context"));
    assert.deepEqual(f.calls.map((x) => x.body), [input, { memory: input }]);
  });
}

test("Claude context MCP registration precedes memory enrollment", async (t) => {
  const f = await fixture(t, (_req, res, calls) => send(res, calls.length === 1 ? { registered: true } : receipt("registered")));
  const input = native("PreToolUse", { tool_use_id: "call-a", tool_name: "mcp__context-mode__ctx_search" });
  assert.deepEqual(await f.run({ ...input, tool_input: { queries: ["private input"] } }), {});
  assert.deepEqual(f.calls.map((x) => x.body), [input, { memory: input }]);
});

test("large index input does not prevent identity-only MCP registration", async (t) => {
  const f = await fixture(t, (_req, res, calls) => send(res, calls.length === 1 ? { registered: true } : receipt("registered")));
  const input = native("PreToolUse", { tool_use_id: "large-index", tool_name: "mcp__context-mode__ctx_index" });
  assert.deepEqual(await f.run({ ...input, tool_input: { content: "a".repeat(1_048_576) } }), {});
  assert.deepEqual(f.calls.map((x) => x.body), [input, { memory: input }]);
});

test("ordinary tools and other MCP servers enroll memory without granting MCP authority", async (t) => {
  const f = await fixture(t, (_req, res) => send(res, receipt("registered")));
  for (const tool_name of ["Read", "mcp__unrelated__ctx_search"]) {
    await f.run(native("PreToolUse", { tool_use_id: tool_name, tool_name, tool_input: { path: "ignored" } }));
  }
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every((x) => Object.keys(x.body).join() === "memory"));
  assert.ok(f.calls.every((x) => !Object.hasOwn(x.body.memory, "tool_input")));
});

for (const event of ["PostToolUse", "PostToolUseFailure"]) {
  test(`${event} forwards only required delivery fields`, async (t) => {
    const f = await fixture(t, (_req, res) => send(res, receipt("applied")));
    const input = native(event, { tool_use_id: "call-a", tool_name: "Read", tool_input: { path: "a.ts" },
      ...(event === "PostToolUse" ? { tool_response: { content: "file contents" } } : { error: "file missing" }) });
    assert.deepEqual(await f.run({ ...input, transcript_path: "never-open", unknown: "never-forward" }), {});
    assert.deepEqual(f.calls.map((x) => x.body), [{ memory: input }]);
  });
}

test("Claude prompt keeps the native delivery id and duplicate receipt is successful", async (t) => {
  const f = await fixture(t, (_req, res) => send(res, receipt("duplicate")));
  const input = native("UserPromptSubmit", { prompt_id: "prompt-a", prompt: "remember orchard" });
  assert.deepEqual(await f.run({ ...input, transcript_path: "never-open" }), {});
  assert.deepEqual(f.calls[0].body, { memory: input });
});

test("unsupported Codex prompt and failure events never send caller-supplied identities", async (t) => {
  const f = await fixture(t, (_req, res) => send(res, receipt("applied")));
  for (const event of ["UserPromptSubmit", "PostToolUseFailure", "Stop", "PreCompact"]) {
    await assert.rejects(f.run(native(event, { prompt_id: "forged", prompt: "not accepted" }),
      { CONTEXT_MODE_SHARED_PROVIDER: "codex" }), /Shared hook unsupported/);
  }
  assert.equal(f.calls.length, 0);
});

test("configuration rejects non-loopback, URL credentials, query, redirects and incomplete authority", async (t) => {
  const f = await fixture(t, (_req, res) => send(res, receipt("recovered", { recovery: "" })));
  for (const url of ["http://example.com/hooks", "http://localhost/hooks", "https://127.0.0.1/hooks",
    "http://127.0.0.1/hooks?token=x", "http://user:pass@127.0.0.1/hooks", "http://127.0.0.1/mcp",
    "http://127.0.0.1/hooks#fragment"]) {
    await assert.rejects(f.run(native("SessionStart"), { CONTEXT_MODE_SHARED_HOOK_URL: url }), /Shared hook invalid/);
  }
  for (const field of ["CONTEXT_MODE_SHARED_HOOK_CAP", "CONTEXT_MODE_SHARED_PROVIDER", "CONTEXT_MODE_SHARED_MCP_SERVER"]) {
    await assert.rejects(f.run(native("SessionStart"), { [field]: "" }), /Shared hook invalid/);
  }
  assert.equal(f.calls.length, 0);
});

test("HTTP redirect cannot forward the capability to a second route", async (t) => {
  const f = await fixture(t, (_req, res) => { res.writeHead(307, { location: "/leak" }); res.end(); });
  await assert.rejects(f.run(native("SessionStart")), /Shared hook unavailable/);
  assert.deepEqual(f.calls.map((x) => x.url), ["/hooks"]);
});

test("missing or false ordinary registration prevents the dependent request", async (t) => {
  const f = await fixture(t, (_req, res) => send(res, { registered: false }));
  await assert.rejects(f.run(native("SessionStart"), { CONTEXT_MODE_SHARED_PROVIDER: "codex" }), /Shared hook invalid/);
  assert.equal(f.calls.length, 1);
});

test("untrusted service bodies never become hook decisions or diagnostics", async (t) => {
  let body = { memory: { status: "recovered", recovery: "ok" }, continue: false };
  const f = await fixture(t, (_req, res) => send(res, body));
  for (const value of [body, receipt("recovered", { recovery: "ok", permissionDecision: "allow" }),
    receipt("applied"), receipt("recovered", { recovery: 123 }), receipt("recovered", { recovery: "x".repeat(10001) })]) {
    body = value;
    await assert.rejects(f.run(native("SessionStart")), /Shared hook invalid/);
  }
});

test("input, serialized request and streamed response have bounded byte sizes", async (t) => {
  const f = await fixture(t, (_req, res) => { res.writeHead(202); res.write(" ".repeat(65536)); res.end("{}"); });
  await assert.rejects(f.run(" ".repeat(16 * 1024 * 1024 + 1)), /Shared hook capacity/);
  assert.equal(f.calls.length, 0);
  const input = native("UserPromptSubmit", { prompt_id: "a", prompt: "" });
  input.prompt = "x".repeat(65536 - Buffer.byteLength(JSON.stringify(input)));
  await assert.rejects(f.run(input), /Shared hook capacity/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.run(native("SessionStart")), /Shared hook capacity/);
});

test("abort closes an incomplete input without dispatching", async (t) => {
  const f = await fixture(t, (_req, res) => send(res, receipt("registered")));
  const { runSharedHook } = await import(clientUrl);
  const controller = new AbortController();
  const input = new Readable({ read() { controller.abort(); } });
  await assert.rejects(runSharedHook({ env: f.env, input, signal: controller.signal }), /Shared hook unavailable/);
  assert.equal(input.destroyed, true);
  assert.equal(f.calls.length, 0);
});

test("abort during HTTP response closes the request and emits no partial recovery", async (t) => {
  const controller = new AbortController();
  const f = await fixture(t, (_req, res) => { res.writeHead(202); res.write('{"memory":'); controller.abort(); });
  await assert.rejects(f.run(native("SessionStart"), {}, controller.signal), /Shared hook unavailable/);
  assert.equal(f.calls.length, 1);
});

test("CLI prints only the validated envelope and fixed errors", async (t) => {
  let good = true;
  const f = await fixture(t, (_req, res) => send(res, good ? receipt("recovered", { recovery: "orchard" }) :
    { error: `do not print ${capability}` }, good ? 202 : 401));
  async function cli() {
    const child = spawn(process.execPath, [fileURLToPath(clientUrl)], { env: { ...process.env, ...f.env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (x) => { stdout += x; }); child.stderr.on("data", (x) => { stderr += x; });
    child.stdin.end(JSON.stringify(native("SessionStart")));
    const exit = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    return { exit, stdout, stderr };
  }
  assert.deepEqual(await cli(), { exit: 0, stdout: JSON.stringify(recover("SessionStart", "orchard")) + "\n", stderr: "" });
  good = false;
  assert.deepEqual(await cli(), { exit: 1, stdout: "", stderr: "context-mode shared hook failed\n" });
});
