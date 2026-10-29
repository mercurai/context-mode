import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SharedIdentityRegistry } from "../../src/shared/identity.js";
import { createSharedLaunchAuthority, type SharedLaunchAuthority, type SharedLaunchGrant,
  type SharedLaunchMetadata } from "../../src/shared/launch-authority.js";
import { createSharedHttpService, type SharedHttpHookAuthority, type SharedHttpService } from "../../src/shared/http.js";
import type { SharedRuntime } from "../../src/shared/runtime.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("native hooks over shared HTTP", () => {
  let root: string;
  let clock: number;
  let registry: SharedIdentityRegistry;
  let authority: SharedLaunchAuthority;
  let runtime: SharedRuntime | undefined;
  let service: SharedHttpService | undefined;
  let url: URL;
  let metadata: SharedLaunchMetadata[];
  let grants: SharedLaunchGrant[];
  let clients: Client[];
  let authenticatedHook: ((request: IncomingMessage) => void) | undefined;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "shared-http-hooks-")));
    clock = 0;
    clients = [];
    authenticatedHook = undefined;
    const fallback = join(root, "fallback");
    mkdirSync(join(fallback, "tmp"), { recursive: true });
    for (const [key, value] of Object.entries({ HOME: fallback, USERPROFILE: fallback,
      CODEX_HOME: fallback, CLAUDE_CONFIG_DIR: fallback, CONTEXT_MODE_DIR: join(fallback, "store"),
      CLAUDE_PROJECT_DIR: fallback, CONTEXT_MODE_PROJECT_DIR: fallback, CLAUDE_SESSION_ID: "unregistered",
      TMPDIR: join(fallback, "tmp"), TMP: join(fallback, "tmp"), TEMP: join(fallback, "tmp"),
    })) vi.stubEnv(key, value);
    vi.stubEnv("CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS", undefined);
    registry = new SharedIdentityRegistry({ now: () => new Date(clock), ttlMs: 1000, maxEntries: 100 });
    authority = createSharedLaunchAuthority({ identityRegistry: registry, now: () => new Date(clock),
      ttlMs: 1000, maxLaunches: 8, mcpServerName: "context-mode", toolNames: ["ctx_index", "ctx_search", "ctx_stats"] });
    metadata = (["codex", "claude-code"] as const).map((provider, index) => {
      const entry = { provider, home: join(root, `config-${index}`), userHome: join(root, `user-${index}`),
        workspace: join(root, `workspace-${index}`) };
      for (const path of [entry.home, entry.userHome, entry.workspace]) mkdirSync(path);
      return entry;
    });
    grants = metadata.map((entry) => authority.issue(entry));
    const { createSharedRuntime } = await import("../../src/shared/runtime.js");
    runtime = await createSharedRuntime({ identityRegistry: registry, maxProjects: 4, maxSessions: 8,
      now: () => clock, resolveUserHome: (scope) => authority.metadata(scope).userHome });
    // The launch-authority owner provides this public purpose-specific seam.
    const hookAuthority: SharedHttpHookAuthority = {
      authenticateHook(request) {
        const scope = authority.authenticateHook(request);
        authenticatedHook?.(request);
        return scope;
      },
      registerHook: (request, payload) => authority.registerHook(request, payload),
    };
    service = createSharedHttpService({ runtime, authority, hookAuthority, host: "127.0.0.1", port: 0,
      allowedOrigins: [], limits: { maxTransportSessions: 8, maxPendingInitializations: 4,
        maxInFlightRequests: 8, maxBodyBytes: 2048 } });
    await service.listen();
    url = new URL(`http://127.0.0.1:${service.address().port}/hooks`);
  });

  afterEach(async () => {
    try {
      await Promise.allSettled(clients.map((client) => client.close()));
      await service?.close();
      await runtime?.close();
      authority?.close();
    } finally {
      service = undefined;
      runtime = undefined;
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  function native(index: number, extra: Record<string, unknown> = {}) {
    return { hook_event_name: index === 0 ? "SessionStart" : "PreToolUse", session_id: `session-${index}`,
      cwd: metadata[index].workspace, ...(index === 1 ? { tool_use_id: "call-1", tool_name: "mcp__context-mode__ctx_index" } : {}), ...extra };
  }

  async function post(index: number, payload: unknown, options: {
    capability?: string; method?: string; path?: string; headers?: Record<string, string>; raw?: string;
  } = {}) {
    const response = await fetch(new URL(options.path ?? "/hooks", url), { method: options.method ?? "POST",
      headers: { authorization: `Bearer ${options.capability ?? grants[index].hookCapability}`,
        "content-type": "application/json", ...options.headers },
      ...((options.method ?? "POST") === "GET" ? {} : { body: options.raw ?? JSON.stringify(payload) }) });
    const body = await response.text();
    expect(body.includes(grants[index].hookCapability)).toBe(false);
    expect(body.includes(grants[index].mcpCapability)).toBe(false);
    return { status: response.status, body };
  }

  async function connect(index: number, capability = grants[index].mcpCapability) {
    const client = new Client({ name: "hook-route-test", version: "1" });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", url), {
      requestInit: { headers: { authorization: `Bearer ${capability}` } },
    }));
    return client;
  }

  async function call(client: Client, name: string, meta: Record<string, unknown>, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args, _meta: meta });
    expect(result.isError).not.toBe(true);
    return JSON.stringify(result.content);
  }

  test("concurrent Claude and Codex hooks register isolated real runtime calls", async () => {
    const receipts = await Promise.all([post(0, native(0)), post(1, native(1))]);
    expect(receipts.map((receipt) => receipt.status)).toEqual([202, 202]);
    for (const receipt of receipts) expect(JSON.parse(receipt.body)).toEqual({ registered: true });
    const [codex, claude] = await Promise.all([connect(0), connect(1)]);
    await Promise.all([
      call(codex, "ctx_index", { threadId: "session-0", sessionId: "session-0" }, { source: "notes", content: "Orchard alphaapples." }),
      call(claude, "ctx_index", { "claudecode/toolUseId": "call-1" }, { source: "notes", content: "Orchard betapears." }),
    ]);
    expect((await post(1, native(1, { tool_use_id: "search-1", tool_name: "mcp__context-mode__ctx_search" }))).status).toBe(202);
    const a = await call(codex, "ctx_search", { threadId: "session-0", sessionId: "session-0" }, { queries: ["orchard"] });
    const b = await call(claude, "ctx_search", { "claudecode/toolUseId": "search-1" }, { queries: ["orchard"] });
    expect(a).toContain("alphaapples"); expect(a).not.toContain("betapears");
    expect(b).toContain("betapears"); expect(b).not.toContain("alphaapples");
  });

  test("Codex child registration requires root lineage and isolates child memory", async () => {
    const child = native(0, { hook_event_name: "SubagentStart", agent_id: "child" });
    expect((await post(0, child)).status).toBe(400);
    expect((await post(0, native(0))).status).toBe(202);
    expect((await post(0, child)).status).toBe(202);
    const client = await connect(0);
    await call(client, "ctx_index", { threadId: "session-0", sessionId: "session-0" }, { source: "root", content: "Orchard rootapples." });
    await call(client, "ctx_index", { threadId: "child", sessionId: "session-0" }, { source: "child", content: "Orchard childbananas." });
    const childResult = await call(client, "ctx_search", { threadId: "child", sessionId: "session-0" }, { queries: ["orchard"] });
    const parent = await call(client, "ctx_search", { threadId: "session-0", sessionId: "session-0" }, { queries: ["orchard"] });
    expect(childResult).toContain("childbananas"); expect(childResult).not.toContain("rootapples");
    expect(parent).toContain("rootapples"); expect(parent).not.toContain("childbananas");
  });

  test("MCP and hook capabilities cannot cross endpoints", async () => {
    expect((await post(0, native(0), { capability: grants[0].mcpCapability })).status).toBe(401);
    await expect(connect(0, grants[0].hookCapability)).rejects.toThrow();
    expect(() => registry.resolve(grants[0].scope, { name: "ctx_index", _meta: { threadId: "session-0", sessionId: "session-0" } })).toThrow();
  });

  test.each(["workspace", "provider", "missing", "tool", "cross-launch"])("rejects %s native registration", async (kind) => {
    const payload = native(1);
    if (kind === "workspace") payload.cwd = metadata[0].workspace;
    if (kind === "provider") payload.hook_event_name = "SessionStart";
    if (kind === "missing") delete (payload as Record<string, unknown>).tool_use_id;
    if (kind === "tool") (payload as Record<string, unknown>).tool_name = "mcp__other__ctx_index";
    const response = await post(1, payload, kind === "cross-launch" ? { capability: grants[0].hookCapability } : {});
    expect(response.status).toBe(400);
    expect(() => registry.resolve(grants[1].scope, { name: "ctx_index", _meta: { "claudecode/toolUseId": "call-1" } })).toThrow();
  });

  test.each(["expired", "revoked"])("rejects %s launch before registration", async (kind) => {
    if (kind === "expired") clock = 1000;
    else authority.revoke(grants[0].scope);
    expect((await post(0, native(0))).status).toBe(401);
    expect(() => registry.resolve(grants[0].scope, { name: "ctx_stats", _meta: { threadId: "session-0", sessionId: "session-0" } })).toThrow();
  });

  test.each([
    ["method", 405], ["path", 404], ["json", 400], ["array", 400], ["content-type", 415], ["oversize", 413], ["origin", 403],
  ] as const)("rejects %s at the HTTP boundary", async (kind, status) => {
    const response = await post(0, kind === "array" ? [] : native(0), {
      ...(kind === "method" ? { method: "GET" } : {}), ...(kind === "path" ? { path: "/launches" } : {}),
      ...(kind === "json" ? { raw: "{" } : {}), ...(kind === "oversize" ? { raw: "x".repeat(3000) } : {}),
      ...(kind === "content-type" ? { headers: { "content-type": "text/plain" } } : {}),
      ...(kind === "origin" ? { headers: { origin: "https://attacker.invalid" } } : {}),
    });
    expect(response.status).toBe(status);
    expect(() => registry.resolve(grants[0].scope, { name: "ctx_stats", _meta: { threadId: "session-0", sessionId: "session-0" } })).toThrow();
  });

  test("Host is checked on the hook route without echoing native payload", async () => {
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const outgoing = httpRequest(url, { method: "POST", headers: { host: "attacker.invalid",
        authorization: `Bearer ${grants[0].hookCapability}`, "content-type": "application/json" } }, (response) => {
        let body = ""; response.on("data", (chunk) => { body += chunk; });
        response.once("end", () => resolve({ status: response.statusCode!, body }));
      });
      outgoing.once("error", reject); outgoing.end(JSON.stringify(native(0, { prompt: "private-hook-content" })));
    });
    expect(result.status).toBe(403);
    expect(result.body).not.toContain("private-hook-content");
    expect(result.body.includes(grants[0].hookCapability)).toBe(false);
  });

  test.each(["revoked", "expired", "draining"])("%s during hook upload prevents registration", async (kind) => {
    const authenticated = deferred<void>();
    authenticatedHook = (request) => { if (request.headers["x-test-upload"] === "partial") authenticated.resolve(); };
    const payload = JSON.stringify(native(0));
    const received = deferred<number>();
    const outgoing = httpRequest(url, { method: "POST", headers: { authorization: `Bearer ${grants[0].hookCapability}`,
      "content-type": "application/json", "x-test-upload": "partial" } }, (response) => {
      response.resume(); response.once("end", () => received.resolve(response.statusCode!));
    });
    const failure = new Promise<never>((_, reject) => outgoing.once("error", reject));
    void failure.catch(() => undefined);
    try {
      outgoing.write(payload.slice(0, 1));
      // A stub/nonexistent route responds before authentication: fail promptly.
      expect(await Promise.race([authenticated.promise.then(() => "authenticated"), received.promise, failure])).toBe("authenticated");
      if (kind === "revoked") authority.revoke(grants[0].scope);
      if (kind === "expired") clock = 1000;
      if (kind === "draining") {
        await service!.close();
        expect(service!.health().state).toBe("closed");
        expect(() => registry.resolve(grants[0].scope, { name: "ctx_stats", _meta: { threadId: "session-0", sessionId: "session-0" } })).toThrow();
        return;
      }
      outgoing.end(payload.slice(1));
      expect(await Promise.race([received.promise, failure])).toBe(401);
      expect(() => registry.resolve(grants[0].scope, { name: "ctx_stats", _meta: { threadId: "session-0", sessionId: "session-0" } })).toThrow();
    } finally { outgoing.destroy(); }
  });

  test.each(["duplicate-auth", "missing-content-type", "chunked-oversize"])("rejects raw %s before registering identity", async (kind) => {
    const headers: Record<string, string | string[]> = { authorization: `Bearer ${grants[0].hookCapability}` };
    if (kind === "duplicate-auth") headers.authorization = [headers.authorization as string, headers.authorization as string];
    if (kind !== "missing-content-type") headers["content-type"] = "application/json";
    const outcome = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const outgoing = httpRequest(url, { method: "POST", headers }, (response) => {
        let body = ""; response.on("data", (chunk) => { body += chunk; });
        response.once("end", () => resolve({ status: response.statusCode!, body }));
      });
      outgoing.once("error", reject);
      if (kind === "chunked-oversize") { outgoing.write(" ".repeat(1024)); outgoing.write(" ".repeat(1024)); }
      outgoing.end(JSON.stringify(native(0)));
    });
    expect(outcome.status).toBe(kind === "duplicate-auth" ? 401 : kind === "missing-content-type" ? 415 : 413);
    expect(outcome.body.includes(grants[0].hookCapability)).toBe(false);
    expect(() => registry.resolve(grants[0].scope, { name: "ctx_stats", _meta: { threadId: "session-0", sessionId: "session-0" } })).toThrow();
  });
});
