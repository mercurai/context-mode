import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { connect as connectSocket, createServer as createNetServer, Server } from "node:net";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { SharedIdentityRegistry, type AuthenticatedScope, type NativeToolCall, type ResolvedIdentity } from "../../src/shared/identity.js";
import type { SharedRuntime, SharedRuntimeRequestContext } from "../../src/shared/runtime.js";
import { createSharedHttpService, type SharedHttpLimits, type SharedHttpService } from "../../src/shared/http.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

type Connected = { client: Client; transport: StreamableHTTPClientTransport; credential: string };
type RunningCall = {
  scope: AuthenticatedScope;
  request: NativeToolCall;
  context: SharedRuntimeRequestContext;
  aborted: ReturnType<typeof deferred<void>>;
  release: ReturnType<typeof deferred<void>>;
};

/** A controllable job boundary; requests still cross a real SDK HTTP transport. */
function controlledRuntime() {
  const calls: RunningCall[] = [];
  let entered = deferred<RunningCall>();
  const runtime: SharedRuntime = {
    listTools: () => [{ name: "hold", config: { inputSchema: z.object({}) } }],
    async call(scope, request, context) {
      if (!context) throw new Error("HTTP omitted request ownership");
      const call = { scope, request, context, aborted: deferred<void>(), release: deferred<void>() };
      context.signal.addEventListener("abort", () => call.aborted.resolve(), { once: true });
      calls.push(call);
      const waiting = entered;
      entered = deferred<RunningCall>();
      waiting.resolve(call);
      await call.release.promise;
      return { content: [{ type: "text", text: "completed" }] };
    },
    async close() { for (const call of calls) call.release.resolve(); },
  };
  return { runtime, calls, next: () => entered.promise };
}

describe("shared HTTP service", () => {
  let root: string;
  let registry: SharedIdentityRegistry;
  let runtime: SharedRuntime | undefined;
  let service: SharedHttpService | undefined;
  let url: URL;
  let owners: ResolvedIdentity[];
  let credentials: Map<string, AuthenticatedScope>;
  let clients: Connected[];
  let pending: Array<{ controller: AbortController; response: Promise<Response | undefined> }>;
  let releaseJobs: (() => void) | undefined;
  let toolSequence: number;
  let onAuthenticated: ((request: import("node:http").IncomingMessage) => void) | undefined;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "ctx-shared-http-")));
    const fallback = join(root, "fallback");
    mkdirSync(join(fallback, "tmp"), { recursive: true });
    for (const [key, value] of Object.entries({
      HOME: fallback, USERPROFILE: fallback, CLAUDE_CONFIG_DIR: join(fallback, ".claude"),
      CODEX_HOME: join(fallback, ".codex"), CONTEXT_MODE_DIR: join(fallback, "storage"),
      CLAUDE_PROJECT_DIR: fallback, CONTEXT_MODE_PROJECT_DIR: fallback,
      CLAUDE_SESSION_ID: "unregistered-fallback",
      TMPDIR: join(fallback, "tmp"), TEMP: join(fallback, "tmp"), TMP: join(fallback, "tmp"),
    })) vi.stubEnv(key, value);
    vi.stubEnv("CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS", undefined);
    registry = new SharedIdentityRegistry({ now: () => new Date(0), ttlMs: 60_000, maxEntries: 100 });
    owners = (["codex", "claude-code"] as const).map((provider, index) => {
      const owner = { provider, home: join(root, `home-${index}`), workspace: join(root, `worktree-${index}`),
        launchId: `launch-${index}`, sessionId: `conversation-${index}`, threadId: `thread-${index}` };
      mkdirSync(owner.home);
      mkdirSync(owner.workspace);
      writeFileSync(join(owner.workspace, "notes.md"), `# Orchard\n\nOrchard research contains ${index ? "betapears" : "alphaapples"}.`);
      return owner;
    });
    credentials = new Map();
    clients = [];
    pending = [];
    releaseJobs = undefined;
    toolSequence = 0;
    onAuthenticated = undefined;
  });

  afterEach(async () => {
    for (const request of pending) request.controller.abort();
    releaseJobs?.();
    try {
      await Promise.allSettled(clients.map(({ client }) => client.close()));
      await service?.close();
      await runtime?.close();
      await Promise.allSettled(pending.map(({ response }) => response));
    } finally {
      service = undefined;
      runtime = undefined;
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  function authorize(owner: ResolvedIdentity): string {
    const credential = randomUUID();
    credentials.set(credential, { provider: owner.provider, home: owner.home, launchId: owner.launchId });
    return credential;
  }

  async function start(controlled?: ReturnType<typeof controlledRuntime>, limits: Partial<SharedHttpLimits> = {}) {
    if (controlled) {
      runtime = controlled.runtime;
      releaseJobs = () => controlled.calls.forEach((call) => call.release.resolve());
    } else {
      const { createSharedRuntime } = await import("../../src/shared/runtime.js");
      runtime = await createSharedRuntime({ identityRegistry: registry, maxProjects: 4, maxSessions: 8,
        now: () => 1_800_000_000_000 });
    }
    const authority = {
      authenticate(request: import("node:http").IncomingMessage) {
        const authorization = request.headers.authorization;
        const scope = authorization?.startsWith("Bearer ") ? credentials.get(authorization.slice(7)) : undefined;
        if (!scope) throw new Error("Unauthenticated launch");
        onAuthenticated?.(request);
        return { ...scope };
      },
      isActive(scope: AuthenticatedScope) {
        return [...credentials.values()].some((candidate) => candidate.provider === scope.provider &&
          candidate.home === scope.home && candidate.launchId === scope.launchId);
      },
    };
    service = createSharedHttpService({ runtime, host: "127.0.0.1", port: 0, allowedOrigins: [], authority,
      limits: { maxTransportSessions: 8, maxPendingInitializations: 4, maxInFlightRequests: 8,
        maxBodyBytes: 64 * 1024, ...limits },
    });
    await service.listen();
    url = new URL(`http://127.0.0.1:${service.address().port}/mcp`);
  }

  async function connect(owner = owners[0]): Promise<Connected> {
    const credential = authorize(owner);
    const client = new Client({ name: "shared-http-test", version: "1" });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${credential}` } },
    });
    const connected = { client, transport, credential };
    clients.push(connected);
    await client.connect(transport);
    return connected;
  }

  function metadata(owner: ResolvedIdentity, name: string) {
    const scope = { provider: owner.provider, home: owner.home, launchId: owner.launchId };
    if (owner.provider === "codex") {
      registry.register(scope, { kind: "codex-thread", threadId: owner.threadId!,
        sessionId: owner.sessionId, workspace: owner.workspace });
      return { threadId: owner.threadId, sessionId: owner.sessionId };
    }
    const toolUseId = `tool-${++toolSequence}`;
    registry.register(scope, { kind: "claude-tool-call", toolUseId, tool: name,
      sessionId: owner.sessionId, workspace: owner.workspace });
    return { "claudecode/toolUseId": toolUseId };
  }

  async function call(connected: Connected, owner: ResolvedIdentity, name: string, args: Record<string, unknown>) {
    const result = await connected.client.callTool({ name, arguments: args, _meta: metadata(owner, name) });
    expect(result.isError).not.toBe(true);
    return JSON.stringify(result.content);
  }

  function headers(connected: Connected): Record<string, string> {
    return { authorization: `Bearer ${connected.credential}`, "content-type": "application/json",
      accept: "application/json, text/event-stream", "mcp-session-id": connected.transport.sessionId!,
      "mcp-protocol-version": "2025-11-25" };
  }

  function request(connected: Connected, body: unknown) {
    const controller = new AbortController();
    const response = fetch(url, { method: "POST", headers: headers(connected), body: JSON.stringify(body),
      signal: controller.signal }).catch((error: unknown) => {
      if (controller.signal.aborted) return undefined;
      throw error;
    });
    // Attach rejection handling immediately; callers still observe response failures.
    void response.catch(() => undefined);
    const started = { controller, response };
    pending.push(started);
    return started;
  }

  function hold(connected: Connected, id: string | number) {
    return request(connected, { jsonrpc: "2.0", id, method: "tools/call", params: { name: "hold", arguments: {} } });
  }

  async function cancel(connected: Connected, requestId: string | number) {
    const result = await request(connected, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId } }).response;
    expect(result?.status).toBe(202);
  }

  test("SDK discovery exposes runtime-supported schemas and health contains no identities", async () => {
    await start();
    const connected = await connect();
    const listed = await connected.client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(["ctx_index", "ctx_search", "ctx_stats"]);
    expect(listed.tools.find((tool) => tool.name === "ctx_search")?.inputSchema.properties).toHaveProperty("queries");
    const response = await fetch(new URL("/health", url));
    expect(response.status).toBe(200);
    const health = await response.json();
    expect(health).toMatchObject({ state: "ready", transportSessions: 1 });
    expect(JSON.stringify(health)).not.toContain(owners[0].home);
    expect(JSON.stringify(health)).not.toContain(connected.credential);
  });

  test("simultaneous SDK clients index and search their registered worktrees", async () => {
    await start();
    const connected = await Promise.all(owners.map((owner) => connect(owner)));
    await Promise.all(connected.map((client, index) => call(client, owners[index], "ctx_index", { path: "notes.md", source: "notes" })));
    const results = await Promise.all(connected.map((client, index) => call(client, owners[index], "ctx_search", { queries: ["orchard"] })));
    expect(results[0]).toContain("alphaapples");
    expect(results[0]).not.toContain("betapears");
    expect(results[1]).toContain("betapears");
    expect(results[1]).not.toContain("alphaapples");
  });

  test("two conversations in one MCP session retain separate memory", async () => {
    await start();
    const connected = await connect();
    const second = { ...owners[0], threadId: "thread-child", sessionId: "conversation-child" };
    await call(connected, owners[0], "ctx_index", { content: "Orchard has alphaapples.", source: "notes" });
    await call(connected, second, "ctx_index", { content: "Orchard has childbananas.", source: "notes" });
    const first = await call(connected, owners[0], "ctx_search", { queries: ["orchard"] });
    const child = await call(connected, second, "ctx_search", { queries: ["orchard"] });
    expect(first).toContain("alphaapples");
    expect(first).not.toContain("childbananas");
    expect(child).toContain("childbananas");
    expect(child).not.toContain("alphaapples");
  });

  test.each(["missing", "revoked", "cross-launch", "host", "origin"])("rejects %s before tool storage effects", async (kind) => {
    await start();
    const connected = await connect();
    const requestHeaders = headers(connected);
    if (kind === "missing") delete requestHeaders.authorization;
    if (kind === "revoked") credentials.delete(connected.credential);
    if (kind === "cross-launch") requestHeaders.authorization = `Bearer ${authorize(owners[1])}`;
    if (kind === "host") requestHeaders.host = "attacker.invalid";
    if (kind === "origin") requestHeaders.origin = "https://attacker.invalid";
    const payload = JSON.stringify({
      jsonrpc: "2.0", id: 91, method: "tools/call", params: { name: "ctx_index",
        arguments: { content: "Must not be stored.", source: "denied" }, _meta: metadata(owners[0], "ctx_index") },
    });
    // node:http gives this test explicit control over the Host wire header.
    const status = await new Promise<number>((resolve, reject) => {
      const outgoing = httpRequest(url, { method: "POST", headers: requestHeaders }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode!));
        response.once("error", reject);
      });
      outgoing.once("error", reject);
      outgoing.end(payload);
    });
    expect(status).toBe(kind === "missing" || kind === "revoked" ? 401 : 403);
    expect(readdirSync(owners[0].home)).toEqual([]);
    expect(readdirSync(owners[1].home)).toEqual([]);
  });

  test("transport capacity bounds concurrent initialization and DELETE permits replacement", async () => {
    await start(undefined, { maxTransportSessions: 2 });
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => connect()));
    const admitted = results.filter((result): result is PromiseFulfilledResult<Connected> => result.status === "fulfilled");
    expect(admitted).toHaveLength(2);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(4);
    expect(service!.health()).toMatchObject({ transportSessions: 2, pendingInitializations: 0 });
    await admitted[0].value.transport.terminateSession();
    const replacement = await connect();
    expect((await replacement.client.listTools()).tools).toHaveLength(3);
    expect(service!.health().transportSessions).toBe(2);
  });

  test.each(["GET", "DELETE"])("%s requires current launch authentication", async (method) => {
    await start();
    const connected = await connect();
    const requestHeaders = headers(connected);
    delete requestHeaders.authorization;
    const denied = await fetch(url, { method, headers: requestHeaders });
    expect(denied.status).toBe(401);
    expect((await connected.client.listTools()).tools).toHaveLength(3);
    expect(service!.health().transportSessions).toBe(1);
  });

  test.each([0, "request-a"])("cancellation of %s affects only its transport-owned request", async (id) => {
    const controlled = controlledRuntime();
    await start(controlled);
    const a = await connect();
    const b = await connect(owners[1]);
    let next = controlled.next();
    hold(a, id);
    const first = await next;
    next = controlled.next();
    hold(b, id);
    const second = await next;
    next = controlled.next();
    hold(a, "another-request");
    const sameTransport = await next;
    await cancel(a, "unknown-request");
    expect(first.context.signal.aborted).toBe(false);
    expect(second.context.signal.aborted).toBe(false);
    await cancel(a, id);
    await first.aborted.promise;
    expect(first.context.signal.aborted).toBe(true);
    expect(second.context.signal.aborted).toBe(false);
    expect(sameTransport.context.signal.aborted).toBe(false);
    expect(first.context.transportSessionId).not.toBe(second.context.transportSessionId);
    expect(first.context.requestId).toBe(id);
    second.release.resolve();
    sameTransport.release.resolve();
  });

  test("duplicate in-flight request IDs cannot replace cancellation ownership", async () => {
    const controlled = controlledRuntime();
    await start(controlled);
    const connected = await connect();
    const next = controlled.next();
    hold(connected, "duplicate");
    const original = await next;
    const duplicate = await hold(connected, "duplicate").response;
    expect(duplicate?.status).toBe(409);
    expect(controlled.calls).toHaveLength(1);
    await cancel(connected, "duplicate");
    await original.aborted.promise;
    expect(original.context.signal.aborted).toBe(true);
  });

  test("HTTP disconnect preserves work until explicit cancellation arrives", async () => {
    const controlled = controlledRuntime();
    await start(controlled);
    const connected = await connect();
    const next = controlled.next();
    const dropped = hold(connected, "survives-disconnect");
    const running = await next;
    dropped.controller.abort();
    await dropped.response;
    // Round trip establishes that the service processed another request after disconnect.
    await connected.client.listTools();
    expect(running.context.signal.aborted).toBe(false);
    await cancel(connected, "survives-disconnect");
    await running.aborted.promise;
    expect(running.context.signal.aborted).toBe(true);
  });

  test("DELETE cancels its transport jobs while another transport remains usable", async () => {
    const controlled = controlledRuntime();
    await start(controlled);
    const a = await connect();
    const b = await connect(owners[1]);
    let next = controlled.next();
    hold(a, 31);
    const first = await next;
    next = controlled.next();
    hold(b, 31);
    const second = await next;
    await a.transport.terminateSession();
    await first.aborted.promise;
    expect(second.context.signal.aborted).toBe(false);
    expect((await b.client.listTools()).tools.map((tool) => tool.name)).toEqual(["hold"]);
    second.release.resolve();
  });

  test.each([false, true])("an auth failure cancels work only when trusted authority confirms revocation: %s", async (revoked) => {
    const controlled = controlledRuntime();
    await start(controlled);
    const connected = await connect();
    const next = controlled.next();
    hold(connected, "owned-job");
    const running = await next;
    const requestHeaders = headers(connected);
    if (revoked) credentials.delete(connected.credential);
    else requestHeaders.authorization = `Bearer ${randomUUID()}`;
    const response = await fetch(url, { method: "POST", headers: requestHeaders, body: JSON.stringify({
      jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "owned-job" },
    }) });
    expect(response.status).toBe(401);
    expect(running.context.signal.aborted).toBe(revoked);
  });

  test("DELETE retains request capacity until its cancelled job actually completes", async () => {
    const controlled = controlledRuntime();
    await start(controlled, { maxInFlightRequests: 1 });
    const a = await connect();
    const b = await connect(owners[1]);
    const next = controlled.next();
    hold(a, "slow-cancellation");
    const running = await next;
    await a.transport.terminateSession();
    expect(running.context.signal.aborted).toBe(true);
    const entered = controlled.next();
    const attempt = hold(b, "must-wait");
    const outcome = await Promise.race([
      attempt.response.then((response) => response?.status), entered.then(() => "dispatched"),
    ]);
    expect(outcome).toBe(429);
    expect(controlled.calls).toHaveLength(1);
    expect(service!.health().inFlightRequests).toBe(1);
    running.release.resolve();
    await fetch(new URL("/health", url));
    expect(service!.health().inFlightRequests).toBe(0);
    expect((await b.client.listTools()).tools.map((tool) => tool.name)).toEqual(["hold"]);
  });

  test("body size is bounded before dispatching a tool", async () => {
    const controlled = controlledRuntime();
    await start(controlled, { maxBodyBytes: 1024 });
    const connected = await connect();
    const denied = await request(connected, { jsonrpc: "2.0", id: "oversize", method: "tools/call",
      params: { name: "hold", arguments: { payload: "x".repeat(2048) } } }).response;
    expect(denied?.status).toBe(413);
    expect(controlled.calls).toHaveLength(0);
    expect(service!.health().inFlightRequests).toBe(0);
  });

  test("revocation during a partial POST upload prevents tool dispatch", async () => {
    const controlled = controlledRuntime();
    await start(controlled);
    const connected = await connect();
    const authenticated = deferred<void>();
    onAuthenticated = (request) => {
      if (request.method === "POST" && request.headers["x-test-upload"] === "partial") authenticated.resolve();
    };
    const payload = JSON.stringify({ jsonrpc: "2.0", id: "slow-upload", method: "tools/call",
      params: { name: "hold", arguments: {} } });
    const response = deferred<number>();
    const outgoing = httpRequest(url, { method: "POST", headers: { ...headers(connected), "x-test-upload": "partial" } }, (incoming) => {
      incoming.resume();
      incoming.once("end", () => response.resolve(incoming.statusCode!));
    });
    const failed = new Promise<never>((_, reject) => outgoing.once("error", reject));
    void failed.catch(() => undefined);
    const entered = controlled.next();
    try {
      outgoing.write(payload.slice(0, 1));
      await Promise.race([authenticated.promise, failed]);
      credentials.delete(connected.credential);
      outgoing.end(payload.slice(1));
      const outcome = await Promise.race([response.promise, failed, entered.then(() => "dispatched")]);
      expect(outcome).toBe(401);
      expect(controlled.calls).toHaveLength(0);
    } finally {
      outgoing.destroy();
      onAuthenticated = undefined;
    }
  });

  test("shutdown closes the listener even when runtime cleanup throws", async () => {
    const controlled = controlledRuntime();
    await start(controlled);
    const address = service!.address();
    const closeRuntime = controlled.runtime.close;
    controlled.runtime.close = async () => { throw new Error("Runtime cleanup failed"); };
    try {
      await expect(service!.close()).rejects.toThrow(/Runtime cleanup failed/);
      const outcome = await new Promise<string>((resolve) => {
        const socket = connectSocket({ host: "127.0.0.1", port: address.port });
        socket.once("connect", () => { socket.destroy(); resolve("connected"); });
        socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "unknown"));
      });
      expect(outcome).toBe("ECONNREFUSED");
    } finally {
      controlled.runtime.close = closeRuntime;
      // close() is idempotent and retains its rejection. It was asserted above;
      // do not turn the expected error into a second fixture-cleanup failure.
      service = undefined;
    }
  });

  test("repeated DELETE of pending requests does not consume future HTTP admission", async () => {
    const controlled = controlledRuntime();
    await start(controlled, { maxTransportSessions: 1, maxPendingInitializations: 1, maxInFlightRequests: 1 });
    // Exceed the service's entire HTTP admission budget with completed teardown
    // cycles. Each cycle must return its slot, not merely its job capacity.
    for (let cycle = 0; cycle < 8; cycle++) {
      const connected = await connect();
      const next = controlled.next();
      hold(connected, `cycle-${cycle}`);
      const running = await next;
      await connected.transport.terminateSession();
      running.release.resolve();
      await fetch(new URL("/health", url));
      expect(service!.health().inFlightRequests).toBe(0);
    }
    const connected = await connect();
    expect((await connected.client.listTools()).tools.map((tool) => tool.name)).toEqual(["hold"]);
  });

  test("completed JSON requests release their SDK response stream records", async () => {
    await start(controlledRuntime());
    const connected = await connect();
    // Observe Map allocation/deallocation through public methods; never read or
    // change a private SDK field. JSON stream entries have a response resolver.
    const retained: Array<{ owner: Map<unknown, unknown>; key: unknown }> = [];
    const originalSet = Map.prototype.set;
    const originalDelete = Map.prototype.delete;
    let allocated = 0;
    const set = vi.spyOn(Map.prototype, "set").mockImplementation(function (this: Map<unknown, unknown>, key, value) {
      if (value && typeof value === "object" && typeof value.resolveJson === "function") {
        allocated++;
        retained.push({ owner: this, key });
      }
      return originalSet.call(this, key, value);
    });
    const remove = vi.spyOn(Map.prototype, "delete").mockImplementation(function (this: Map<unknown, unknown>, key) {
      const index = retained.findIndex((entry) => entry.owner === this && entry.key === key);
      if (index !== -1) retained.splice(index, 1);
      return originalDelete.call(this, key);
    });
    try {
      for (let request = 0; request < 12; request++) {
        expect((await connected.client.listTools()).tools.map((tool) => tool.name)).toEqual(["hold"]);
      }
      expect(allocated).toBe(12);
      expect(retained).toHaveLength(0);
    } finally {
      set.mockRestore();
      remove.mockRestore();
    }
  });

  test("partial-header connections cannot exceed the service connection budget", async () => {
    await start(controlledRuntime(), { maxTransportSessions: 1, maxPendingInitializations: 1, maxInFlightRequests: 1 });
    const sockets: import("node:net").Socket[] = [];
    try {
      for (let index = 0; index < 6; index++) {
        await new Promise<void>((resolve, reject) => {
          const socket = connectSocket({ host: "127.0.0.1", port: service!.address().port });
          sockets.push(socket);
          socket.once("error", reject);
          socket.once("connect", () => {
            socket.off("error", reject);
            socket.on("error", () => undefined);
            socket.write("GET /health HTTP/1.1\r\n");
            resolve();
          });
        });
      }
      const outcome = await new Promise<string>((resolve) => {
        const outgoing = httpRequest(new URL("/health", url), { agent: false }, (response) => {
          response.resume();
          response.once("end", () => resolve(`HTTP ${response.statusCode}`));
        });
        outgoing.once("error", () => resolve("connection refused"));
        outgoing.end();
      });
      expect(outcome).toBe("connection refused");
    } finally {
      for (const socket of sockets) socket.destroy();
    }
  });

  test("shutdown closes a session whose SDK connection finishes after draining", async () => {
    const controlled = controlledRuntime();
    await start(controlled);
    const entered = deferred<void>();
    const release = deferred<void>();
    let created: McpServer | undefined;
    let runtimeClosed = false;
    const originalRuntimeClose = controlled.runtime.close;
    controlled.runtime.close = async () => { runtimeClosed = true; await originalRuntimeClose(); };
    const originalConnect = McpServer.prototype.connect;
    const connectGate = vi.spyOn(McpServer.prototype, "connect").mockImplementation(async function (transport) {
      created = this;
      entered.resolve();
      await release.promise;
      await originalConnect.call(this, transport);
    });
    const connection = connect().then(() => "connected", () => "closed");
    try {
      await entered.promise;
      await service!.close();
      expect(runtimeClosed).toBe(true);
      release.resolve();
      // SDK connection and HTTP admission resume through microtasks. A turn of
      // the event loop drains those continuations without a wall-clock delay.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(created!.isConnected()).toBe(false);
      expect(service!.health()).toMatchObject({ state: "closed", transportSessions: 0,
        pendingInitializations: 0, inFlightRequests: 0 });
      expect(await connection).toBe("closed");
      expect(controlled.calls).toHaveLength(0);
    } finally {
      release.resolve();
      connectGate.mockRestore();
      await created?.close();
      await connection;
    }
  });

  test("shutdown during pending listener startup cannot reopen the service", async () => {
    const controlled = controlledRuntime();
    runtime = controlled.runtime;
    service = createSharedHttpService({ runtime, host: "127.0.0.1", port: 0, allowedOrigins: [],
      authority: { authenticate: () => { throw new Error("No launch"); }, isActive: () => false },
      limits: { maxTransportSessions: 1, maxPendingInitializations: 1, maxInFlightRequests: 1, maxBodyBytes: 1024 } });
    const entered = deferred<void>();
    let resume!: () => void;
    let server!: Server;
    const originalListen = Server.prototype.listen;
    const gate = vi.spyOn(Server.prototype, "listen").mockImplementation(function (...args: unknown[]) {
      server = this;
      resume = () => { Reflect.apply(originalListen, this, args); };
      entered.resolve();
      return this;
    });
    const listening = service.listen().then(() => "ready", () => "closed");
    try {
      await entered.promise;
      await service.close();
      expect(service.health().state).toBe("closed");
      gate.mockRestore();
      resume();
      expect(await listening).toBe("closed");
      expect(server.listening).toBe(false);
      expect(server.address()).toBeNull();
      expect(service.health().state).toBe("closed");
      expect(() => service!.address()).toThrow(/not running/);
    } finally {
      gate.mockRestore();
      if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await listening;
    }
  });

  test("bind failure can be closed without leaking runtime or listener", async () => {
    const occupied = createNetServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", resolve);
    });
    const controlled = controlledRuntime();
    let runtimeClosed = false;
    controlled.runtime.close = async () => { runtimeClosed = true; };
    runtime = controlled.runtime;
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("Missing occupied port");
    service = createSharedHttpService({ runtime, host: "127.0.0.1", port: address.port, allowedOrigins: [],
      authority: { authenticate: () => { throw new Error("No launch"); }, isActive: () => false },
      limits: { maxTransportSessions: 1, maxPendingInitializations: 1, maxInFlightRequests: 1, maxBodyBytes: 1024 } });
    try {
      await expect(service.listen()).rejects.toMatchObject({ code: "EADDRINUSE" });
      await service.close();
      expect(runtimeClosed).toBe(true);
      expect(service.health().state).toBe("closed");
      expect(() => service!.address()).toThrow(/not running/);
      expect(occupied.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });
});
