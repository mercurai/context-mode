import type { ExecResult } from "../types.js";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";

export interface OwnedJobRequest {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeout?: number;
  maxOutputBytes?: number;
  background?: boolean;
  signal?: AbortSignal;
  onOutput?: (stream: "stdout" | "stderr", bytes: Uint8Array) => void;
}

export interface OwnedJobReceipt {
  v: 1;
  id: string;
  status: "completed" | "timed_out" | "cancelled" | "output_capped" | "spawn_failed" |
    "invalid_request" | "protocol_error" | "cleanup_failed" | "internal_error";
  exit_code: number | null;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_sha256: string;
  stderr_sha256: string;
}

export interface OwnedJobResult extends ExecResult {
  /** Present only after the final receipt and helper process exit are verified. */
  receipt?: Readonly<OwnedJobReceipt>;
  helperExitCode?: number;
}

const MAX_OUTPUT = 100 * 1024 * 1024;
const MAX_TIMEOUT = 31_536_000_000;
const statuses = new Set(["completed", "timed_out", "cancelled", "output_capped", "spawn_failed",
  "invalid_request", "protocol_error", "cleanup_failed", "internal_error"]);

class OwnedJobError extends Error {
  constructor(readonly code: string) { super(`Owned job ${code}`); }
}

function integer(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

function environment(value: Readonly<Record<string, string>>): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OwnedJobError("invalid_request_environment");
  const entries = Object.entries(value);
  if (entries.length > 512 || entries.some(([key, val]) => !key || /[=\0]/.test(key) ||
    typeof val !== "string" || val.includes("\0") || Buffer.byteLength(key) > 32768 || Buffer.byteLength(val) > 32768)) {
    throw new OwnedJobError("invalid_request_environment");
  }
  return Object.fromEntries(entries);
}

function frame(kind: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header[0] = kind.charCodeAt(0); header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

export function encodeOwnedJobRequest(id: string, request: OwnedJobRequest): Buffer {
  if (typeof id !== "string" || !id || Buffer.byteLength(id) > 128 ||
    typeof request.executable !== "string" || !isAbsolute(request.executable) || request.executable.includes("\0") ||
    typeof request.cwd !== "string" || !isAbsolute(request.cwd) || request.cwd.includes("\0") ||
    !Array.isArray(request.args) || request.args.length > 256 || request.args.some((arg) =>
      typeof arg !== "string" || arg.includes("\0") || Buffer.byteLength(arg) > 16384) ||
    request.args.reduce((total, arg) => total + Buffer.byteLength(arg), 0) > 131072 ||
    (request.timeout !== undefined && !integer(request.timeout, MAX_TIMEOUT)) ||
    (request.maxOutputBytes !== undefined && !integer(request.maxOutputBytes, MAX_OUTPUT))) {
    throw new OwnedJobError("invalid_request_limit_or_executable");
  }
  const payload = Buffer.from(JSON.stringify({ v: 1, id, executable: request.executable, args: request.args,
    cwd: request.cwd, env: environment(request.env),
    ...(request.timeout !== undefined && !request.background ? { timeout_ms: request.timeout } : {}),
    ...(request.maxOutputBytes !== undefined ? { max_output_bytes: request.maxOutputBytes } : {}),
  }));
  if (payload.length > 1024 * 1024) throw new OwnedJobError("request_frame_limit");
  return frame("R", payload);
}

export class OwnedJobDecoder {
  #buffer: Buffer = Buffer.alloc(0);
  #receipt?: OwnedJobReceipt;
  #finished = false;
  #retain = true;
  #streams = {
    stdout: { bytes: 0, hash: createHash("sha256"), chunks: [] as Buffer[] },
    stderr: { bytes: 0, hash: createHash("sha256"), chunks: [] as Buffer[] },
  };

  constructor(private readonly id: string, private readonly maxOutputBytes = MAX_OUTPUT,
    private readonly onOutput?: OwnedJobRequest["onOutput"]) {
    if (!integer(maxOutputBytes, MAX_OUTPUT)) throw new OwnedJobError("output_limit");
  }

  push(bytes: Uint8Array): void {
    if (!bytes.length) return;
    if (this.#finished || this.#receipt) throw new OwnedJobError("output_after_final_receipt");
    this.#buffer = Buffer.concat([this.#buffer, bytes]);
    while (this.#buffer.length >= 5) {
      const kind = String.fromCharCode(this.#buffer[0]);
      const length = this.#buffer.readUInt32BE(1);
      if (!["O", "E", "F"].includes(kind) || length > (kind === "F" ? 4096 : 8192)) {
        throw new OwnedJobError("protocol_frame_limit");
      }
      if (this.#buffer.length < 5 + length) return;
      const payload = this.#buffer.subarray(5, 5 + length);
      this.#buffer = this.#buffer.subarray(5 + length);
      if (kind === "F") {
        let value: unknown;
        try { value = JSON.parse(payload.toString("utf8")); } catch { throw new OwnedJobError("invalid_final_receipt"); }
        this.#receipt = this.#validateReceipt(value);
        if (this.#buffer.length) throw new OwnedJobError("output_after_final_receipt");
        return;
      }
      const stream = kind === "O" ? "stdout" : "stderr";
      const state = this.#streams[stream];
      if (this.#streams.stdout.bytes + this.#streams.stderr.bytes + length > this.maxOutputBytes) {
        throw new OwnedJobError("aggregate_output_limit");
      }
      state.bytes += length; state.hash.update(payload);
      if (this.#retain) state.chunks.push(Buffer.from(payload));
      this.onOutput?.(stream, payload);
    }
  }

  #validateReceipt(value: unknown): OwnedJobReceipt {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new OwnedJobError("invalid_final_receipt");
    const r = value as OwnedJobReceipt;
    if (r.v !== 1 || r.id !== this.id || !statuses.has(r.status) ||
      (r.exit_code !== null && (!Number.isInteger(r.exit_code) || r.exit_code < -2147483648 || r.exit_code > 2147483647))) {
      throw new OwnedJobError("invalid_final_receipt");
    }
    for (const stream of ["stdout", "stderr"] as const) {
      if (r[`${stream}_bytes`] !== this.#streams[stream].bytes ||
        r[`${stream}_sha256`] !== this.#streams[stream].hash.copy().digest("hex")) {
        throw new OwnedJobError("receipt_count_or_hash_mismatch");
      }
    }
    return Object.freeze({ ...r });
  }

  snapshot(): Pick<OwnedJobResult, "stdout" | "stderr"> {
    return { stdout: Buffer.concat(this.#streams.stdout.chunks).toString("utf8"),
      stderr: Buffer.concat(this.#streams.stderr.chunks).toString("utf8") };
  }

  discardOutput(): void {
    this.#retain = false;
    this.#streams.stdout.chunks = []; this.#streams.stderr.chunks = [];
  }

  get hasFinalReceipt(): boolean { return this.#receipt !== undefined && this.#buffer.length === 0; }

  finish(helperExitCode: number | null): OwnedJobResult {
    if (this.#finished || this.#buffer.length || !this.#receipt) throw new OwnedJobError("incomplete_or_duplicate_final_receipt");
    this.#finished = true;
    if (helperExitCode !== 0) throw new OwnedJobError("helper_exit_failure");
    const receipt = this.#receipt;
    if (!["completed", "timed_out", "cancelled", "output_capped"].includes(receipt.status)) throw new OwnedJobError(receipt.status);
    return { ...this.snapshot(), receipt, helperExitCode,
      exitCode: receipt.status === "completed" ? receipt.exit_code ?? 1 : 1,
      timedOut: receipt.status === "timed_out", ...(receipt.status === "cancelled" ? { cancelled: true } : {}),
    };
  }
}

export class OwnedJobRunner {
  // Reporting can finish before ownership does. Failed jobs remain recorded
  // until a final receipt and helper exit prove cleanup; close never hides them.
  #jobs = new Set<{ cancel: () => void; done: Promise<void> }>();
  #closed = false;
  #closing?: Promise<void>;
  #failure?: Error;
  #path: string;
  #environment: Readonly<Record<string, string>>;
  #helperFailureTimeoutMs: number;

  constructor(options: { harnessPath: string; harnessEnvironment: Readonly<Record<string, string>>;
    helperFailureTimeoutMs?: number }) {
    if (!isAbsolute(options.harnessPath) || options.harnessPath.includes("\0")) throw new OwnedJobError("invalid_harness_executable");
    const helperFailureTimeoutMs = options.helperFailureTimeoutMs ?? 5_000;
    if (!integer(helperFailureTimeoutMs, 60_000)) throw new OwnedJobError("invalid_helper_failure_timeout");
    this.#path = options.harnessPath;
    this.#environment = Object.freeze(environment(options.harnessEnvironment));
    this.#helperFailureTimeoutMs = helperFailureTimeoutMs;
  }

  async run(request: OwnedJobRequest): Promise<OwnedJobResult> {
    if (this.#closed) throw new OwnedJobError("runner_closed");
    if (this.#failure) throw new OwnedJobError("runner_cleanup_unconfirmed");
    if (request.signal?.aborted) return { stdout: "", stderr: "", exitCode: 1, timedOut: false, cancelled: true };
    const id = randomUUID();
    const encoded = encodeOwnedJobRequest(id, request);
    const decoder = new OwnedJobDecoder(id, request.maxOutputBytes, request.onOutput);
    const child = spawn(this.#path, ["owned-job"], { cwd: request.cwd, env: { ...this.#environment },
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
    let resolve!: (result: OwnedJobResult) => void, reject!: (error: Error) => void;
    const returned = new Promise<OwnedJobResult>((done, fail) => { resolve = done; reject = fail; });
    let finish!: () => void;
    const done = new Promise<void>((complete) => { finish = complete; });
    let ended = false, cancelled = false, backgrounded = false;
    let failure: Error | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failureTimer: ReturnType<typeof setTimeout> | undefined;
    const boundReporting = () => {
      if (ended || failureTimer !== undefined) return;
      failureTimer = setTimeout(() => {
        failure ??= new OwnedJobError("helper_cleanup_unconfirmed");
        this.#failure ??= failure;
        clearTimeout(timer);
        decoder.discardOutput();
        if (!backgrounded) reject(failure);
        // Do not remove the job or terminate the Rust owner. Its separately
        // owned process tree may still require cleanup after this report.
        finish();
      }, this.#helperFailureTimeoutMs);
    };
    const cancel = () => {
      if (ended || cancelled) return;
      cancelled = true;
      boundReporting();
      // Rust owns process cleanup. Keep reading through its final receipt.
      if (!child.stdin.destroyed) child.stdin.write(frame("C", Buffer.from('{"v":1,"cancel":true}')));
    };
    const job = { cancel, done };
    this.#jobs.add(job);
    child.stdout.on("data", (bytes: Buffer) => {
      if (failure) return;
      try { decoder.push(bytes); if (decoder.hasFinalReceipt) boundReporting(); }
      catch (error) {
        failure = error instanceof OwnedJobError ? error : new OwnedJobError("output_consumer_failure");
        this.#failure ??= failure;
        cancel();
      }
    });
    const readFailure = () => {
      failure ??= new OwnedJobError("helper_stream_failure");
      this.#failure ??= failure;
      cancel();
    };
    child.stdout.on("error", readFailure);
    child.stdout.on("end", () => {
      if (!decoder.hasFinalReceipt) readFailure();
      else boundReporting();
    });
    child.stderr.on("error", readFailure);
    // Helper diagnostics must not be confused with job stderr or expose inputs.
    child.stderr.resume();
    child.stdin.on("error", readFailure);
    child.on("error", () => { failure = new OwnedJobError("harness_spawn_failed"); });
    child.once("exit", boundReporting);
    const signal = request.signal;
    child.on("close", (code) => {
      ended = true; clearTimeout(timer); clearTimeout(failureTimer); signal?.removeEventListener("abort", cancel);
      try {
        if (failure) throw failure;
        const result = decoder.finish(code);
        this.#jobs.delete(job);
        if (!backgrounded) resolve(result);
      } catch (error) {
        const safe = error instanceof OwnedJobError ? error : new OwnedJobError("protocol_error");
        if (code === 0 && decoder.hasFinalReceipt && ["spawn_failed", "invalid_request"].includes(safe.code)) this.#jobs.delete(job);
        if (backgrounded || !["spawn_failed", "invalid_request"].includes(safe.code)) this.#failure ??= safe;
        if (!backgrounded) reject(safe);
      } finally { finish(); }
    });
    child.stdin.write(encoded);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    if (request.background && request.timeout !== undefined) {
      const deadline = performance.now() + request.timeout;
      const detach = () => {
        if (ended || cancelled) return;
        const remaining = deadline - performance.now();
        if (remaining > 0) { timer = setTimeout(detach, Math.min(remaining, 2147483647)); return; }
        backgrounded = true;
        const partial = decoder.snapshot(); decoder.discardOutput();
        resolve({ ...partial, exitCode: 0, timedOut: true, backgrounded: true });
      };
      timer = setTimeout(detach, Math.min(request.timeout, 2147483647));
    }
    return returned;
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    const jobs = [...this.#jobs];
    for (const job of jobs) job.cancel();
    this.#closing = Promise.all(jobs.map((job) => job.done)).then(() => {
      if (this.#failure) throw this.#failure;
    });
    return this.#closing;
  }
}
