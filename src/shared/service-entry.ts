import { Socket } from "node:net";
import type { Readable, Writable } from "node:stream";

type ServiceEntry = (input: Readable, output: Writable, errors: Writable) => Promise<void>;
interface EntryOptions {
  platform?: NodeJS.Platform;
  pipeNames?: string;
  connectTimeoutMs?: number;
}

const diagnostic = "Shared service control failed\n";
const failure = () => new Error(diagnostic.trim());

/** Matches harness's private launch contract; remote, mixed-generation and reordered names refuse. */
function pipeNames(value: string | undefined): [string, string, string] {
  const names = value?.split(";");
  const match = names?.[0]?.match(/^\\\\\.\\pipe\\harness-([a-f0-9]{32})-in$/);
  if (!match || names?.length !== 3) throw failure();
  const expected = ["in", "out", "err"].map((role) => `\\\\.\\pipe\\harness-${match[1]}-${role}`);
  if (names.some((name, index) => name !== expected[index])) throw failure();
  return names as [string, string, string];
}

function connect(socket: Socket, path: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("connect", ready); socket.off("error", failed); socket.off("close", failed);
    };
    const ready = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(failure()); };
    const timer = setTimeout(failed, timeoutMs);
    socket.once("connect", ready); socket.once("error", failed); socket.once("close", failed);
    socket.connect(path);
  });
}

function finish(stream: Writable): Promise<void> {
  if (stream.errored || (stream.destroyed && !stream.writableFinished)) return Promise.reject(failure());
  if (stream.writableFinished) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); stream.off("error", failed); };
    const failed = () => { cleanup(); reject(failure()); };
    const timer = setTimeout(failed, 2_000);
    stream.once("error", failed);
    stream.end((error?: Error | null) => { cleanup(); if (error) reject(failure()); else resolve(); });
  });
}

/**
 * Selects the process-owned control transport without creating another process.
 * Windows has no inherited standard handles: connect all three private pipes
 * before invoking the service. Unix keeps its existing inherited stdio path.
 * Options are a trusted host/test seam, never hook or HTTP payload fields.
 */
export async function runServiceEntry(run: ServiceEntry, options: EntryOptions = {}): Promise<void> {
  if ((options.platform ?? process.platform) !== "win32") {
    try { await run(process.stdin, process.stdout, process.stderr); }
    catch { process.stderr.write(diagnostic); throw failure(); }
    return;
  }
  const timeoutMs = options.connectTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw failure();
  const paths = pipeNames(options.pipeNames ?? process.env.HARNESS_SERVICE_PIPES);
  const sockets = paths.map(() => new Socket({ allowHalfOpen: true }));
  const [input, output, errors] = sockets;
  let connected = false;
  let ending = false;
  const failed = () => { if (!ending) input.destroy(failure()); };
  // Retain an error listener through destruction, including partial-connect failures.
  for (const socket of sockets) socket.on("error", failed);
  const closed = sockets.map((socket) => new Promise<void>((resolve) => socket.once("close", () => resolve())));
  try {
    await Promise.all(sockets.map((socket, index) => connect(socket, paths[index], timeoutMs)));
    if (sockets.some((socket) => socket.destroyed) || input.readableEnded) throw failure();
    connected = true;
    await run(input, output, errors);
    ending = true;
    input.destroy();
    // Keep diagnostics open until the final output flush is known to have succeeded.
    await finish(output);
    await finish(errors);
  } catch {
    ending = true;
    if (connected && !errors.destroyed && !errors.writableEnded) {
      errors.write(diagnostic);
      try { await finish(errors); } catch { /* A failed diagnostic pipe cannot expose another diagnostic. */ }
    }
    throw failure();
  } finally {
    ending = true;
    for (const socket of sockets) socket.destroy();
    await Promise.all(closed);
  }
}
