import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createServer, type Socket } from "node:net";
import { setTimeout as realSetTimeout, clearTimeout as realClearTimeout } from "node:timers";
import { OwnedJobDecoder, OwnedJobRunner, encodeOwnedJobRequest, type OwnedJobReceipt, type OwnedJobRequest,
  type OwnedJobResult } from "../../src/shared/owned-job.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function frame(kind: string, bytes: Uint8Array | string): Buffer {
  const payload = typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes);
  const header = Buffer.alloc(5);
  header[0] = kind.charCodeAt(0); header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function receipt(id: string, stdout = Buffer.alloc(0), stderr = Buffer.alloc(0)): OwnedJobReceipt {
  return { v: 1, id, status: "completed", exit_code: 0, stdout_bytes: stdout.length, stderr_bytes: stderr.length,
    stdout_sha256: digest(stdout), stderr_sha256: digest(stderr) };
}

function assertReceipt(result: OwnedJobResult, status = "completed") {
  expect(result.helperExitCode).toBe(0);
  expect(result.receipt?.status).toBe(status);
  expect(result.receipt?.stdout_bytes).toBe(Buffer.byteLength(result.stdout));
  expect(result.receipt?.stderr_bytes).toBe(Buffer.byteLength(result.stderr));
  expect(result.receipt?.stdout_sha256).toBe(digest(Buffer.from(result.stdout)));
  expect(result.receipt?.stderr_sha256).toBe(digest(Buffer.from(result.stderr)));
}

function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const guard = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Owned job handshake did not complete")), 10_000); });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

describe("owned job framing contract", () => {
  test("request encoding omits an absent deadline and keeps background return timers out of Rust", () => {
    const input: OwnedJobRequest = { executable: process.execPath, args: ["-e", "0"], cwd: process.cwd(), env: { FIXTURE: "1" } };
    for (const request of [input, { ...input, background: true, timeout: 7 }]) {
      const encoded = encodeOwnedJobRequest("job-1", request);
      expect(encoded[0]).toBe("R".charCodeAt(0));
      expect(encoded.readUInt32BE(1)).toBe(encoded.length - 5);
      expect(JSON.parse(encoded.subarray(5).toString())).toEqual({ v: 1, id: "job-1", executable: input.executable,
        args: input.args, cwd: input.cwd, env: input.env });
    }
    const timed = encodeOwnedJobRequest("job-2", { ...input, timeout: 9, maxOutputBytes: 1024 });
    expect(JSON.parse(timed.subarray(5).toString())).toMatchObject({ timeout_ms: 9, max_output_bytes: 1024 });
  });

  test("decodes fragmented headers and UTF-8 using raw-byte receipt counts and hashes", () => {
    const out = Buffer.from("orchard 🍎"), err = Buffer.from("café");
    const wire = Buffer.concat([frame("O", out.subarray(0, out.length - 2)), frame("E", err),
      frame("O", out.subarray(out.length - 2)), frame("F", JSON.stringify(receipt("job", out, err)))]);
    const decoder = new OwnedJobDecoder("job");
    for (const byte of wire) decoder.push(Buffer.from([byte]));
    const result = decoder.finish(0);
    expect(result.stdout).toBe(out.toString()); expect(result.stderr).toBe(err.toString());
    assertReceipt(result);
  });

  test("rejects request limits without clamping deadlines or truncating arguments", () => {
    const input: OwnedJobRequest = { executable: process.execPath, args: [], cwd: process.cwd(), env: {} };
    for (const invalid of [
      { ...input, timeout: 0 }, { ...input, timeout: 31_536_000_001 },
      { ...input, maxOutputBytes: 104_857_601 }, { ...input, executable: "node" },
      { ...input, args: ["x".repeat(16 * 1024 + 1)] },
    ]) expect(() => encodeOwnedJobRequest("job", invalid)).toThrow(/request|timeout|limit|argument|executable|absolute/i);
  });

  test.each([1, null])("a valid final receipt cannot override helper exit %s", (code) => {
    const decoder = new OwnedJobDecoder("job");
    decoder.push(frame("F", JSON.stringify(receipt("job"))));
    expect(() => decoder.finish(code)).toThrow(/helper|exit|protocol/i);
  });

  test("refuses premature EOF, partial frames, duplicate final receipts and output after final", () => {
    const empty = new OwnedJobDecoder("job");
    expect(() => empty.finish(0)).toThrow(/receipt|EOF|incomplete|protocol/i);
    const partial = new OwnedJobDecoder("job");
    partial.push(frame("O", "hello").subarray(0, 6));
    expect(() => partial.finish(0)).toThrow(/frame|EOF|incomplete|protocol/i);
    for (const extra of [frame("F", JSON.stringify(receipt("job"))), frame("O", "late")]) {
      const decoder = new OwnedJobDecoder("job");
      decoder.push(frame("F", JSON.stringify(receipt("job"))));
      expect(() => { decoder.push(extra); decoder.finish(0); }).toThrow(/final|receipt|protocol/i);
    }
  });

  test.each(["id", "stdout_bytes", "stdout_sha256", "v", "status"])("refuses final receipt with corrupt %s", (field) => {
    const final: Record<string, unknown> = { ...receipt("job", Buffer.from("hello")) };
    final[field] = field === "stdout_bytes" || field === "v" ? 99 : "invalid";
    const decoder = new OwnedJobDecoder("job");
    decoder.push(frame("O", "hello"));
    expect(() => { decoder.push(frame("F", JSON.stringify(final))); decoder.finish(0); }).toThrow(/receipt|protocol|hash|count|version|identity|status/i);
  });

  test("rejects unknown or oversized frame headers before waiting for their payload", () => {
    for (const [kind, size] of [["O", 8193], ["E", 8193], ["F", 4097], ["X", 0]] as const) {
      const header = Buffer.alloc(5); header[0] = kind.charCodeAt(0); header.writeUInt32BE(size, 1);
      expect(() => new OwnedJobDecoder("job").push(header)).toThrow(/frame|limit|size|protocol/i);
    }
  });

  test("bounds both output streams together and never reports cleanup failure as success", () => {
    const decoder = new OwnedJobDecoder("job", 6);
    decoder.push(frame("O", "four"));
    expect(() => decoder.push(frame("E", "more"))).toThrow(/cap|limit|output|protocol/i);
    const failed = new OwnedJobDecoder("job");
    expect(() => {
      failed.push(frame("F", JSON.stringify({ ...receipt("job"), status: "cleanup_failed", exit_code: null })));
      failed.finish(0);
    }).toThrow(/cleanup/i);
  });
});

describe("owned helper failure reporting", () => {
  const failureDelay = 100;
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  // This guard is only failure containment; timeout behavior is driven by the
  // fake clock after the actual helper reaches the requested protocol phase.
  function handshake<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof realSetTimeout>;
    const guard = new Promise<never>((_, reject) => {
      timer = realSetTimeout(() => reject(new Error("Helper failure did not schedule bounded reporting")), 5_000);
    });
    return Promise.race([promise, guard]).finally(() => realClearTimeout(timer));
  }

  async function fixture() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ctx-helper-failure-")));
    const connected = deferred<Socket>(), ready = deferred<void>(), faulted = deferred<void>();
    const holderReady = deferred<void>(), sockets = new Set<Socket>(), exits: Promise<void>[] = [];
    const outputReady = deferred<void>();
    const server = createServer((socket) => {
      sockets.add(socket);
      const exited = deferred<void>(); exits.push(exited.promise);
      connected.resolve(socket);
      let buffer = "";
      socket.on("data", (bytes) => {
        buffer += bytes.toString("utf8");
        while (buffer.includes("\n")) {
          const end = buffer.indexOf("\n"), line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (line === "ready") ready.resolve();
          if (line === "faulted") faulted.resolve();
          if (line === "holder-ready") holderReady.resolve();
        }
      });
      socket.on("error", () => {});
      socket.on("close", () => { sockets.delete(socket); exited.resolve(); });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture listener missing");
    const options = { harnessPath: realpathSync(process.execPath), helperFailureTimeoutMs: failureDelay,
      harnessEnvironment: { HOME: root, USERPROFILE: root,
        NODE_OPTIONS: `--import=${new URL("./owned-job-helper.fixture.mjs", import.meta.url).href}`,
        OWNED_HELPER_CONTROL_PORT: String(address.port),
        ...(process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } };
    const owner = new OwnedJobRunner(options), controller = new AbortController();
    const request: OwnedJobRequest = { executable: process.execPath, args: [], cwd: root, env: {}, signal: controller.signal,
      onOutput: (stream, bytes) => { if (stream === "stdout" && Buffer.from(bytes).toString() === "READY") outputReady.resolve(); } };
    const pending = owner.run(request);
    void pending.catch(() => undefined);
    let socket: Socket;
    try {
      socket = await handshake(connected.promise);
      await handshake(Promise.all([ready.promise, outputReady.promise]));
    } catch (error) {
      (await Promise.race([connected.promise, Promise.resolve(undefined)]))?.end("release\n");
      server.close();
      throw error;
    }
    return { owner, pending, controller,
      fault: async (mode: string) => {
        socket.write(`${mode}\n`); await handshake(faulted.promise);
        if (mode === "leader-exit") await handshake(holderReady.promise);
      },
      async release() {
        for (const owned of sockets) owned.write("release\n");
        await handshake(Promise.all(exits));
        await pending.catch(() => undefined);
        await owner.close().catch(() => undefined);
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(root, { recursive: true, force: true });
      },
      isLive: () => sockets.size > 0,
    };
  }

  test.each(["malformed", "stdout-eof", "stdin-closed", "final-stuck", "leader-exit"])("reports %s without waiting for a stuck helper to exit", async (mode) => {
    const helper = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const scheduled = deferred<void>();
    const fakeSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      const timer = fakeSetTimeout(callback, delay, ...args);
      if (delay === failureDelay) scheduled.resolve();
      return timer;
    }) as typeof setTimeout);
    try {
      await helper.fault(mode);
      if (mode === "stdin-closed") helper.controller.abort();
      await handshake(scheduled.promise);
      await vi.advanceTimersByTimeAsync(failureDelay);
      await expect(handshake(helper.pending)).rejects.toThrow(/helper|protocol|receipt|cleanup/i);
      expect(helper.isLive()).toBe(true);
      // Bounded failure is not evidence of cleanup. Neither close nor a fresh
      // job may turn this unresolved owner into a successful reusable runner.
      await expect(handshake(helper.owner.close())).rejects.toThrow(/helper|protocol|receipt|cleanup/i);
      await expect(helper.owner.run({ executable: process.execPath, args: [], cwd: process.cwd(), env: {} })).rejects.toThrow(/closed|failed|cleanup|helper/i);
    } finally {
      vi.restoreAllMocks(); vi.useRealTimers();
      await helper.release();
    }
  });

  test("an omitted job timeout does not become a helper failure timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const helper = await fixture();
    let settled = false;
    void helper.pending.then(() => { settled = true; }, () => { settled = true; });
    try {
      await vi.advanceTimersByTimeAsync(failureDelay * 10);
      expect(settled).toBe(false);
      expect(helper.isLive()).toBe(true);
    } finally {
      vi.useRealTimers();
      await helper.release();
    }
    assertReceipt(await helper.pending);
  });
});

describe("real Rust owned-job adapter", () => {
  let harness: string;
  let root: string;
  let runners: OwnedJobRunner[];

  beforeAll(() => {
    const candidate = process.env.CONTEXT_MODE_TEST_HARNESS;
    expect(candidate, "CONTEXT_MODE_TEST_HARNESS must name the verified PR346 candidate binary; this suite never skips").toBeTruthy();
    expect(isAbsolute(candidate!)).toBe(true);
    expect(existsSync(candidate!)).toBe(true);
    harness = realpathSync(candidate!);
  });

  beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "ctx-owned-wire-"))); runners = []; });
  afterEach(async () => {
    try { await Promise.all(runners.map((runner) => runner.close())); }
    finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
  });

  function environment(owner: string): Record<string, string> {
    return { HOME: root, USERPROFILE: root, CTX_SYNTHETIC_OWNER: owner,
      ...(process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
  }

  function runner(): OwnedJobRunner {
    const value = new OwnedJobRunner({ harnessPath: harness, harnessEnvironment: environment("helper") });
    runners.push(value); return value;
  }

  function job(code: string, owner = "job"): OwnedJobRequest {
    return { executable: realpathSync(process.execPath), args: ["-e", code], cwd: root, env: environment(owner) };
  }

  function gated(name: string) {
    const ready = deferred<void>(), released = deferred<void>();
    const release = join(root, `${name}.release`);
    const request = job(`
const fs=require('node:fs');
const release=${JSON.stringify(release)};
const watcher=fs.watch(${JSON.stringify(root)},()=>{if(fs.existsSync(release)){watcher.close();process.stdout.write('RELEASED');}});
process.stdout.write('READY');
if(fs.existsSync(release)){watcher.close();process.stdout.write('RELEASED');}
`, name);
    let observed = "";
    request.onOutput = (stream, bytes) => {
      if (stream !== "stdout") return;
      observed = (observed + Buffer.from(bytes).toString()).slice(-80);
      if (observed.includes("READY")) ready.resolve();
      if (observed.includes("RELEASED")) released.resolve();
    };
    return { request, ready: ready.promise, released: released.promise, release };
  }

  async function started(pending: Promise<OwnedJobResult>, ready: Promise<void>) {
    expect(await bounded(Promise.race([ready.then(() => "ready"), pending.then(() => "finished", () => "failed")]))).toBe("ready");
  }

  test("returns actual cwd, only supplied environment, both streams and verified receipt", async () => {
    vi.stubEnv("CTX_MCP_CAP", "synthetic-service-capability");
    const result = await runner().run(job("process.stdout.write(JSON.stringify({cwd:process.cwd(),owner:process.env.CTX_SYNTHETIC_OWNER,cap:process.env.CTX_MCP_CAP??null}));process.stderr.write('café 🍎');"));
    expect(JSON.parse(result.stdout)).toEqual({ cwd: root, owner: "job", cap: null });
    expect(result.stderr).toBe("café 🍎"); expect(result.exitCode).toBe(0); assertReceipt(result);
  });

  test("preserves a real nonzero exit and distinguishes a failed spawn", async () => {
    const owner = runner();
    const result = await owner.run(job("process.stdout.write('before exit');process.exitCode=7;"));
    expect(result.exitCode).toBe(7); expect(result.stdout).toBe("before exit"); assertReceipt(result);
    await expect(owner.run({ ...job("0"), executable: join(root, "absent-program") })).rejects.toThrow(/spawn|executable/i);
  });

  test("a pre-aborted request cannot start its executable", async () => {
    const marker = join(root, "must-not-exist");
    const controller = new AbortController(); controller.abort();
    const result = await runner().run({ ...job(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`), signal: controller.signal });
    expect(result.cancelled).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  test("an omitted timeout allows output while the job waits for an explicit release", async () => {
    const owner = runner(), gate = gated("unbounded");
    const pending = owner.run(gate.request);
    await started(pending, gate.ready);
    writeFileSync(gate.release, "release");
    const result = await pending;
    expect(result.stdout).toBe("READYRELEASED"); expect(result.timedOut).toBe(false); assertReceipt(result);
  });

  test("cancels one owner while a sibling continues and closes all retained jobs", async () => {
    const first = runner(), second = runner(), a = gated("a"), b = gated("b");
    const controller = new AbortController();
    const pendingA = first.run({ ...a.request, signal: controller.signal });
    const pendingB = second.run(b.request);
    // Observe both rejections immediately during RED without changing their results.
    void pendingA.catch(() => undefined); void pendingB.catch(() => undefined);
    await Promise.all([started(pendingA, a.ready), started(pendingB, b.ready)]);
    controller.abort();
    const cancelled = await pendingA;
    expect(cancelled.cancelled).toBe(true); assertReceipt(cancelled, "cancelled");
    writeFileSync(b.release, "release");
    assertReceipt(await pendingB);
    const c = gated("close"), pendingC = second.run(c.request);
    await started(pendingC, c.ready);
    await second.close();
    const closed = await pendingC;
    expect(closed.cancelled).toBe(true); assertReceipt(closed, "cancelled");
    await expect(second.run(job("0"))).rejects.toThrow(/closed/i);
  });

  test("honors explicit deadlines and the aggregate output cap with final cleanup receipts", async () => {
    const owner = runner();
    const timed = await owner.run({ ...job("setInterval(()=>{},1000)"), timeout: 10 });
    expect(timed.timedOut).toBe(true); assertReceipt(timed, "timed_out");
    const capped = await owner.run({ ...job("for(let i=0;i<10000;i++){process.stdout.write('a'.repeat(100));process.stderr.write('b'.repeat(100));}"), maxOutputBytes: 2048 });
    expect(Buffer.byteLength(capped.stdout) + Buffer.byteLength(capped.stderr)).toBeLessThanOrEqual(2048);
    expect(capped.exitCode).not.toBe(0); assertReceipt(capped, "output_capped");
  });

  test("background return keeps the Rust job alive and drains later output until owner close", async () => {
    const owner = runner(), gate = gated("background");
    const partial = await owner.run({ ...gate.request, background: true, timeout: 1 });
    expect(partial.backgrounded).toBe(true); expect(partial.receipt).toBeUndefined();
    await bounded(gate.ready);
    writeFileSync(gate.release, "release");
    await bounded(gate.released);
    await owner.close();
    expect(partial.stdout).not.toContain("RELEASED");
  });

  test("a normal leader exit is not accepted before its descendant has stopped", async () => {
    const pidFile = join(root, "descendant.pid");
    const childCode = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.send('ready');setInterval(()=>{},1000);`;
    const code = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:['ignore','inherit','inherit','ipc']});child.on('message',()=>process.exit(0));`;
    const result = await runner().run(job(code));
    assertReceipt(result);
    const pid = Number(readFileSync(pidFile, "utf8"));
    let running = false;
    try {
      process.kill(pid, 0);
      running = process.platform !== "linux" || readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1][0] !== "Z";
    } catch (error) {
      if (!["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    expect(running).toBe(false);
  });
});
