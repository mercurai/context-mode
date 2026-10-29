import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { SharedIdentityRegistry } from "../../src/shared/identity.js";
import { createSharedLaunchAuthority, type SharedLaunchAuthority, type SharedLaunchMetadata } from "../../src/shared/launch-authority.js";
import { runServiceControl, type ControlledService } from "../../src/shared/control.js";
import type { SharedHttpHealth } from "../../src/shared/http.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function frame(type: string, value: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(5); header[0] = type.charCodeAt(0); header.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}
type Envelope = Record<string, unknown>;
type Received = { type: string; value: Envelope };
function channel(run: (input: PassThrough, output: Writable) => Promise<void>, output = new PassThrough()) {
  const input = new PassThrough();
  const messages: Received[] = [];
  let bytes = Buffer.alloc(0);
  let available = deferred<void>();
  output.on("data", (chunk: Buffer) => {
    bytes = Buffer.concat([bytes, chunk]);
    while (bytes.length >= 5 && bytes.length >= 5 + bytes.readUInt32BE(1)) {
      const length = bytes.readUInt32BE(1);
      messages.push({ type: String.fromCharCode(bytes[0]), value: JSON.parse(bytes.subarray(5, 5 + length).toString("utf8")) });
      bytes = bytes.subarray(5 + length);
      available.resolve(); available = deferred<void>();
    }
  });
  const done = run(input, output).then(() => undefined, (error: unknown) => error);
  return { input, output, messages, done,
    async next(): Promise<Received> {
      while (!messages.length) await Promise.race([available.promise, done.then((error) => {
        throw error ?? new Error("Control ended before response");
      })]);
      return messages.shift()!;
    },
  };
}
function request(capability: string) {
  const req = new IncomingMessage(new Socket());
  req.headers.authorization = `Bearer ${capability}`;
  req.rawHeaders = ["Authorization", `Bearer ${capability}`];
  return req;
}

describe("private framed shared service control", () => {
  let root: string;
  let clock: number;
  let metadata: SharedLaunchMetadata;
  let authority: SharedLaunchAuthority;
  let registry: SharedIdentityRegistry;
  let state: SharedHttpHealth["state"];
  let closed: number;
  let closeStarted: ReturnType<typeof deferred<void>>;
  let createStarted: ReturnType<typeof deferred<void>>;
  let listenStarted: ReturnType<typeof deferred<void>>;
  let listenGate: Promise<void> | undefined;
  let createGate: Promise<void> | undefined;
  let closeGate: Promise<void> | undefined;
  let cleanupError: boolean;
  let healthExtra: Record<string, unknown>;
  let address: string;
  let controls: ReturnType<typeof channel>[];

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "shared-control-")));
    metadata = { provider: "codex", home: join(root, "config"), userHome: root, workspace: join(root, "project") };
    for (const path of [metadata.home, metadata.workspace, join(root, "fallback", "tmp")]) mkdirSync(path, { recursive: true });
    for (const [key, value] of Object.entries({ HOME: join(root, "fallback"), USERPROFILE: join(root, "fallback"),
      CODEX_HOME: join(root, "fallback"), CLAUDE_CONFIG_DIR: join(root, "fallback"),
      CONTEXT_MODE_DIR: join(root, "fallback", "store"), CLAUDE_PROJECT_DIR: join(root, "fallback"),
      CONTEXT_MODE_PROJECT_DIR: join(root, "fallback"), TMPDIR: join(root, "fallback", "tmp"),
      TMP: join(root, "fallback", "tmp"), TEMP: join(root, "fallback", "tmp"),
    })) vi.stubEnv(key, value);
    vi.stubEnv("CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS", undefined);
    clock = 0; state = "starting"; closed = 0; controls = []; closeStarted = deferred<void>();
    createStarted = deferred<void>(); listenStarted = deferred<void>();
    listenGate = createGate = closeGate = undefined; cleanupError = false; healthExtra = {}; address = "127.0.0.1";
    registry = new SharedIdentityRegistry({ now: () => new Date(clock), ttlMs: 1000, maxEntries: 10 });
    authority = createSharedLaunchAuthority({ identityRegistry: registry, now: () => new Date(clock),
      ttlMs: 1000, maxLaunches: 2, mcpServerName: "context-mode", toolNames: ["ctx_stats"] });
  });

  afterEach(async () => {
    for (const control of controls) { control.input.end(); control.output.destroy(); }
    await Promise.all(controls.map((control) => control.done));
    authority.close(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
  });

  function service(): ControlledService {
    return {
      issue: (value) => authority.issue(value), revoke: (scope) => authority.revoke(scope),
      async listen() { listenStarted.resolve(); await listenGate; state = "ready"; },
      address: () => ({ address, port: 23145, family: "IPv4" }),
      health: () => ({ state, transportSessions: 0, pendingInitializations: 0, inFlightRequests: 0, ...healthExtra }),
      async close() {
        closed++; authority.close(); state = "closed"; closeStarted.resolve(); await closeGate;
        if (cleanupError) throw new Error("secret cleanup details must not cross control");
      },
    };
  }
  function start(output?: PassThrough) {
    const control = channel((input, writable) => runServiceControl({ kind: "context-mode", input, output: writable,
      now: () => new Date(clock), parseOptions(value) {
        const input = value as { ttlMs: number; maxLaunches: number };
        if (!input || Object.keys(input).sort().join() !== "maxLaunches,ttlMs" || input.ttlMs !== 1000 || input.maxLaunches !== 2) {
          throw new Error("Invalid bootstrap options");
        }
        return input;
      }, async createService() { createStarted.resolve(); await createGate; return service(); },
    }), output);
    controls.push(control); return control;
  }
  const bootstrap = () => ({ v: 1, kind: "context-mode", options: { ttlMs: 1000, maxLaunches: 2 } });
  async function ready(control = start()) {
    control.input.write(frame("B", bootstrap()));
    const message = await control.next();
    expect(message.type).toBe("Y");
    expect(message.value).toMatchObject({ v: 1, kind: "context-mode", mcpUrl: "http://127.0.0.1:23145/mcp",
      hooksUrl: "http://127.0.0.1:23145/hooks", healthUrl: "http://127.0.0.1:23145/health" });
    expect(message.value.generation).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    return { control, generation: message.value.generation as string };
  }
  async function rpc(control: ReturnType<typeof channel>, generation: string, op: string, extra: Envelope = {}) {
    control.input.write(frame("R", { v: 1, id: "request", generation, op, ...extra }));
    const response = await control.next();
    expect(response.type).toBe("S");
    expect(response.value).toMatchObject({ v: 1, id: "request", generation });
    return response.value;
  }

  test("fragmented bootstrap waits for listen and emits canonical ready endpoints", async () => {
    const gate = deferred<void>(); listenGate = gate.promise;
    const control = start(); const bytes = frame("B", bootstrap());
    for (const byte of bytes) control.input.write(Buffer.from([byte]));
    await Promise.race([listenStarted.promise, control.done.then((error) => { throw error; })]);
    expect(control.messages).toEqual([]);
    gate.resolve();
    expect((await control.next()).value.mcpUrl).toBe("http://127.0.0.1:23145/mcp");
  });

  test("issue returns private capabilities and revoke invalidates the exact authority scope", async () => {
    const { control, generation } = await ready();
    const response = await rpc(control, generation, "issue", { metadata });
    expect(response.ok).toBe(true);
    const grant = response.result as { handle: string; mcpCapability: string; hookCapability: string };
    const scope = authority.authenticate(request(grant.mcpCapability));
    expect(grant.handle).toBe(scope.launchId);
    expect(grant.mcpCapability !== grant.hookCapability).toBe(true);
    authority.registerHook(request(grant.hookCapability), { hook_event_name: "SessionStart", session_id: "root", cwd: metadata.workspace });
    expect(registry.resolve(scope, { name: "ctx_stats", _meta: { threadId: "root", sessionId: "root" } }).workspace).toBe(metadata.workspace);
    expect((await rpc(control, generation, "revoke", { handle: grant.handle })).result).toEqual({ revoked: true });
    expect(() => authority.authenticate(request(grant.mcpCapability))).toThrow();
    expect((await rpc(control, generation, "revoke", { handle: grant.handle })).result).toEqual({ revoked: false });
  });

  test("status projects only validated health fields", async () => {
    healthExtra = { credential: "must-not-be-echoed", workspace: metadata.workspace };
    const { control, generation } = await ready();
    expect((await rpc(control, generation, "status")).result).toEqual({ state: "ready", transportSessions: 0,
      pendingInitializations: 0, inFlightRequests: 0 });
  });

  test("expired handles release bounded admission and revoke their existing credentials", async () => {
    const { control, generation } = await ready();
    const issued = [];
    for (let i = 0; i < 2; i++) issued.push((await rpc(control, generation, "issue", { metadata })).result as { mcpCapability: string });
    expect((await rpc(control, generation, "issue", { metadata })).ok).toBe(false);
    clock = 1000;
    expect((await rpc(control, generation, "issue", { metadata })).ok).toBe(true);
    for (const grant of issued) expect(() => authority.authenticate(request(grant.mcpCapability))).toThrow();
  });

  test("shutdown replies only after cleanup settles then ends output", async () => {
    const { control, generation } = await ready(); const gate = deferred<void>(); closeGate = gate.promise;
    control.input.write(frame("R", { v: 1, id: "shutdown", generation, op: "shutdown" }));
    await Promise.race([closeStarted.promise, control.done.then((error) => { throw error; })]);
    expect(control.messages).toEqual([]); gate.resolve();
    const response = await control.next();
    expect(response.value).toMatchObject({ ok: true, result: { closed: true } });
    expect(await control.done).toBeUndefined();
    expect(control.output.writableEnded).toBe(true); expect(closed).toBe(1);
  });

  test("cleanup failure emits only a safe error and ends private output", async () => {
    const { control, generation } = await ready(); cleanupError = true;
    const response = await rpc(control, generation, "shutdown");
    expect(response).toEqual({ v: 1, id: "request", generation, ok: false, error: "cleanup-failed" });
    expect(await control.done).toBeInstanceOf(Error);
    expect(control.output.writableEnded).toBe(true); expect(closed).toBe(1);
  });

  test.each(["extra", "version", "kind", "type", "json", "utf8", "oversize"])("rejects invalid bootstrap %s", async (kind) => {
    const control = start(); let bytes = frame("B", bootstrap());
    if (kind === "extra") bytes = frame("B", { ...bootstrap(), credential: "must-not-be-echoed" });
    if (kind === "version") bytes = frame("B", { ...bootstrap(), v: 2 });
    if (kind === "kind") bytes = frame("B", { ...bootstrap(), kind: "codegraph" });
    if (kind === "type") bytes[0] = 82;
    if (kind === "json" || kind === "utf8") bytes = Buffer.from([66, 0, 0, 0, 1, kind === "json" ? 123 : 255]);
    if (kind === "oversize") { bytes = Buffer.alloc(5); bytes[0] = 66; bytes.writeUInt32BE(65537, 1); }
    control.input.write(bytes);
    expect(await control.done).toBeInstanceOf(Error); expect(control.messages).toEqual([]);
  });

  test.each(["unknown-op", "extra", "generation", "metadata-on-status", "invalid-id", "second-bootstrap"])("fails closed on request %s", async (kind) => {
    const { control, generation } = await ready();
    const request: Envelope = { v: 1, id: "bad", generation, op: "status" };
    if (kind === "unknown-op") request.op = "exec";
    if (kind === "extra") request.secret = "must-not-be-echoed";
    if (kind === "generation") request.generation = "prior-generation";
    if (kind === "metadata-on-status") request.metadata = metadata;
    if (kind === "invalid-id") request.id = 42;
    control.input.write(kind === "second-bootstrap" ? frame("B", bootstrap()) : frame("R", request));
    expect(await control.done).toBeInstanceOf(Error); expect(closed).toBe(1); expect(control.messages).toEqual([]);
  });

  test.each(["eof", "partial-header", "partial-body"])("%s closes authority and service", async (kind) => {
    const { control } = await ready();
    if (kind === "partial-header") control.input.write(Buffer.from([82, 0]));
    if (kind === "partial-body") control.input.write(Buffer.from([82, 0, 0, 0, 10, 123]));
    control.input.end();
    const result = await control.done;
    if (kind === "eof") expect(result).toBeUndefined(); else expect(result).toBeInstanceOf(Error);
    expect(closed).toBe(1); expect(() => authority.issue(metadata)).toThrow();
  });

  test("two coalesced requests exceed the one-pending-request budget", async () => {
    const { control, generation } = await ready();
    control.input.write(Buffer.concat([frame("R", { v: 1, id: "a", generation, op: "status" }),
      frame("R", { v: 1, id: "b", generation, op: "status" })]));
    expect(await control.done).toBeInstanceOf(Error); expect(closed).toBe(1);
  });

  test.each(["create", "listen"])("EOF during pending %s closes the service returned later", async (phase) => {
    const gate = deferred<void>(); if (phase === "create") createGate = gate.promise; else listenGate = gate.promise;
    const control = start(); control.input.write(frame("B", bootstrap()));
    await Promise.race([phase === "create" ? createStarted.promise : listenStarted.promise,
      control.done.then((error) => { throw error; })]);
    control.input.end(); gate.resolve();
    expect(await control.done).toBeUndefined(); expect(closed).toBe(1); expect(control.messages).toEqual([]);
  });

  test("EOF cleans up even when readiness output never drains", async () => {
    let release: (() => void) | undefined;
    const writeStarted = deferred<void>();
    const blocked = new Writable({ highWaterMark: 1, write(_bytes, _encoding, callback) { release = callback; writeStarted.resolve(); } });
    const control = channel((input, output) => runServiceControl({ kind: "context-mode", input, output,
      now: () => new Date(clock), parseOptions: () => ({ ttlMs: 1000, maxLaunches: 2 }), createService: async () => service() }), blocked as PassThrough);
    controls.push(control); control.input.write(frame("B", bootstrap()));
    await Promise.race([writeStarted.promise, control.done.then((error) => { throw error; })]); control.input.end();
    try { expect(await control.done).toBeUndefined(); expect(closed).toBe(1); }
    finally { release?.(); }
  });

  test.each(["0.0.0.0", "example.com"])("never announces nonloopback address %s", async (invalid) => {
    address = invalid; const control = start(); control.input.write(frame("B", bootstrap()));
    expect(await control.done).toBeInstanceOf(Error); expect(closed).toBe(1); expect(control.messages).toEqual([]);
  });

  test("entry import is inert and explicit bootstrap starts real HTTP service", async () => {
    const before = [process.stdin.listenerCount("data"), process.listenerCount("SIGTERM")];
    const { main } = await import("../../src/shared/service-main.js");
    expect([process.stdin.listenerCount("data"), process.listenerCount("SIGTERM")]).toEqual(before);
    const control = channel((input, output) => main(input, output, () => new Date(clock))); controls.push(control);
    control.input.write(frame("B", { v: 1, kind: "context-mode", options: { ttlMs: 1000, maxLaunches: 2,
      maxIdentities: 10, maxProjects: 2, maxSessions: 4, mcpServerName: "context-mode",
      http: { host: "127.0.0.1", port: 0, allowedOrigins: [], limits: { maxTransportSessions: 2,
        maxPendingInitializations: 2, maxInFlightRequests: 4, maxBodyBytes: 2048 } } } }));
    const ready = (await control.next()).value;
    expect((await fetch(ready.healthUrl as string)).status).toBe(200);
    const result = await rpc(control, ready.generation as string, "issue", { metadata });
    const grant = result.result as { hookCapability: string };
    const hook = await fetch(ready.hooksUrl as string, { method: "POST", headers: { authorization: `Bearer ${grant.hookCapability}`,
      "content-type": "application/json" }, body: JSON.stringify({ hook_event_name: "SessionStart", session_id: "root", cwd: metadata.workspace }) });
    expect(hook.status).toBe(202);
    expect((await rpc(control, ready.generation as string, "shutdown")).ok).toBe(true);
    expect(await control.done).toBeUndefined();
  });
});
