// Run only with the coordinator's remote test admission. No native client or model is invoked.
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createProbeServer } from "./server.mjs";

async function fixture(action) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "native-overlap-test-")));
  const launches = ["codex", "claude"].map((provider) => {
    const home = join(directory, provider);
    mkdirSync(home);
    return { provider, home, workspace: directory, capability: `synthetic-${provider}-scope` };
  });
  const probe = createProbeServer({ launches });
  const port = await probe.listen();
  const post = (launch, path, body) => {
    let request;
    const promise = new Promise((resolve, reject) => {
      request = http.request({ hostname: "127.0.0.1", port, path, method: "POST", headers: { authorization: `Bearer ${launch.capability}`, "content-type": "application/json" } }, (response) => {
        let text = "";
        response.on("data", (chunk) => { text += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
      });
      request.on("error", reject);
      request.end(JSON.stringify(body));
    });
    return { promise, disconnect: () => request.destroy(new Error("synthetic disconnect")) };
  };
  const call = (launch, id) => post(launch, "/mcp", {
    jsonrpc: "2.0", id, method: "tools/call", params: { name: "identity_echo", arguments: {},
      _meta: launch.provider === "codex" ? { threadId: id, sessionId: id } : { "claudecode/toolUseId": id } },
  });
  try {
    for (const id of ["first", "second"]) {
      await post(launches[0], "/hook", { hook_event_name: "SessionStart", session_id: id, cwd: directory }).promise;
    }
    await post(launches[1], "/hook", { hook_event_name: "PreToolUse", session_id: "claude-session", tool_use_id: "claude-call", tool_name: "mcp__probe__identity_echo", cwd: directory }).promise;
    await action({ probe, launches, call });
  } finally {
    await probe.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const visible = (response) => JSON.parse(response.body.result.content[0].text);

test("barrier holds the first response until a distinct authenticated root arrives", async () => {
  await fixture(async ({ probe, launches: [codex], call }) => {
    const barrier = probe.armBarrier({ providers: ["codex", "codex"], timeoutMs: 2000 });
    let firstSettled = false;
    const first = call(codex, "first").promise.then((answer) => { firstSettled = true; return answer; });
    await barrier.firstArrival;
    assert.equal(firstSettled, false);
    const results = await Promise.all([first, call(codex, "second").promise]);
    assert.equal((await barrier.result).overlapVerified, true);
    assert.ok(results.every((answer) => visible(answer).overlapVerified === true));
    assert.equal(visible(results[0]).barrier, visible(results[1]).barrier);
    assert.notEqual(visible(results[0]).identity, visible(results[1]).identity);
  });
});

test("barrier proves a mixed Claude and Codex pair, not two calls from one provider", async () => {
  await fixture(async ({ probe, launches: [codex, claude], call }) => {
    const barrier = probe.armBarrier({ providers: ["claude", "codex"], timeoutMs: 2000 });
    const first = call(codex, "first").promise;
    await barrier.firstArrival;
    const rejected = await call(codex, "second").promise;
    assert.equal(rejected.body.error.message, "overlap participant rejected");
    const results = await Promise.all([first, call(claude, "claude-call").promise]);
    const evidence = await barrier.result;
    assert.deepEqual(evidence.providers.sort(), ["claude", "codex"]);
    assert.equal(evidence.overlapVerified, true);
    assert.ok(results.every((answer) => visible(answer).overlapVerified === true));
  });
});

test("duplicate identity cannot satisfy a two-root barrier and cancellation releases the waiter", async () => {
  await fixture(async ({ probe, launches: [codex], call }) => {
    const barrier = probe.armBarrier({ providers: ["codex", "codex"], timeoutMs: 2000 });
    const first = call(codex, "first").promise;
    await barrier.firstArrival;
    const duplicate = await call(codex, "first").promise;
    assert.equal(duplicate.body.error.message, "overlap participant rejected");
    barrier.cancel();
    assert.equal((await first).body.error.message, "overlap not established");
    assert.equal((await barrier.result).overlapVerified, false);
  });
});

test("disconnecting the waiting request prevents overlap evidence", async () => {
  await fixture(async ({ probe, launches: [codex], call }) => {
    const barrier = probe.armBarrier({ providers: ["codex", "codex"], timeoutMs: 2000 });
    const first = call(codex, "first");
    const disconnected = assert.rejects(first.promise, /synthetic disconnect/);
    await barrier.firstArrival;
    first.disconnect();
    await disconnected;
    assert.equal((await barrier.result).overlapVerified, false);
    assert.ok(probe.report().calls.every((record) => record.overlapVerified !== true));
  });
});

test("an unfilled barrier expires and releases its waiting response without proof", async () => {
  await fixture(async ({ probe, launches: [codex], call }) => {
    let expire;
    const barrier = probe.armBarrier({ providers: ["codex", "codex"], timeoutMs: 100,
      scheduleTimeout: (callback) => { expire = callback; return 1; }, cancelTimeout: () => {},
    });
    const first = call(codex, "first").promise;
    await barrier.firstArrival;
    expire();
    assert.equal((await barrier.result).overlapVerified, false);
    assert.equal((await first).body.error.message, "overlap not established");
    assert.ok(probe.report().calls.every((record) => record.overlapVerified !== true));
  });
});
