import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { prepareCodexHookTrust } from "./codex-hook-trust.mjs";

const fixture = fileURLToPath(new URL("./codex-app-server.fixture.mjs", import.meta.url));
const cwd = process.cwd();
const hookCommand = "node /reviewed/identity-collector.mjs";
const configArgs = ["-c", "features.hooks=true", "-c", 'mcp_servers.probe.url="http://127.0.0.1:1/mcp"',
  ...["SessionStart", "SubagentStart"].flatMap((event) => ["-c", `hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(hookCommand)},timeout=15}]}]`])];

function options(mode = "valid", extra = {}) {
  return {
    command: process.execPath, commandPrefix: [fixture], configArgs, cwd, hookCommand,
    env: { ...process.env, PROBE_TEST_SPEC: JSON.stringify({ mode, cwd, hookCommand, configArgs }) },
    timeoutMs: 5000, maxOutputBytes: 4096, ...extra,
  };
}

test("native listings establish exactly two trusted owned hooks without changing base config", async () => {
  const result = await prepareCodexHookTrust(options());
  assert.deepEqual(result.evidence, { status: "trusted", discovered: 2, verified: 2 });
  assert.deepEqual(result.configArgs.slice(0, configArgs.length), configArgs);
  assert.equal(result.configArgs.length, configArgs.length + 2);
  assert.equal(result.configArgs.at(-2), "-c");
  const state = result.configArgs.at(-1);
  assert.match(state, /^hooks\.state=\{/);
  assert.equal((state.match(/trusted_hash/g) ?? []).length, 2);
  assert.equal((state.match(/enabled=true/g) ?? []).length, 2);
  assert.ok(!state.includes("unrelated") && !state.includes("bypass"));
  assert.deepEqual(configArgs, options().configArgs);
});

for (const mode of ["missing", "duplicate", "wrong-command", "async", "disabled", "wrong-source", "bad-hash", "wrong-cwd", "listing-error", "warning"]) {
  test(`rejects ${mode} listing without returning approval`, async () => {
    await assert.rejects(prepareCodexHookTrust(options(mode)), { code: "HOOK_TRUST_DECLARATION" });
  });
}

for (const mode of ["untrusted-second", "changed-second"]) {
  test(`requires a second unchanged Trusted listing: ${mode}`, async () => {
    await assert.rejects(prepareCodexHookTrust(options(mode)), { code: "HOOK_TRUST_VERIFICATION" });
  });
}

for (const [mode, code] of [["malformed", "HOOK_TRUST_PROTOCOL"], ["rpc-error", "HOOK_TRUST_PROTOCOL"],
  ["early-exit", "HOOK_TRUST_PROCESS"], ["output-limit", "HOOK_TRUST_OUTPUT_LIMIT"], ["stderr-limit", "HOOK_TRUST_OUTPUT_LIMIT"]]) {
  test(`bounds and redacts ${mode} transport failure`, async () => {
    await assert.rejects(prepareCodexHookTrust(options(mode)), (error) => {
      assert.equal(error.code, code);
      assert.ok(!JSON.stringify(error).includes("private"));
      assert.ok(!error.message.includes("private"));
      return true;
    });
  });
}

test("deadline failure waits for owned child cleanup and cancels its timer", async () => {
  let expire;
  let cancelled = 0;
  const children = [];
  const spawnProcess = (...args) => {
    const child = spawn(...args);
    children.push({ child, closed: once(child, "close") });
    child.stdout.on("data", (chunk) => { if (chunk.toString().includes("fixture/ready")) expire(); });
    return child;
  };
  await assert.rejects(prepareCodexHookTrust(options("stall", {
    spawnProcess, scheduleTimeout: (callback) => { expire = callback; return 1; },
    cancelTimeout: () => { cancelled += 1; },
  })), { code: "HOOK_TRUST_TIMEOUT" });
  assert.equal(children.length, 1);
  await children[0].closed;
  assert.ok(children[0].child.exitCode !== null || children[0].child.signalCode !== null);
  assert.equal(cancelled, 1);
});

test("successful preflight closes both owned listing children before returning", async () => {
  const children = [];
  await prepareCodexHookTrust(options("valid", { spawnProcess: (...args) => {
    const child = spawn(...args);
    children.push(child);
    return child;
  } }));
  assert.equal(children.length, 2);
  assert.ok(children.every((child) => child.exitCode !== null || child.signalCode !== null));
});
