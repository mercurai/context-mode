import { expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setImmediate as nextTurn } from "node:timers/promises";
import { PolyglotExecutor } from "../../src/executor.js";
import type { RuntimeMap } from "../../src/runtime.js";

function isExecuting(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // A killed orphan can remain a zombie until the host's init reaps it. Its
    // continued PID existence does not mean code or inherited pipes are live.
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
    }
    return true;
  } catch (error) {
    if (["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

function bounded<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const guard = new Promise<never>((_, reject) => {
    // This is a deadlock guard, not an elapsed-time performance assertion.
    timer = setTimeout(() => reject(new Error(message)), 10_000);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

test.skipIf(process.platform === "win32")("owner close kills the retained process group after its leader exits first", async () => {
  const root = mkdtempSync(join(tmpdir(), "ctx-owned-descendant-"));
  const ready = join(root, "descendant.ready");
  const release = join(root, "descendant.release");
  const completed = join(root, "descendant.completed");
  const runtimes: RuntimeMap = {
    javascript: process.execPath, typescript: null, python: null, shell: "/bin/bash",
    ruby: null, go: null, rust: null, php: null, perl: null, r: null, elixir: null, csharp: null,
  };
  const owner = new PolyglotExecutor({
    runtimes, projectRoot: root,
    environment: { HOME: root, PATH: process.env.PATH ?? "" },
  });
  const descendant = `
const fs = require("node:fs");
const release = ${JSON.stringify(release)};
let finished = false;
function finish() {
  if (finished || !fs.existsSync(release)) return;
  finished = true;
  watcher.close();
  fs.writeFileSync(${JSON.stringify(completed)}, "completed");
}
const watcher = fs.watch(${JSON.stringify(root)}, finish);
fs.writeFileSync(${JSON.stringify(ready + ".writing")}, JSON.stringify({pid:process.pid,parentPid:process.ppid}));
fs.renameSync(${JSON.stringify(ready + ".writing")}, ${JSON.stringify(ready)});
finish();
`;
  const parent = `
const fs = require("node:fs");
function leaveWhenChildIsReady() {
  if (fs.existsSync(${JSON.stringify(ready)})) process.exit(0);
}
fs.watch(${JSON.stringify(root)}, leaveWhenChildIsReady);
require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {
  stdio:["ignore","inherit","inherit"], detached:false,
}).on("error", () => process.exit(1));
leaveWhenChildIsReady();
`;
  let readyResolve!: () => void;
  const readiness = new Promise<void>(resolve => { readyResolve = resolve; });
  const watcher = watch(root, () => { if (existsSync(ready)) readyResolve(); });
  const running = owner.execute({ language: "javascript", code: parent });
  let closing: Promise<void> | undefined;
  try {
    await bounded(Promise.race([
      readiness,
      running.then(() => { throw new Error("Parent completed before its descendant became ready"); }),
    ]), "Owned descendant did not become ready");
    const identity: { pid: number; parentPid: number } = JSON.parse(readFileSync(ready, "utf8"));
    await bounded((async () => {
      while (isExecuting(identity.parentPid)) await nextTurn();
      // Deliver Node's direct-child exit event before exercising its retained
      // pipes; close must still wait for and cancel the live descendant.
      await nextTurn();
    })(), "Owned group leader did not exit");
    expect(isExecuting(identity.pid)).toBe(true);
    closing = owner.close();
    await bounded(closing, "Owner close remained pending after leader exit while its descendant held inherited pipes");
    expect(isExecuting(identity.pid)).toBe(false);
    expect(existsSync(completed)).toBe(false);
    expect(await running).toMatchObject({ cancelled: true, exitCode: 1, timedOut: false });
  } finally {
    watcher.close();
    // The RED implementation cannot kill this descendant. Release its fixture
    // gate so a failing test still reaps its pipes and leaves no live child.
    writeFileSync(release, "release");
    await running;
    if (closing) await closing;
    else await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});
