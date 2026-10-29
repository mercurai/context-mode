import { afterEach, describe, expect, test, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { setImmediate as nextTurn } from "node:timers/promises";
import { PolyglotExecutor } from "../../src/executor.js";
import type { RuntimeMap } from "../../src/runtime.js";

// All processes and files belong to this test. No runtime detection, real client
// environment capture, service startup, or unrelated process cleanup is needed.
const runtimes: RuntimeMap = {
  javascript: process.execPath,
  typescript: null,
  python: null,
  shell: process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash",
  ruby: null,
  go: null,
  rust: null,
  php: null,
  perl: null,
  r: null,
  elixir: null,
  csharp: null,
};

const roots: string[] = [];
const executors: PolyglotExecutor[] = [];
const releases: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "ctx-owned-jobs-"));
  roots.push(root);
  return root;
}

function environment(home: string, owner: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? process.env.Path ?? "",
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: home,
    USERPROFILE: home,
    CTX_SYNTHETIC_OWNER: owner,
  };
}

function executor(root: string, owner: string): PolyglotExecutor {
  const value = new PolyglotExecutor({
    projectRoot: root,
    runtimes,
    environment: environment(root, owner),
  });
  executors.push(value);
  return value;
}

// Event handshakes determine readiness. The timeout only bounds a broken test;
// no assertion depends on a process becoming ready within a guessed sleep.
function waitForFile(path: string): Promise<void> {
  if (existsSync(path)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const watcher = watch(dirname(path), () => {
      if (existsSync(path)) finish();
    });
    const timer = setTimeout(() => finish(new Error("Owned child did not signal readiness")), 10_000);
    function finish(error?: Error): void {
      clearTimeout(timer);
      watcher.close();
      if (error) reject(error);
      else resolve();
    }
    if (existsSync(path)) finish();
  });
}

function gatedScript(root: string, name: string): { code: string; ready: string; release: string; done: string } {
  const ready = join(root, `${name}.ready`);
  const release = join(root, `${name}.release`);
  const done = join(root, `${name}.done`);
  releases.push(release);
  return {
    ready, release, done,
    code: `
const fs = require("node:fs");
const release = ${JSON.stringify(release)};
const watcher = fs.watch(${JSON.stringify(root)}, () => {
  if (fs.existsSync(release)) {
    watcher.close();
    fs.writeFileSync(${JSON.stringify(done)}, "completed");
    console.log("completed");
  }
});
fs.writeFileSync(${JSON.stringify(ready + ".writing")}, JSON.stringify({ pid: process.pid, cwd: process.cwd() }));
fs.renameSync(${JSON.stringify(ready + ".writing")}, ${JSON.stringify(ready)});
if (fs.existsSync(release)) {
  watcher.close();
  fs.writeFileSync(${JSON.stringify(done)}, "completed");
  console.log("completed");
}
`,
  };
}

function childPid(ready: string): number {
  return JSON.parse(readFileSync(ready, "utf8")).pid;
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  // Release any pre-implementation child whose cancellation API is absent.
  for (const path of releases.splice(0)) {
    if (existsSync(dirname(path))) writeFileSync(path, "release");
  }
  for (const value of executors.splice(0)) {
    if (typeof value.close === "function") await value.close();
    else value.cleanupBackgrounded();
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("explicit shared executor ownership", () => {
  test("concurrent owners use immutable explicit environments without merging the host environment", async () => {
    const root = fixture();
    const firstHome = join(root, "first");
    const secondHome = join(root, "second");
    mkdirSync(firstHome); mkdirSync(secondHome);
    const source = environment(firstHome, "first");
    const first = new PolyglotExecutor({ projectRoot: firstHome, runtimes, environment: source });
    executors.push(first);
    const second = executor(secondHome, "second");
    source.CTX_SYNTHETIC_OWNER = "mutated-after-construction";
    source.HOME = secondHome;
    const ambientKey = ["USER", "USERNAME", "COMPUTERNAME", "LOGNAME"].find(key => process.env[key] !== undefined);
    expect(ambientKey).toBeDefined();
    const originalHome = process.env.HOME;
    const code = `console.log(JSON.stringify({owner:process.env.CTX_SYNTHETIC_OWNER,home:process.env.HOME,cwd:process.cwd(),ambient:Object.hasOwn(process.env,${JSON.stringify(ambientKey)})}))`;
    const results = await Promise.all([
      first.execute({ language: "javascript", code }),
      second.execute({ language: "javascript", code }),
    ]);
    expect(results.map(result => result.exitCode)).toEqual([0, 0]);
    expect(results.map(result => JSON.parse(result.stdout))).toEqual([
      { owner: "first", home: firstHome, cwd: firstHome, ambient: false },
      { owner: "second", home: secondHome, cwd: secondHome, ambient: false },
    ]);
    expect(process.env.HOME).toBe(originalHome);
  });

  test("an already-aborted request does not execute its script", async () => {
    const root = fixture();
    const output = join(root, "must-not-exist");
    const controller = new AbortController();
    controller.abort();
    const result = await executor(root, "first").execute({
      language: "javascript",
      code: `require("node:fs").writeFileSync(${JSON.stringify(output)}, "executed")`,
      signal: controller.signal,
    });
    expect(existsSync(output)).toBe(false);
    expect(result).toMatchObject({ cancelled: true, timedOut: false, exitCode: 1 });
  });

  test("canceling one owner's request leaves another owner's running process intact", async () => {
    const root = fixture();
    const first = gatedScript(root, "first");
    const second = gatedScript(root, "second");
    const controller = new AbortController();
    const firstRun = executor(root, "first").execute({ language: "javascript", code: first.code, signal: controller.signal });
    const secondRun = executor(root, "second").execute({ language: "javascript", code: second.code });
    try {
      await Promise.all([waitForFile(first.ready), waitForFile(second.ready)]);
      controller.abort();
      // Allows the unfixed implementation to exit and fail on behavior, rather
      // than timing out while waiting forever for its unhandled AbortSignal.
      writeFileSync(first.release, "release");
      const result = await firstRun;
      expect(result).toMatchObject({ cancelled: true, timedOut: false, exitCode: 1 });
      expect(existsSync(first.done)).toBe(false);
      expect(isAlive(childPid(second.ready))).toBe(true);
      writeFileSync(second.release, "release");
      expect(await secondRun).toMatchObject({ exitCode: 0, stdout: "completed\n" });
    } finally {
      writeFileSync(first.release, "release"); writeFileSync(second.release, "release");
      await Promise.allSettled([firstRun, secondRun]);
    }
  });

  test("executeFile propagates the request cwd and cancellation", async () => {
    const root = fixture();
    const working = join(root, "working");
    mkdirSync(working);
    const input = join(working, "input.txt");
    writeFileSync(input, "owned-input");
    const gate = gatedScript(root, "file");
    const controller = new AbortController();
    const running = executor(root, "first").executeFile({
      language: "javascript", path: input, cwd: working, signal: controller.signal,
      code: `if (FILE_CONTENT !== "owned-input") throw new Error("wrong file"); ${gate.code}`,
    });
    try {
      await waitForFile(gate.ready);
      expect(JSON.parse(readFileSync(gate.ready, "utf8")).cwd).toBe(working);
      controller.abort();
      writeFileSync(gate.release, "release");
      expect(await running).toMatchObject({ cancelled: true, timedOut: false, exitCode: 1 });
      expect(existsSync(gate.done)).toBe(false);
    } finally {
      writeFileSync(gate.release, "release");
      await running;
    }
  });

  test("closing an owner waits for its foreground child and leaves another owner alive", async () => {
    const root = fixture();
    const first = executor(root, "first");
    const second = executor(root, "second");
    const firstGate = gatedScript(root, "closing");
    const secondGate = gatedScript(root, "retained");
    const firstRun = first.execute({ language: "javascript", code: firstGate.code });
    const secondRun = second.execute({ language: "javascript", code: secondGate.code });
    try {
      await Promise.all([waitForFile(firstGate.ready), waitForFile(secondGate.ready)]);
      await first.close();
      expect(isAlive(childPid(firstGate.ready))).toBe(false);
      expect(existsSync(firstGate.done)).toBe(false);
      expect(isAlive(childPid(secondGate.ready))).toBe(true);
      expect(await firstRun).toMatchObject({ cancelled: true, timedOut: false, exitCode: 1 });
      writeFileSync(secondGate.release, "release");
      expect((await secondRun).exitCode).toBe(0);
    } finally {
      writeFileSync(firstGate.release, "release"); writeFileSync(secondGate.release, "release");
      await Promise.allSettled([firstRun, secondRun]);
    }
  });

  test("closing an owner awaits its still-running background child", async () => {
    const root = fixture();
    const owner = executor(root, "first");
    const gate = gatedScript(root, "background-close");
    const result = await owner.execute({ language: "javascript", code: gate.code, background: true, timeout: 1 });
    expect(result.backgrounded).toBe(true);
    await waitForFile(gate.ready);
    const pid = childPid(gate.ready);
    await owner.close();
    expect(isAlive(pid)).toBe(false);
    expect(existsSync(gate.done)).toBe(false);
  });

  test.skipIf(process.platform === "win32")("closing after a background child exits does not signal its stale PID", async () => {
    const root = fixture();
    const owner = executor(root, "first");
    const gate = gatedScript(root, "background");
    const result = await owner.execute({ language: "javascript", code: gate.code, background: true, timeout: 1 });
    expect(result.backgrounded).toBe(true);
    await waitForFile(gate.ready);
    const pid = childPid(gate.ready);
    writeFileSync(gate.release, "release");
    await waitForFile(gate.done);
    // Wait for actual OS process exit, not a fixed delay. Vitest's test timeout
    // is the bound if an owned process fails to exit after its release gate.
    while (isAlive(pid)) await nextTurn();
    await nextTurn();
    const kill = vi.spyOn(process, "kill");
    await owner.close();
    expect(kill.mock.calls.filter(([target]) => target === pid || target === -pid)).toEqual([]);
  });
});
