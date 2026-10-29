import type { Readable, Writable } from "node:stream";
import type { AddressInfo } from "node:net";
import type { AuthenticatedScope } from "./identity.js";
import type { SharedLaunchGrant, SharedLaunchMetadata } from "./launch-authority.js";
import type { SharedHttpHealth } from "./http.js";
import { randomUUID } from "node:crypto";
export { runServiceEntry } from "./service-entry.js";

export interface ControlledService {
  issue(metadata: SharedLaunchMetadata): SharedLaunchGrant;
  /** Optional private-control renewal; absence preserves the legacy Ready envelope. */
  renew?(scope: Readonly<AuthenticatedScope>): void;
  revoke(scope: Readonly<AuthenticatedScope>): void;
  listen(): Promise<void>;
  address(): AddressInfo;
  health(): SharedHttpHealth;
  close(): Promise<void>;
}

export interface ServiceControlOptions<TOptions extends { ttlMs: number; maxLaunches: number }> {
  kind: "context-mode" | "codegraph";
  input: Readable;
  output: Writable;
  now: () => Date;
  parseOptions(value: unknown): TOptions;
  createService(options: TOptions, now: () => Date): Promise<ControlledService>;
}

/** Private inherited-pipe protocol: ASCII type byte + u32BE length + UTF-8 JSON. */
export async function runServiceControl<TOptions extends { ttlMs: number; maxLaunches: number }>(
  options: ServiceControlOptions<TOptions>,
): Promise<void> {
  const { input, output } = options;
  const generation = randomUUID();
  const abort = new AbortController();
  const handles = new Map<string, { scope: Readonly<AuthenticatedScope>; expiresAt: number }>();
  let service: ControlledService | undefined;
  let configuration: TOptions | undefined;
  let buffer = Buffer.alloc(0);
  let bootstrapped = false;
  let busy = false;
  let stopping = false;
  let writing = false;
  let responding = false;
  let lastTime: number | undefined;
  let operation: Promise<void> | undefined;
  let handoff: Buffer | undefined;
  let cleanup: Promise<void> | undefined;
  let resolveDone!: () => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const invalid = () => new Error("Private control protocol rejected");

  function closeService(): Promise<void> {
    if (!service) return Promise.resolve();
    handles.clear();
    cleanup ??= Promise.resolve().then(() => service!.close());
    // Cleanup can reject before a pending factory/listen operation settles.
    void cleanup.catch(() => undefined);
    return cleanup;
  }

  function finish(error?: unknown): void {
    if (stopping) return;
    stopping = true;
    const blocked = writing;
    abort.abort();
    const earlyCleanup = closeService();
    void earlyCleanup.catch(() => undefined);
    if (blocked) output.destroy();
    void (async () => {
      let failed = Boolean(error);
      try { await operation; } catch { failed = true; }
      try { await closeService(); } catch { failed = true; }
      input.off("data", receive); input.off("end", eof); input.off("error", ioError);
      output.off("error", ioError);
      if (!output.destroyed) output.end();
      if (failed) rejectDone(invalid()); else resolveDone();
    })();
  }

  function now(): number {
    const time = options.now().getTime();
    if (!Number.isSafeInteger(time) || (lastTime !== undefined && time < lastTime)) throw invalid();
    lastTime = time;
    return time;
  }

  async function write(type: "Y" | "S", value: unknown): Promise<void> {
    if (stopping) throw invalid();
    const data = Buffer.from(JSON.stringify(value));
    if (data.length > 65_536) throw invalid();
    const header = Buffer.alloc(5); header[0] = type.charCodeAt(0); header.writeUInt32BE(data.length, 1);
    writing = true;
    responding = true;
    try {
      await new Promise<void>((resolve, reject) => {
        const cancelled = () => reject(invalid());
        abort.signal.addEventListener("abort", cancelled, { once: true });
        output.write(Buffer.concat([header, data]), (error) => {
          abort.signal.removeEventListener("abort", cancelled);
          if (error) reject(invalid()); else resolve();
        });
      });
    } finally { writing = false; }
  }

  function health(): SharedHttpHealth {
    const value = service!.health();
    if (!["starting", "ready", "draining", "closed"].includes(value.state)) throw invalid();
    const result = { state: value.state, transportSessions: value.transportSessions,
      pendingInitializations: value.pendingInitializations, inFlightRequests: value.inFlightRequests };
    for (const count of [result.transportSessions, result.pendingInitializations, result.inFlightRequests]) {
      if (!Number.isSafeInteger(count) || count < 0) throw invalid();
    }
    return result;
  }

  async function bootstrap(value: Record<string, unknown>): Promise<void> {
    exact(value, ["v", "kind", "options"]);
    if (value.v !== 1 || value.kind !== options.kind) throw invalid();
    configuration = options.parseOptions(value.options);
    for (const bound of [configuration.ttlMs, configuration.maxLaunches]) {
      if (!Number.isSafeInteger(bound) || bound <= 0) throw invalid();
    }
    now();
    service = await options.createService(configuration, options.now);
    // Observe pipe EOF already queued by the OS before announcing readiness.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (stopping) { await closeService(); return; }
    await service.listen();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (stopping) { await closeService(); return; }
    if (health().state !== "ready") throw invalid();
    const address = service.address();
    if (!["127.0.0.1", "::1"].includes(address.address) || !Number.isInteger(address.port) || address.port < 1 || address.port > 65535) throw invalid();
    const base = `http://${address.address === "::1" ? "[::1]" : address.address}:${address.port}`;
    bootstrapped = true;
    await write("Y", { v: 1, kind: options.kind, generation, mcpUrl: `${base}/mcp`, hooksUrl: `${base}/hooks`, healthUrl: `${base}/health`,
      ...(typeof service.renew === "function" ? { renew: true } : {}) });
  }

  function expire(): void {
    const time = now();
    for (const [handle, entry] of handles) if (entry.expiresAt <= time) {
      handles.delete(handle); service!.revoke(entry.scope);
    }
  }

  async function request(value: Record<string, unknown>): Promise<void> {
    if (value.v !== 1 || value.generation !== generation || typeof value.id !== "string" || !/^[\x21-\x7e]{1,128}$/.test(value.id)) throw invalid();
    const op = value.op;
    if (!["issue", "revoke", "renew", "status", "shutdown"].includes(String(op))) throw invalid();
    exact(value, ["v", "id", "generation", "op", ...(op === "issue" ? ["metadata"] : (op === "revoke" || op === "renew") ? ["handle"] : [])]);
    const response = { v: 1, id: value.id, generation };
    expire();
    if (op === "shutdown") {
      let error = false;
      try { await closeService(); } catch { error = true; }
      await write("S", error ? { ...response, ok: false, error: "cleanup-failed" } : { ...response, ok: true, result: { closed: true } });
      finish(error ? invalid() : undefined); return;
    }
    if (op === "status") return write("S", { ...response, ok: true, result: health() });
    if (op === "renew") {
      const renew = service!.renew;
      if (typeof renew !== "function" || typeof value.handle !== "string" ||
          !value.handle || value.handle.length > 256) throw invalid();
      const entry = handles.get(value.handle);
      let renewed = false;
      if (entry) {
        try {
          // Pin the control deadline before service work can advance its clock.
          const expiresAt = now() + configuration!.ttlMs;
          if (!Number.isSafeInteger(expiresAt)) throw invalid();
          renew.call(service, entry.scope);
          entry.expiresAt = expiresAt;
          renewed = true;
        } catch {
          handles.delete(value.handle);
          service!.revoke(entry.scope);
        }
      }
      return write("S", { ...response, ok: true, result: { renewed } });
    }
    if (op === "revoke") {
      if (typeof value.handle !== "string" || !value.handle || value.handle.length > 256) throw invalid();
      const entry = handles.get(value.handle); handles.delete(value.handle);
      if (entry) service!.revoke(entry.scope);
      return write("S", { ...response, ok: true, result: { revoked: Boolean(entry) } });
    }
    const metadata = record(value.metadata);
    exact(metadata, ["provider", "home", "userHome", "workspace"]);
    for (const key of ["provider", "home", "userHome", "workspace"]) if (typeof metadata[key] !== "string" || !metadata[key] || (metadata[key] as string).length > 4096) throw invalid();
    let result: { handle: string; mcpCapability: string; hookCapability: string };
    try {
      if (handles.size >= configuration!.maxLaunches) throw invalid();
      const expiresAt = now() + configuration!.ttlMs;
      if (!Number.isSafeInteger(expiresAt)) throw invalid();
      const grant = service!.issue(metadata as unknown as SharedLaunchMetadata);
      if (!grant.scope.launchId || grant.scope.launchId.length > 256 || handles.has(grant.scope.launchId)) throw invalid();
      handles.set(grant.scope.launchId, { scope: Object.freeze({ ...grant.scope }), expiresAt });
      result = { handle: grant.scope.launchId, mcpCapability: grant.mcpCapability, hookCapability: grant.hookCapability };
    } catch { return write("S", { ...response, ok: false, error: "operation-failed" }); }
    await write("S", { ...response, ok: true, result });
  }

  function receive(chunk: Buffer): void {
    if (stopping) return;
    if (!Buffer.isBuffer(chunk) || buffer.length + chunk.length > 65_541) { finish(invalid()); return; }
    if (busy) {
      // Bytes may reach the peer before Node schedules our write callback.
      // Permit one bounded handoff only after the previous output fully drained.
      if (!responding || output.writableNeedDrain || output.writableLength !== 0) { finish(invalid()); return; }
      const size = (handoff?.length ?? 0) + chunk.length;
      if (size > 65_541) { finish(invalid()); return; }
      handoff = handoff ? Buffer.concat([handoff, chunk]) : Buffer.from(chunk);
      if (handoff.length >= 5 && (!handoff.readUInt32BE(1) || handoff.readUInt32BE(1) > 65_536 ||
        handoff.length > 5 + handoff.readUInt32BE(1))) finish(invalid());
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length < 5) return;
    const length = buffer.readUInt32BE(1);
    if (!length || length > 65_536 || buffer.length > length + 5) { finish(invalid()); return; }
    if (buffer.length < length + 5) return;
    const type = String.fromCharCode(buffer[0]);
    let value: Record<string, unknown>;
    try {
      value = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(5))));
      if (type !== (bootstrapped ? "R" : "B")) throw invalid();
    } catch { finish(invalid()); return; }
    buffer = Buffer.alloc(0); busy = true;
    operation = (bootstrapped ? request(value) : bootstrap(value)).then(() => {
      busy = false; responding = false;
      if (handoff && !stopping) { const next = handoff; handoff = undefined; receive(next); }
    }, () => {
      busy = false; responding = false;
      if (!stopping) finish(invalid());
    });
  }
  function eof() { finish(buffer.length || handoff?.length ? invalid() : undefined); }
  function ioError() { finish(invalid()); }
  input.on("data", receive).once("end", eof).once("error", ioError);
  output.on("error", ioError);
  if (input.readableEnded || input.destroyed || output.destroyed) finish();
  return done;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid control record");
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, fields: readonly string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) throw new Error("Invalid control fields");
}
