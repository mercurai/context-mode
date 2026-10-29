import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { runClient } from "./run.mjs";
import { readCodexChild } from "./codex-hook-trust.mjs";

const fixture = fileURLToPath(new URL("./owned-pipes.fixture.mjs", import.meta.url));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function guarded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Fixture watchdog: ${label}`)), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

for (const owner of ["client", "app-server"]) {
  for (const mode of ["leader-exit", "leader-live"]) {
    test(`${owner}: ${mode} cannot leave cleanup waiting forever on inherited pipes`, async () => {
      const ready = deferred(), responded = deferred(), released = deferred(), cleanupScheduled = deferred(), leaderExited = deferred();
      let socket, child, expireJob, expireCleanup, terminationAttempts = 0, cleanupCancels = 0;
      const controller = createServer((connection) => {
        socket = connection;
        let buffer = "";
        connection.on("data", (chunk) => {
          buffer += chunk;
          if (buffer.includes("ready\n")) ready.resolve();
          if (buffer.includes("responded\n")) responded.resolve();
        });
        connection.on("close", released.resolve);
      });
      await new Promise((resolve) => controller.listen(0, "127.0.0.1", resolve));
      const options = {
        timeoutMs: 60_000, cleanupTimeoutMs: 1000,
        scheduleTimeout: (callback) => { expireJob = callback; return "job"; }, cancelTimeout: () => {},
        scheduleCleanupTimeout: (callback) => { expireCleanup = callback; cleanupScheduled.resolve(); return "cleanup"; },
        cancelCleanupTimeout: () => { cleanupCancels += 1; },
        spawnProcess: (...args) => { child = spawn(...args); child.once("exit", leaderExited.resolve); return child; },
        stopProcess: (owned) => {
          assert.equal(owned, child);
          terminationAttempts += 1;
          return false; // Actual process remains alive; fixture finally owns cooperative release.
        },
      };
      const env = { ...process.env, PROBE_OWNER_ROLE: mode, PROBE_OWNER_PORT: String(controller.address().port),
        PROBE_OWNER_PROTOCOL: owner === "app-server" ? "1" : "0", CODEX_HOME: "/synthetic/home",
        PROBE_TEST_SPEC: JSON.stringify({ threadRead: true, mode: "valid", cwd: process.cwd(),
          childId: "synthetic-child", parentId: "synthetic-parent", configArgs: [] }) };
      const pending = (owner === "client"
        ? runClient(process.execPath, [fixture], env, process.cwd(), options)
        : readCodexChild({ ...options, command: process.execPath, commandPrefix: [fixture], configArgs: [],
          cwd: process.cwd(), env, childId: "synthetic-child", parentId: "synthetic-parent" }))
        .then((value) => ({ value }), (error) => ({ error }));
      try {
        await guarded(ready.promise, "owned fixture ready");
        if (mode === "leader-exit" && child) await guarded(leaderExited.promise, "owned leader exit observed");
        socket.write("respond\n");
        if (owner === "client") {
          await guarded(responded.promise, "fixture output written before deadline");
          assert.equal(typeof expireJob, "function");
          expireJob();
        }
        await guarded(cleanupScheduled.promise, "separate cleanup deadline scheduled");
        assert.equal(typeof expireCleanup, "function");
        expireCleanup();
        const outcome = await guarded(pending, "bounded unconfirmed cleanup result");
        if (owner === "client") {
          assert.equal(outcome.error, undefined);
          assert.equal(outcome.value.cleanup, "unconfirmed");
          assert.equal(outcome.value.stdout, "");
          assert.equal(outcome.value.failure, "timeout");
        } else assert.equal(outcome.error?.code, "HOOK_TRUST_CLEANUP");
        assert.equal(terminationAttempts, mode === "leader-exit" ? 0 : 1);
        assert.equal(cleanupCancels, 1);
        // The fixture is demonstrably still alive. No descendant-cleaned claim
        // is permitted merely because the owner returned or closed its streams.
        assert.equal(socket.destroyed, false);
      } finally {
        try {
          if (socket && !socket.destroyed) socket.write("release\n");
          if (socket) await guarded(released.promise, "cooperative fixture release");
          await guarded(pending, "original operation settles after owned fixture release");
        } finally {
          socket?.destroy();
          await new Promise((resolve) => controller.close(resolve));
        }
      }
    });
  }
}
