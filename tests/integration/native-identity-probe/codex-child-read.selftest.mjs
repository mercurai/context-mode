// Offline bounded app-server protocol test; subprocess is a synthetic peer, never Codex.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readCodexChild, readCodexParent } from "./codex-hook-trust.mjs";

const fixture = fileURLToPath(new URL("./codex-app-server.fixture.mjs", import.meta.url));
const cwd = process.cwd(), childId = "synthetic-child", parentId = "synthetic-root";
const configArgs = ["-c", "features.hooks=true", "-c", 'hooks.state={"reviewed"={enabled=true,trusted_hash="synthetic"}}'];
const options = (mode = "valid", extra = {}) => ({
  command: process.execPath, commandPrefix: [fixture], cwd, childId, parentId, configArgs,
  env: { ...process.env, CODEX_HOME: "/synthetic/explicit-home", PROBE_TEST_SPEC: JSON.stringify({
    threadRead: true, mode, cwd, childId, parentId, configArgs,
  }) }, timeoutMs: 5000, maxOutputBytes: 4096, ...extra,
});

function parentOptions(mode = "valid", extra = {}) {
  const value = options(mode);
  delete value.childId;
  value.env.PROBE_TEST_SPEC = JSON.stringify({ threadRead: true, parentRead: true, mode, cwd, childId, parentId, configArgs });
  return { ...value, ...extra };
}
test("parent reader requests only the parsed parent id and projects private history before returning", async () => {
  const children = [];
  const evidence = await readCodexParent(parentOptions("valid", { spawnProcess: (command, argv, spawnOptions) => {
    assert.deepEqual(argv, [fixture, "app-server", "--stdio", ...configArgs]);
    assert.equal(spawnOptions.cwd, cwd);
    assert.equal(spawnOptions.env.CODEX_HOME, "/synthetic/explicit-home");
    const process = spawn(command, argv, spawnOptions); children.push(process); return process;
  } }));
  assert.deepEqual(evidence, { sessionId: parentId, model: "synthetic-model",
    children: [{ id: childId, parentId }], startedActivities: 1, completedActivities: 0 });
  assert.ok(!JSON.stringify(evidence).includes("private"));
  assert.equal(children.length, 1);
  assert.ok(children[0].exitCode !== null || children[0].signalCode !== null);
});
for (const mode of ["wrong-parent", "wrong-cwd"]) {
  test("parent reader rejects " + mode + " history without exposing it", async () => {
    await assert.rejects(readCodexParent(parentOptions(mode)), (error) => {
      assert.equal(error.code, "PRODUCTION_EVIDENCE_INVALID");
      assert.ok(!error.message.includes("private")); return true;
    });
  });
}
test("parent reader requires exact identity, workspace and home before spawning", async () => {
  for (const field of ["parentId", "cwd", "env"]) {
    let spawned = false;
    await assert.rejects(readCodexParent(parentOptions("valid", { [field]: undefined,
      spawnProcess: () => { spawned = true; throw new Error("private forbidden spawn"); },
    })), { code: "PRODUCTION_EVIDENCE_INVALID" });
    assert.equal(spawned, false);
  }
});

test("child reader requests only exact returned id, retains launch config/home and closes its owned process", async () => {
  const children = [];
  const evidence = await readCodexChild(options("valid", { spawnProcess: (command, argv, spawnOptions) => {
    assert.deepEqual(argv, [fixture, "app-server", "--stdio", ...configArgs]);
    assert.equal(spawnOptions.cwd, cwd);
    assert.equal(spawnOptions.env.CODEX_HOME, "/synthetic/explicit-home");
    const process = spawn(command, argv, spawnOptions); children.push(process); return process;
  } }));
  assert.equal(evidence.sessionId, parentId);
  assert.equal(evidence.calls.length, 1);
  assert.equal(evidence.calls[0].owner, childId);
  assert.equal(evidence.calls[0].name, "ctx_stats");
  assert.equal(children.length, 1);
  assert.ok(children.every((process) => process.exitCode !== null || process.signalCode !== null));
});

for (const mode of ["wrong-child", "wrong-parent"]) {
  test(`child reader rejects ${mode} returned history`, async () => {
    await assert.rejects(readCodexChild(options(mode)), { code: "PRODUCTION_EVIDENCE_INVALID" });
  });
}
for (const [mode, code] of [["malformed", "HOOK_TRUST_PROTOCOL"], ["rpc-error", "HOOK_TRUST_PROTOCOL"],
  ["early-exit", "HOOK_TRUST_PROCESS"], ["output-limit", "HOOK_TRUST_OUTPUT_LIMIT"], ["stderr-limit", "HOOK_TRUST_OUTPUT_LIMIT"]]) {
  test(`child reader shares bounded redacted transport for ${mode}`, async () => {
    await assert.rejects(readCodexChild(options(mode)), (error) => {
      assert.equal(error.code, code);
      assert.ok(!error.message.includes("private"));
      return true;
    });
  });
}
test("child reader deadline closes its owned process before rejecting", async () => {
  let expire, cancelled = 0;
  const children = [];
  await assert.rejects(readCodexChild(options("stall", {
    scheduleTimeout: (callback) => { expire = callback; return 1; }, cancelTimeout: () => { cancelled += 1; },
    spawnProcess: (...args) => {
      const process = spawn(...args); children.push(process);
      process.stdout.on("data", (chunk) => { if (chunk.toString().includes("fixture/ready")) expire(); });
      return process;
    },
  })), { code: "HOOK_TRUST_TIMEOUT" });
  assert.equal(cancelled, 1);
  assert.equal(children.length, 1);
  assert.ok(children[0].exitCode !== null || children[0].signalCode !== null);
});
test("missing child or parent id fails before spawning, with no latest-session fallback", async () => {
  for (const field of ["childId", "parentId"]) {
    let spawned = false;
    await assert.rejects(readCodexChild(options("valid", { [field]: undefined,
      spawnProcess: () => { spawned = true; throw new Error("unexpected spawn"); },
    })), { code: "PRODUCTION_EVIDENCE_INVALID" });
    assert.equal(spawned, false);
  }
});
