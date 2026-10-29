// Pure-node self-test of the probe server (no native client, no dependency). Run: node --test server.selftest.mjs
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createProbeServer } from "./server.mjs";
import { receiptPassed, runClient, summarize, version } from "./run.mjs";

const capability = "selftest-capability-not-a-secret";
const probe = createProbeServer({ capability });
let port;

before(async () => {
  port = await probe.listen();
});
after(() => probe.close());

// One agent per call forces a fresh socket, i.e. a "reconnect".
function post(path, body, { auth = `Bearer ${capability}`, keepAlive = false, targetPort = port } = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const request = http.request(
      {
        host: "127.0.0.1", port: targetPort, path, method: "POST", agent: new http.Agent({ keepAlive }),
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

// Synthetic receipts exercise the same acceptance code used by a native run.
function completeFlows() {
  const record = (identity, session, connection, lineage = "root") => ({
    bound: true, kind: "codex", identity, session, connection, lineage,
  });
  const flow = (name, ownAlias, calls, concurrent = false) => ({
    client: "codex", name, ownAlias, calls, concurrent,
    exit: 0, timedOut: false, boundToOwnNativeId: true,
  });
  return [
    flow("root-A", "u1", [record("u1", "s1", "c1")]),
    flow("root-B", "u2", [record("u2", "s2", "c2")]),
    flow("resume-A", "u1", [record("u1", "s1", "c3")]),
    flow("child", "u3", [record("u3", "s3", "c4"), record("u4", "s3", "c5", "child")]),
    flow("concurrent-1", "u5", [record("u5", "s5", "c6")], true),
    flow("concurrent-2", "u6", [record("u6", "s6", "c7")], true),
  ];
}

function completeReceipt(flows = completeFlows()) {
  return {
    flows,
    checks: summarize(flows),
    negatives: { noAuthRejected401: true, unboundCallRejectedBeforeTool: true },
    stats: { bound: 7, unbound: 0, authRejected: 0 },
  };
}

test("summary refuses missing native identities instead of vacuous success", () => {
  assert.equal(summarize([]).codex.allFlowsBoundToOwnNativeId, false);
  const flows = completeFlows();
  flows[1].boundToOwnNativeId = null;
  assert.equal(summarize(flows).codex.allFlowsBoundToOwnNativeId, false);
});

test("concurrent proof requires this pair's actual calls, not previously seen aliases", () => {
  const flows = completeFlows();
  flows[4].calls = [];
  assert.equal(summarize(flows).codex.concurrentRootsDistinct, false);
  flows[4].calls = [{ ...flows[5].calls[0] }];
  assert.equal(summarize(flows).codex.concurrentRootsDistinct, false);
});

test("receipt accepts all required evidence for the selected client only", () => {
  assert.equal(receiptPassed(completeReceipt(), ["codex"]), true);
  assert.equal(receiptPassed(completeReceipt(), ["claude", "codex"]), false);
});

test("receipt rejects failed, missing, duplicate, timed out or unbound flows", () => {
  const mutations = [
    (r) => { r.flows[0].exit = 1; },
    (r) => { r.flows[0].timedOut = true; },
    (r) => { r.flows[0].boundToOwnNativeId = null; },
    (r) => { r.flows.pop(); },
    (r) => { r.flows.push({ ...r.flows[0] }); },
    (r) => { r.flows[0].calls.push({ ...r.flows[0].calls[0] }); },
    (r) => { r.stats.bound = 8; },
    (r) => { r.stats.unbound = 1; },
    (r) => { r.negatives.noAuthRejected401 = false; },
    (r) => { r.checks.codex.resumeKeepsIdentity = null; },
  ];
  for (const mutate of mutations) {
    const receipt = completeReceipt();
    mutate(receipt);
    assert.equal(receiptPassed(receipt, ["codex"]), false);
  }
});

test("client spawn failure settles as a bounded failure result", async () => {
  const result = await runClient("nonexistent-context-probe-client-7b3ca0", [], {}, process.cwd());
  assert.equal(result.failure, "spawn-error");
  assert.equal(result.code, null);
  assert.equal(result.stdout, "");
});

test("client output is bounded and overflow invalidates the flow", async () => {
  const result = await runClient(process.execPath, ["-e", "process.stdout.write('x'.repeat(4096))"], {}, process.cwd(), {
    maxOutputBytes: 128,
  });
  assert.equal(result.failure, "output-limit");
  assert.ok(Buffer.byteLength(result.stdout) <= 128);
});

test("the real runner exits before model calls when native hook preflight fails", () => {
  // Node is intentionally substituted for Codex; no authenticated client or model is invoked.
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./run.mjs", import.meta.url)), "--client", "codex", "--codex-bin", process.execPath], {
    encoding: "utf8", env: { PATH: dirname(process.execPath), CODEX_HOME: dirname(process.execPath) }, timeout: 15_000, maxBuffer: 512 * 1024, windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.passed, false);
  assert.equal(receipt.flows.length, 0);
  assert.equal(receipt.modelCalls, 0);
  assert.deepEqual(receipt.codexHookTrust, { status: "failed" });
  assert.equal(receipt.stats.bound, 0);
});

async function withBindingProbe(action) {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "native-binding-test-")));
  const workspace = join(fixture, "worktree");
  mkdirSync(workspace);
  const launches = ["codex", "claude", "codex"].map((provider, index) => {
    const home = join(fixture, `home-${index}`);
    mkdirSync(home);
    return { provider, home, workspace, capability: `synthetic-launch-${index}` };
  });
  // The legacy arguments deliberately keep the baseline server reachable, so RED detects missing binding.
  const boundProbe = createProbeServer({ capability: launches[0].capability, expectedCwd: workspace, launches });
  const targetPort = await boundProbe.listen();
  const send = (launch, path, body) => post(path, body, { targetPort, auth: `Bearer ${launch.capability}` });
  try { await action({ launches, workspace, send, boundProbe }); }
  finally { await boundProbe.close(); rmSync(fixture, { recursive: true, force: true }); }
}

const codexStart = (sessionId, cwd, agentId) => ({
  hook_event_name: agentId ? "SubagentStart" : "SessionStart",
  session_id: sessionId, cwd, ...(agentId ? { agent_id: agentId } : {}),
});
const responseIdentity = (response) => JSON.parse(response.body.result.content[0].text);

test("binding: unknown native identifiers and forged tool arguments cannot establish a session", async () => {
  await withBindingProbe(async ({ launches: [launch], workspace, send, boundProbe }) => {
    const unknown = await send(launch, "/mcp", call({ threadId: "native-root", sessionId: "native-root" }));
    assert.equal(unknown.body.error?.message, "unbound identity");
    const forged = call(undefined);
    forged.params.arguments = { threadId: "native-root", sessionId: "native-root", cwd: workspace, home: launch.home };
    assert.equal((await send(launch, "/mcp", forged)).body.error?.message, "unbound identity");
    assert.equal(boundProbe.report().stats.bound, 0);
  });
});

test("binding: Codex native hooks bind root, resume and child to the authenticated workspace", async () => {
  await withBindingProbe(async ({ launches: [launch], workspace, send }) => {
    assert.equal((await send(launch, "/hook", codexStart("native-root", workspace))).status, 200);
    const root = responseIdentity(await send(launch, "/mcp", call({ threadId: "native-root", sessionId: "native-root" })));
    assert.equal((await send(launch, "/hook", codexStart("native-root", workspace))).status, 200);
    const resumed = responseIdentity(await send(launch, "/mcp", call({ threadId: "native-root", sessionId: "native-root" })));
    await send(launch, "/hook", codexStart("native-root", workspace, "native-child"));
    const child = responseIdentity(await send(launch, "/mcp", call({ threadId: "native-child", sessionId: "native-root" })));
    assert.equal(root.workspaceBound, true);
    assert.equal(child.workspaceBound, true);
    assert.equal(root.identity, resumed.identity);
    assert.notEqual(root.connection, resumed.connection);
    assert.notEqual(root.identity, child.identity);
    assert.equal(root.session, child.session);
    assert.equal(root.scope, child.scope);
    assert.equal(child.lineage, "child");
    assert.ok(!JSON.stringify([root, resumed, child]).includes(workspace));
  });
});

test("binding: wrong workspace and wrong provider cannot register or resolve a native identifier", async () => {
  await withBindingProbe(async ({ launches: [codex, claude], workspace, send, boundProbe }) => {
    const wrong = await send(codex, "/hook", codexStart("wrong-workspace", join(workspace, "elsewhere")));
    assert.equal(wrong.status, 403);
    assert.equal((await send(codex, "/mcp", call({ threadId: "wrong-workspace", sessionId: "wrong-workspace" }))).body.error?.message, "unbound identity");
    assert.equal((await send(claude, "/hook", codexStart("wrong-provider", workspace))).status, 403);
    assert.equal((await send(claude, "/mcp", call({ threadId: "wrong-provider", sessionId: "wrong-provider" }))).body.error?.message, "unbound identity");
    assert.equal(boundProbe.report().stats.bound, 0);
  });
});

test("binding: identical native identifiers in different authenticated homes remain distinct", async () => {
  await withBindingProbe(async ({ launches: [first, , second], workspace, send }) => {
    await send(first, "/hook", codexStart("same-native-id", workspace));
    await send(second, "/hook", codexStart("same-native-id", workspace));
    const a = responseIdentity(await send(first, "/mcp", call({ threadId: "same-native-id", sessionId: "same-native-id" })));
    const b = responseIdentity(await send(second, "/mcp", call({ threadId: "same-native-id", sessionId: "same-native-id" })));
    assert.notEqual(a.identity, b.identity);
    assert.notEqual(a.session, b.session);
    assert.notEqual(a.scope, b.scope);
    assert.equal(a.workspaceBound, true);
    assert.equal(b.workspaceBound, true);
  });
});

test("binding: conflicting lineage registrations fail closed without rebinding an identifier", async () => {
  await withBindingProbe(async ({ launches: [launch], workspace, send }) => {
    await send(launch, "/hook", codexStart("root-a", workspace));
    await send(launch, "/hook", codexStart("root-b", workspace));
    await send(launch, "/hook", codexStart("root-a", workspace, "child"));
    assert.equal((await send(launch, "/hook", codexStart("root-b", workspace, "child"))).status, 409);
    for (const root of ["root-a", "root-b"]) {
      assert.equal((await send(launch, "/mcp", call({ threadId: "child", sessionId: root }))).body.error?.message, "unbound identity");
    }
  });
});

test("binding: Claude tool-use registration requires the exact workspace and authenticated provider", async () => {
  await withBindingProbe(async ({ launches: [codex, claude], workspace, send }) => {
    const hook = { hook_event_name: "PreToolUse", tool_name: "mcp__probe__identity_echo", tool_use_id: "tool-valid", session_id: "claude-root", cwd: workspace };
    assert.equal((await send(claude, "/hook", hook)).status, 200);
    const bound = responseIdentity(await send(claude, "/mcp", call({ "claudecode/toolUseId": "tool-valid" })));
    assert.equal(bound.workspaceBound, true);
    assert.equal((await send(codex, "/mcp", call({ "claudecode/toolUseId": "tool-valid" }))).body.error?.message, "unbound identity");
    assert.equal((await send(claude, "/hook", { ...hook, tool_use_id: "tool-wrong", cwd: join(workspace, "other") })).status, 403);
    assert.equal((await send(claude, "/mcp", call({ "claudecode/toolUseId": "tool-wrong" }))).body.error?.message, "unbound identity");
  });
});

test("binding: required binding receipt rejects a missing workspace proof", () => {
  const receipt = completeReceipt();
  receipt.bindingRequired = true;
  assert.equal(receiptPassed(receipt, ["codex"]), false);
  for (const flow of receipt.flows) for (const call of flow.calls) Object.assign(call, { workspaceBound: true, scope: "l1" });
  assert.equal(receiptPassed(receipt, ["codex"]), true);
  receipt.flows[0].calls[0].workspaceBound = false;
  assert.equal(receiptPassed(receipt, ["codex"]), false);
});

test("binding: command collector forwards only native identity fields before tool dispatch", async () => {
  await withBindingProbe(async ({ launches: [launch], workspace, send, boundProbe }) => {
    const input = { ...codexStart("collector-root", workspace), transcript_path: "synthetic-omitted", tool_input: { text: "synthetic-omitted" }, prompt: "synthetic-omitted" };
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL("./hook.mjs", import.meta.url))], {
        env: { PROBE_CAP: launch.capability, PROBE_HOOK_URL: `http://127.0.0.1:${boundProbe.server.address().port}/hook` },
        stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(JSON.stringify(input));
    });
    assert.deepEqual(result, { code: 0, stdout: "{}", stderr: "" });
    assert.deepEqual(boundProbe.report().hookKeys, ["cwd", "hook_event_name", "session_id"]);
    const callResult = responseIdentity(await send(launch, "/mcp", call({ threadId: "collector-root", sessionId: "collector-root" })));
    assert.equal(callResult.workspaceBound, true);
  });
});

test("binding: collector refuses non-loopback destinations without exposing its capability", async () => {
  const result = await runClient(process.execPath, [fileURLToPath(new URL("./hook.mjs", import.meta.url))], {
    PROBE_CAP: "synthetic-collector-capability", PROBE_HOOK_URL: "https://example.test/hook",
  }, process.cwd());
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
});

test("version: a stalled harmless executable is classified as timeout", () => {
  // The baseline eventually exits itself, so RED cannot leave an indefinite child.
  const result = version(process.execPath, { args: ["-e", "setTimeout(() => process.stdout.write('late'), 1000)"], timeoutMs: 20 });
  assert.deepEqual(result, { status: "timeout" });
});

test("version: failure and excess output never become a version receipt", () => {
  assert.deepEqual(version("nonexistent-version-probe-1d8f"), { status: "spawn-error" });
  assert.deepEqual(version(process.execPath, { args: ["-e", "process.stdout.write('not a version'); process.exitCode=2"] }), { status: "failed" });
  assert.deepEqual(version(process.execPath, { args: ["-e", "process.stdout.write('x'.repeat(4096))"], maxOutputBytes: 128 }), { status: "output-limit" });
});

test("version: a successful bounded executable yields its version", () => {
  assert.deepEqual(version(process.execPath), { status: "ok", value: process.version });
});

function overlapReceipt(clients) {
  const flows = clients.flatMap((client) => completeFlows().map((flow) => ({
    ...flow, client, ownAlias: `${client}-${flow.ownAlias}`,
    calls: flow.calls.map((call) => ({ ...call, kind: client, identity: `${client}-${call.identity}`, session: `${client}-${call.session}`, workspaceBound: true, scope: client })),
  })));
  const barriers = [];
  for (const client of clients) {
    const barrier = `pair-${client}`;
    barriers.push({ barrier, providers: [client, client], overlapVerified: true });
    for (const flow of flows.filter((flow) => flow.client === client && flow.concurrent)) Object.assign(flow.calls[0], { barrier, overlapVerified: true });
  }
  if (clients.length === 2) {
    barriers.push({ barrier: "mixed-pair", providers: clients, overlapVerified: true });
    for (const client of clients) flows.push({
      ...flows.find((flow) => flow.client === client), name: "mixed", mixed: true,
      calls: [{ ...flows.find((flow) => flow.client === client).calls[0], barrier: "mixed-pair", overlapVerified: true }],
    });
  }
  return { ...completeReceipt(flows), bindingRequired: true, overlapRequired: true, barriers,
    stats: { bound: clients.length * (clients.length === 2 ? 8 : 7), unbound: 0, authRejected: 0 } };
}

test("overlap receipt requires the actual paired-call evidence for a single client", () => {
  const receipt = overlapReceipt(["codex"]);
  assert.equal(receiptPassed(receipt, ["codex"]), true);
  receipt.flows.find((flow) => flow.concurrent).calls[0].overlapVerified = false;
  assert.equal(receiptPassed(receipt, ["codex"]), false);
});

test("overlap receipt requires mixed providers and eight calls per client in all mode", () => {
  const receipt = overlapReceipt(["claude", "codex"]);
  assert.equal(receiptPassed(receipt, ["claude", "codex"]), true);
  receipt.barriers[2].providers = ["codex", "codex"];
  assert.equal(receiptPassed(receipt, ["claude", "codex"]), false);
  const missing = overlapReceipt(["claude", "codex"]);
  missing.flows = missing.flows.filter((flow) => !flow.mixed);
  missing.stats.bound = 14;
  assert.equal(receiptPassed(missing, ["claude", "codex"]), false);
});
