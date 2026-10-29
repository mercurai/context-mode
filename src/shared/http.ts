import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isInitializeRequest, isJSONRPCRequest, type JSONRPCRequest } from "@modelcontextprotocol/sdk/types.js";
import type { AuthenticatedScope } from "./identity.js";
import type { SharedRuntime } from "./runtime.js";
import { createSharedMcpSession, type SharedMcpSession } from "./mcp-server.js";
import { MemoryHookFailure, type MemoryHookCode, type MemoryHookProcessor } from "./memory-hooks.js";

/** Trusted launch authority; HTTP callers cannot choose their own scope. */
export interface SharedHttpAuthority {
  authenticate(request: IncomingMessage): AuthenticatedScope | Promise<AuthenticatedScope>;
  isActive(scope: Readonly<AuthenticatedScope>): boolean | Promise<boolean>;
}

export interface SharedHttpLimits {
  maxTransportSessions: number;
  maxPendingInitializations: number;
  maxInFlightRequests: number;
  maxBodyBytes: number;
}

/** Purpose-specific native-hook capability; issuance remains internal. */
export interface SharedHttpHookAuthority {
  authenticateHook(request: IncomingMessage): Readonly<AuthenticatedScope> | Promise<Readonly<AuthenticatedScope>>;
  registerHook(request: IncomingMessage, payload: unknown): void | Promise<void>;
}

export interface SharedHttpOptions {
  runtime: SharedRuntime;
  authority: SharedHttpAuthority;
  hookAuthority?: SharedHttpHookAuthority;
  memoryHook?: MemoryHookProcessor;
  host: "127.0.0.1" | "::1";
  port: number;
  allowedOrigins: readonly string[];
  limits: SharedHttpLimits;
}

export interface SharedHttpHealth {
  state: "starting" | "ready" | "draining" | "closed";
  transportSessions: number;
  pendingInitializations: number;
  inFlightRequests: number;
}

export interface SharedHttpService {
  listen(): Promise<void>;
  address(): AddressInfo;
  health(): SharedHttpHealth;
  close(): Promise<void>;
}

class HttpFailure extends Error {
  constructor(readonly status: number, message: string, readonly code?: MemoryHookCode) { super(message); }
}

function reply(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function sameScope(a: Readonly<AuthenticatedScope>, b: AuthenticatedScope): boolean {
  return a.provider === b.provider && a.home === b.home && a.launchId === b.launchId;
}

async function body(request: IncomingMessage, maximum: number): Promise<unknown> {
  const length = Number(request.headers["content-length"]);
  if (Number.isFinite(length) && length > maximum) throw new HttpFailure(413, "Request body too large");
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      request.off("data", data);
      request.off("end", end);
      request.off("error", failure);
      request.off("aborted", aborted);
    };
    const failure = (error: Error) => { cleanup(); reject(error); };
    const aborted = () => failure(new HttpFailure(400, "Incomplete request"));
    const end = () => { cleanup(); resolve(Buffer.concat(chunks, size)); };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > maximum) {
        request.pause();
        failure(new HttpFailure(413, "Request body too large"));
      } else chunks.push(chunk);
    };
    request.on("data", data).once("end", end).once("error", failure).once("aborted", aborted);
  });
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new HttpFailure(400, "Invalid JSON"); }
}

function validateOptions(options: SharedHttpOptions): void {
  if (!["127.0.0.1", "::1"].includes(options.host) || !Number.isInteger(options.port) ||
    options.port < 0 || options.port > 65535) throw new Error("Invalid loopback listener");
  for (const value of Object.values(options.limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid HTTP capacity");
  }
}

export function createSharedHttpService(options: SharedHttpOptions): SharedHttpService {
  validateOptions(options);
  const sessions = new Map<string, SharedMcpSession>();
  const allSessions = new Set<SharedMcpSession>();
  const memoryOperations = new Set<Promise<unknown>>();
  let state: SharedHttpHealth["state"] = "starting";
  let pendingInitializations = 0;
  let reservedInitializations = 0;
  let httpRequests = 0;
  let closePromise: Promise<void> | undefined;
  const health = (): SharedHttpHealth => ({ state, transportSessions: sessions.size, pendingInitializations,
    inFlightRequests: memoryOperations.size + [...allSessions].reduce((sum, session) => sum + session.requests.size, 0) });
  const listener = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    void dispatch(request, response).catch((error: unknown) => {
      const known = error instanceof HttpFailure || error instanceof MemoryHookFailure;
      reply(response, known ? error.status : 500,
        { error: known ? error.message : "Request failed", ...(known && error.code ? { code: error.code } : {}) });
      // A rejected/oversize body must not retain its socket or resume reading
      // unbounded bytes. Flush the bounded response, then close this connection.
      if (!request.complete) response.once("finish", () => request.destroy());
    });
  });
  listener.headersTimeout = 15_000;
  listener.requestTimeout = 30_000;
  // Header parsing precedes the request event, so HTTP admission alone cannot
  // bound sockets that send only partial headers. This service is not clustered.
  listener.maxConnections = options.limits.maxInFlightRequests + options.limits.maxPendingInitializations +
    options.limits.maxTransportSessions + 2;

  function checkBoundary(request: IncomingMessage): void {
    const address = listener.address();
    if (!address || typeof address === "string") throw new HttpFailure(503, "Service unavailable");
    const host = options.host === "::1" ? `[::1]:${address.port}` : `127.0.0.1:${address.port}`;
    if (request.headers.host !== host) throw new HttpFailure(403, "Invalid Host");
    const origin = request.headers.origin;
    if (origin && !options.allowedOrigins.includes(origin)) throw new HttpFailure(403, "Invalid Origin");
  }

  function admit(session: SharedMcpSession, parsed: unknown): JSONRPCRequest[] {
    const requests = (Array.isArray(parsed) ? parsed : [parsed]).filter(isJSONRPCRequest);
    const ids = new Set(requests.map((request) => request.id));
    if (ids.size !== requests.length || requests.some((request) => session.requests.has(request.id))) {
      throw new HttpFailure(409, "Request ID already active");
    }
    if (health().inFlightRequests + requests.length > options.limits.maxInFlightRequests) {
      throw new HttpFailure(429, "Request capacity exceeded");
    }
    for (const request of requests) session.requests.set(request.id, { controller: new AbortController(), method: request.method });
    return requests;
  }

  async function authenticate(request: IncomingMessage): Promise<AuthenticatedScope> {
    try { return await options.authority.authenticate(request); }
    catch { throw new HttpFailure(401, "Unauthenticated launch"); }
  }

  async function assertActive(scope: Readonly<AuthenticatedScope>): Promise<void> {
    if (await options.authority.isActive(scope)) return;
    await Promise.all([...allSessions].filter((entry) => sameScope(entry.scope, scope))
      .map((entry) => entry.server.close()));
    throw new HttpFailure(401, "Unauthenticated launch");
  }

  async function handleMcp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const rawId = request.headers["mcp-session-id"];
    if (Array.isArray(rawId)) throw new HttpFailure(400, "Invalid session ID");
    const initializing = !rawId && request.method === "POST";
    let initializationReserved = false;
    let transportReserved = false;
    if (initializing) {
      if (pendingInitializations >= options.limits.maxPendingInitializations) {
        throw new HttpFailure(429, "Session capacity exceeded");
      }
      pendingInitializations++;
      initializationReserved = true;
    }
    let session: SharedMcpSession | undefined;
    let admitted: JSONRPCRequest[] = [];
    try {
      // Only the trusted authority may identify revocation. A caller-selected
      // session header plus an invalid credential must never cancel valid work.
      const bound = rawId ? sessions.get(rawId) : undefined;
      if (bound) await assertActive(bound.scope);
      const scope = await authenticate(request);
      if (initializing) {
        // Reclaim abandoned transports using only the trusted authority. A bad
        // credential or caller-chosen session ID never declares another dead.
        for (const existing of [...sessions.values()]) {
          if (!await options.authority.isActive(existing.scope)) await existing.server.close();
        }
        if (sessions.size + reservedInitializations >= options.limits.maxTransportSessions) {
          throw new HttpFailure(429, "Session capacity exceeded");
        }
        reservedInitializations++; transportReserved = true;
      }
      session = rawId ? sessions.get(rawId) : undefined;
      if (rawId && !session) throw new HttpFailure(404, "Unknown transport session");
      if (session && !sameScope(session.scope, scope)) throw new HttpFailure(403, "Launch does not own transport");
      const parsed = request.method === "POST" ? await body(request, options.limits.maxBodyBytes) : undefined;
      // Uploading a body can yield after authentication. Revalidate the trusted
      // launch immediately before creating protocol state or admitting work.
      await assertActive(scope);
      if (state !== "ready") throw new HttpFailure(503, "Service is draining");
      if (!session) {
        if (!initializing || !isInitializeRequest(parsed)) throw new HttpFailure(400, "Initialization required");
        session = await createSharedMcpSession({ runtime: options.runtime, scope,
          initialized: (created, id) => {
            sessions.set(id, created);
            // Transfer the reservation to an admitted session without counting
            // both during concurrent initializations.
            if (initializationReserved) { pendingInitializations--; initializationReserved = false; }
            if (transportReserved) { reservedInitializations--; transportReserved = false; }
          },
          closed: (closed) => {
            if (closed.transport.sessionId) sessions.delete(closed.transport.sessionId);
            if (closed.requests.size === 0) allSessions.delete(closed);
          },
        });
        // SDK connection setup yields. Shutdown may already have drained the
        // sessions known before this connection existed.
        if (state !== "ready") {
          await session.server.close();
          throw new HttpFailure(503, "Service is draining");
        }
        allSessions.add(session);
      }
      admitted = admit(session, parsed);
      await session.transport.handleRequest(request, response, parsed);
    } finally {
      if (initializationReserved) pendingInitializations--;
      if (transportReserved) reservedInitializations--;
      if (session && response.statusCode >= 400) for (const request of admitted) {
        // Transport shutdown may settle HTTP with 503 while a cancelled job is
        // still draining. Its runtime callback owns the remaining capacity.
        if (!session.requests.get(request.id)?.running) session.requests.delete(request.id);
      }
      if (initializing && session && (!session.transport.sessionId || response.statusCode >= 400)) await session.server.close();
    }
  }

  async function handleHook(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const authority = options.hookAuthority;
    if (!authority) throw new HttpFailure(404, "Not found");
    if (request.method !== "POST") throw new HttpFailure(405, "Method not allowed");
    const authenticateHook = async () => {
      try { await authority.authenticateHook(request); }
      catch { throw new HttpFailure(401, "Unauthenticated hook", "unauthorized"); }
    };
    await authenticateHook();
    const contentType = request.headers["content-type"];
    if (typeof contentType !== "string" || !/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(contentType)) {
      throw new HttpFailure(415, "JSON content type required");
    }
    let payload: unknown;
    try { payload = await body(request, options.limits.maxBodyBytes); }
    catch (error) {
      if (error instanceof HttpFailure) throw new HttpFailure(error.status, error.message, error.status === 413 ? "capacity" : "invalid");
      throw new HttpFailure(400, "Incomplete request", "invalid");
    }
    await authenticateHook();
    if (state !== "ready") throw new HttpFailure(503, "Service is draining", "draining");
    if (payload && typeof payload === "object" && Object.hasOwn(payload, "memory")) {
      if (Array.isArray(payload) || Object.keys(payload).length !== 1) throw new MemoryHookFailure("invalid");
      if (!options.memoryHook) throw new MemoryHookFailure("unsupported");
      if (health().inFlightRequests >= options.limits.maxInFlightRequests) throw new MemoryHookFailure("capacity");
      const input = (payload as { memory: unknown }).memory;
      // Reserve before starting work. A dropped HTTP socket cannot cancel a
      // committed SQLite delivery or release this operation's drain obligation.
      const pending = Promise.resolve().then(() => {
        if (state !== "ready") throw new MemoryHookFailure("draining");
        return options.memoryHook!(request, input);
      });
      memoryOperations.add(pending);
      try { reply(response, 202, { memory: await pending }); }
      finally { memoryOperations.delete(pending); }
      return;
    }
    try { await authority.registerHook(request, payload); }
    catch {
      // Separate an expired/revoked capability from invalid native identity.
      // Never expose the authority's payload-bearing errors to HTTP callers.
      await authenticateHook();
      throw new HttpFailure(400, "Invalid hook registration");
    }
    reply(response, 202, { registered: true });
  }

  async function dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    checkBoundary(request);
    if (request.url === "/health" && request.method === "GET") return reply(response, state === "ready" ? 200 : 503, health());
    if (state !== "ready") throw new HttpFailure(503, "Service is draining", request.url === "/hooks" ? "draining" : undefined);
    if (request.url !== "/mcp" && request.url !== "/hooks") throw new HttpFailure(404, "Not found");
    // Include control-plane headroom so cancellation can arrive when tool slots
    // are full. Reserve before awaiting authority or reading any request body.
    const maximum = options.limits.maxInFlightRequests + options.limits.maxPendingInitializations +
      options.limits.maxTransportSessions + 2;
    if (httpRequests >= maximum) throw new HttpFailure(429, "HTTP capacity exceeded", request.url === "/hooks" ? "capacity" : undefined);
    httpRequests++;
    try {
      if (request.url === "/hooks") await handleHook(request, response);
      else await handleMcp(request, response);
    }
    finally { httpRequests--; }
  }

  return {
    health,
    address() {
      const address = listener.address();
      if (!address || typeof address === "string") throw new Error("HTTP listener is not running");
      return address;
    },
    async listen() {
      if (state !== "starting" || listener.listening) throw new Error("HTTP listener already started");
      await new Promise<void>((resolve, reject) => {
        const failure = (error: Error) => reject(error);
        listener.once("error", failure);
        listener.listen(options.port, options.host, () => { listener.off("error", failure); resolve(); });
      });
      // close() may finish while the OS bind is still pending. A late bind
      // belongs to that closed startup attempt and must not restore readiness.
      if (state !== "starting") {
        await new Promise<void>((resolve, reject) => {
          listener.close((error) => error ? reject(error) : resolve());
          listener.closeAllConnections();
        });
        throw new Error("HTTP listener closed during startup");
      }
      state = "ready";
    },
    close() {
      closePromise ??= (async () => {
        state = "draining";
        const errors: unknown[] = [];
        const closed = await Promise.allSettled([...allSessions].map((session) => session.server.close()));
        for (const result of closed) if (result.status === "rejected") errors.push(result.reason);
        // Hook promises may still be settling after their client disconnected.
        // Their runtime owns committed writes until this obligation is complete.
        await Promise.allSettled([...memoryOperations]);
        try { await options.runtime.close(); }
        catch (error) { errors.push(error); }
        try {
          if (listener.listening) await new Promise<void>((resolve, reject) => {
            listener.close((error) => error ? reject(error) : resolve());
            listener.closeAllConnections();
          });
        } catch (error) { errors.push(error); }
        finally { state = "closed"; }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, "HTTP service cleanup failed");
      })();
      return closePromise;
    },
  };
}
