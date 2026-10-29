// Real command collector against a synthetic HTTP peer. No native clients or real grants.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const collector = fileURLToPath(new URL("./hook.mjs", import.meta.url));
async function collect({ path = "/hooks", hookCap = "synthetic-hook", status = 202, receipt = { registered: true } } = {}) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ path: request.url, authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(receipt));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const env = { ...process.env, PROBE_HOOK_URL: `http://127.0.0.1:${server.address().port}${path}`,
      PROBE_CAP: "synthetic-legacy", PROBE_MCP_CAP: "synthetic-mcp" };
    if (hookCap === undefined) delete env.PROBE_HOOK_CAP;
    else env.PROBE_HOOK_CAP = hookCap;
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [collector], { env, windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"], timeout: 5000, killSignal: "SIGKILL" });
      let stdout = "", stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
      child.stdin.end(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "synthetic-session",
        cwd: "/synthetic/workspace", tool_use_id: "synthetic-tool", tool_name: "mcp__probe__ctx_stats",
        prompt: "synthetic omitted prompt", transcript_path: "/synthetic/omitted-transcript", tool_input: { secret: "omitted" },
        home: "/untrusted/home", provider: "untrusted", launchId: "untrusted" }));
    });
    assert.ok(!result.stdout.includes("synthetic-") && !result.stderr.includes("synthetic-"));
    return { ...result, requests };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
test("production command collector sends only native identity fields using hook-purpose capability", async () => {
  const result = await collect();
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "{}");
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].path, "/hooks");
  assert.ok(result.requests[0].authorization === "Bearer synthetic-hook");
  assert.deepEqual(result.requests[0].body, { hook_event_name: "PreToolUse", session_id: "synthetic-session",
    cwd: "/synthetic/workspace", tool_use_id: "synthetic-tool", tool_name: "mcp__probe__ctx_stats" });
});
test("production hook never falls back to MCP or diagnostic capability", async () => {
  const result = await collect({ hookCap: "" });
  assert.equal(result.code, 1);
  assert.equal(result.requests.length, 0);
});
for (const [status, receipt] of [[200, { registered: true }], [202, { registered: false }], [401, { registered: true }]]) {
  test(`production collector fails closed on ${status}/${receipt.registered} registration receipt`, async () => {
    const result = await collect({ status, receipt });
    assert.equal(result.requests.length, 1); // Must reach the production path before testing response handling.
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
  });
}
test("historical diagnostic collector retains its separate legacy path and grant", async () => {
  const result = await collect({ path: "/hook", status: 200, receipt: {} });
  assert.equal(result.code, 0);
  assert.equal(result.requests.length, 1);
  assert.ok(result.requests[0].authorization === "Bearer synthetic-legacy");
});
