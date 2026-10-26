// Pure-node self-test of the probe server (no native client, no dependency). Run: node --test server.selftest.mjs
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { createProbeServer } from "./server.mjs";

const capability = "selftest-capability-not-a-secret";
const probe = createProbeServer({ capability });
let port;

before(async () => {
  port = await probe.listen();
});
after(() => probe.close());

// One agent per call forces a fresh socket, i.e. a "reconnect".
function post(path, body, { auth = `Bearer ${capability}`, keepAlive = false } = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const request = http.request(
      {
        host: "127.0.0.1", port, path, method: "POST", agent: new http.Agent({ keepAlive }),
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), ...(auth ? { authorization: auth } : {}) },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: response.statusCode, body: text ? JSON.parse(text) : undefined, text });
        });
      },
    );
    request.on("error", reject);
    request.end(data);
  });
}

const call = (meta, id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "identity_echo", arguments: {}, _meta: meta } });

test("unauthenticated or wrongly authenticated requests are rejected before any dispatch", async () => {
  const before = probe.report().stats;
  for (const auth of [null, "Bearer wrong", capability]) {
    const answer = await post("/mcp", call({ threadId: "T-secret-1", sessionId: "T-secret-1" }), { auth });
    assert.equal(answer.status, 401);
  }
  const after = probe.report().stats;
  assert.equal(after.authRejected - before.authRejected, 3);
  assert.equal(after.bound, before.bound);
});

test("codex: two threads are distinct, a reconnect keeps the identity, child lineage is told from root", async () => {
  const root = { threadId: "THREAD-ROOT-AAA", sessionId: "THREAD-ROOT-AAA" };
  const other = { threadId: "THREAD-OTHER-BBB", sessionId: "THREAD-OTHER-BBB" };
  const child = { threadId: "THREAD-CHILD-CCC", sessionId: "THREAD-ROOT-AAA" };
  const first = await post("/mcp", call(root));
  const second = await post("/mcp", call(other));
  const reconnected = await post("/mcp", call(root));
  const kid = await post("/mcp", call(child));
  const seen = [first, second, reconnected, kid].map((answer) => JSON.parse(answer.body.result.content[0].text));
  assert.notEqual(seen[0].identity, seen[1].identity);
  assert.equal(seen[0].identity, seen[2].identity);
  assert.notEqual(seen[0].connection, seen[2].connection);
  assert.equal(seen[0].lineage, "root");
  assert.equal(seen[3].lineage, "child");
  assert.equal(seen[3].session, seen[0].session);
  assert.notEqual(seen[3].identity, seen[0].identity);
  for (const answer of [first, second, reconnected, kid]) assert.ok(!/THREAD-|selftest-cap/.test(answer.text));
});

test("claude: only a hook-registered tool_use_id resolves; unknown or missing is unbound before the tool", async () => {
  const hook = (extra) => ({ hook_event_name: "PreToolUse", tool_name: "mcp__probe__identity_echo", ...extra });
  await post("/hook", hook({ tool_use_id: "toolu_AAA", session_id: "SESSION-ONE" }));
  await post("/hook", hook({ tool_use_id: "toolu_BBB", session_id: "SESSION-ONE", agent_id: "AGENT-X" }));
  await post("/hook", hook({ tool_use_id: "toolu_CCC", session_id: "SESSION-TWO" }));
  await post("/hook", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_DDD", session_id: "SESSION-ONE" });
  const bound = async (id) => (await post("/mcp", call({ "claudecode/toolUseId": id }))).body;
  const a = JSON.parse((await bound("toolu_AAA")).result.content[0].text);
  const b = JSON.parse((await bound("toolu_BBB")).result.content[0].text);
  const c = JSON.parse((await bound("toolu_CCC")).result.content[0].text);
  assert.deepEqual([a.lineage, b.lineage, c.lineage], ["root", "child", "root"]);
  assert.equal(a.session, b.session);
  assert.notEqual(a.session, c.session);
  const before = probe.report().stats;
  const unknown = await bound("toolu_DDD");
  const missing = (await post("/mcp", call(undefined))).body;
  assert.equal(unknown.error.message, "unbound identity");
  assert.equal(missing.error.message, "unbound identity");
  const after = probe.report().stats;
  assert.equal(after.unbound - before.unbound, 2);
  assert.equal(after.bound, before.bound);
});

test("identity in tool arguments is ignored", async () => {
  const forged = { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "identity_echo", arguments: { threadId: "FORGED", sessionId: "FORGED" } } };
  const answer = (await post("/mcp", forged)).body;
  assert.equal(answer.error.message, "unbound identity");
  assert.ok(probe.report().argumentKeys.includes("threadId"));
});

test("the report carries aliases, counts and key names only", () => {
  const text = JSON.stringify(probe.report());
  assert.ok(!/THREAD-|SESSION-|AGENT-|toolu_|selftest-cap/.test(text));
});
