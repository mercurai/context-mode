import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { SharedLaunchGrant, SharedLaunchMetadata } from "../../src/shared/launch-authority.js";
import { createSharedService, type SharedService, type SharedServiceOptions } from "../../src/shared/service.js";

type Connection = { client: Client; grant: SharedLaunchGrant; provider: SharedLaunchMetadata["provider"]; session: string };
const text = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  (result.content as Array<{ text?: string }>).map((block) => block.text ?? "").join("\n");

describe("shared service composition with real authority, runtime and SDK transport", () => {
  let root: string;
  let clock: number;
  let services: SharedService[];
  let clients: Client[];
  let metadata: SharedLaunchMetadata;
  let toolSequence: number;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "ctx-shared-service-")));
    clock = 0;
    toolSequence = 0;
    services = [];
    clients = [];
    metadata = { provider: "codex", home: join(root, "config"), userHome: root, workspace: join(root, "project") };
    for (const path of [metadata.home, metadata.workspace, join(root, "other-project"), join(root, "fallback", "tmp")]) mkdirSync(path, { recursive: true });
    for (const [name, value] of Object.entries({ HOME: join(root, "fallback"), USERPROFILE: join(root, "fallback"),
      CODEX_HOME: join(root, "fallback"), CLAUDE_CONFIG_DIR: join(root, "fallback"), CONTEXT_MODE_DIR: join(root, "fallback", "storage"),
      CLAUDE_PROJECT_DIR: join(root, "fallback"), CONTEXT_MODE_PROJECT_DIR: join(root, "fallback"),
      TMPDIR: join(root, "fallback", "tmp"), TEMP: join(root, "fallback", "tmp"), TMP: join(root, "fallback", "tmp"),
    })) vi.stubEnv(name, value);
    vi.stubEnv("CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS", undefined);
  });

  afterEach(async () => {
    try {
      await Promise.allSettled(clients.map((client) => client.close()));
      await Promise.allSettled(services.map((service) => service.close()));
    } finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
  });

  function options(): SharedServiceOptions {
    return { now: () => new Date(clock), ttlMs: 60_000, maxIdentities: 100, maxLaunches: 8,
      maxProjects: 4, maxSessions: 8, mcpServerName: "context-mode",
      http: { host: "127.0.0.1", port: 0, allowedOrigins: [], limits: {
        maxTransportSessions: 8, maxPendingInitializations: 4, maxInFlightRequests: 8, maxBodyBytes: 16_384,
      } } };
  }
  async function create(overrides: Partial<SharedServiceOptions> = {}, listen = true) {
    const service = await createSharedService({ ...options(), ...overrides });
    services.push(service);
    if (listen) await service.listen();
    return service;
  }
  const url = (service: SharedService, path = "/mcp") => new URL(`http://127.0.0.1:${service.address().port}${path}`);
  async function hook(service: SharedService, grant: SharedLaunchGrant, payload: Record<string, unknown>, capability = grant.hookCapability) {
    const response = await fetch(url(service, "/hooks"), { method: "POST", headers: {
      authorization: `Bearer ${capability}`, "content-type": "application/json",
    }, body: JSON.stringify(payload) });
    const receipt: unknown = await response.json();
    if (response.ok) expect(receipt).toEqual({ registered: true });
    return response.status;
  }
  const start = (service: SharedService, grant: SharedLaunchGrant, session = "root", workspace = metadata.workspace) =>
    hook(service, grant, { hook_event_name: "SessionStart", session_id: session, cwd: workspace });
  async function connect(service: SharedService, grant: SharedLaunchGrant, provider = metadata.provider, session = "root") {
    const client = new Client({ name: "shared-composition-test", version: "1" });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(url(service), {
      requestInit: { headers: { authorization: `Bearer ${grant.mcpCapability}` } },
    }));
    return { client, grant, provider, session };
  }
  async function invoke(service: SharedService, connection: Connection, name: string, args: Record<string, unknown> = {}) {
    const id = `tool-${++toolSequence}`;
    if (connection.provider === "claude-code") {
      expect(await hook(service, connection.grant, { hook_event_name: "PreToolUse", session_id: connection.session,
        cwd: metadata.workspace, tool_use_id: id, tool_name: `mcp__context-mode__${name}` })).toBe(202);
    }
    return connection.client.callTool({ name, arguments: args, _meta: connection.provider === "codex"
      ? { threadId: connection.session, sessionId: connection.session } : { "claudecode/toolUseId": id } });
  }

  test("factory leaves listener stopped until explicit listen and close is idempotent", async () => {
    const service = await create({}, false);
    expect(service.health().state).toBe("starting");
    expect(() => service.address()).toThrow();
    await service.listen();
    expect(service.health().state).toBe("ready");
    const pending = service.close();
    expect(service.close()).toBe(pending);
    expect(() => service.issue(metadata)).toThrow();
    await pending;
    expect(service.health().state).toBe("closed");
  });

  test("real SDK tools require separate native registration before accessing storage", async () => {
    const service = await create();
    const grant = service.issue(metadata);
    const connection = await connect(service, grant);
    const names = (await connection.client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("ctx_index");
    expect(names).toContain("ctx_search");
    expect((await invoke(service, connection, "ctx_index", { content: "Orchard unregisteredcontent.", source: "notes" })).isError).toBe(true);
    expect(await start(service, grant)).toBe(202);
    expect(text(await invoke(service, connection, "ctx_index", { content: "Orchard compositionapples.", source: "notes" }))).toContain("Indexed");
    const found = text(await invoke(service, connection, "ctx_search", { queries: ["orchard"] }));
    expect(found).toContain("compositionapples");
    expect(found).not.toContain("unregisteredcontent");
  });

  test("Claude exact qualified tools register against actual runtime descriptors", async () => {
    const service = await create();
    const grant = service.issue({ ...metadata, provider: "claude-code" });
    const connection = await connect(service, grant, "claude-code");
    expect(text(await invoke(service, connection, "ctx_index", { content: "Orchard claudecompositionpears.", source: "notes" }))).toContain("Indexed");
    expect(text(await invoke(service, connection, "ctx_search", { queries: ["orchard"] }))).toContain("claudecompositionpears");
    expect(await hook(service, grant, { hook_event_name: "PreToolUse", session_id: "root", cwd: metadata.workspace,
      tool_use_id: "unknown", tool_name: "mcp__context-mode__unregistered_tool" })).toBe(400);
  });

  test("authority user home drives runtime tilde policies instead of service environment", async () => {
    const service = await create();
    const grant = service.issue({ ...metadata, provider: "claude-code" });
    const connection = await connect(service, grant, "claude-code");
    writeFileSync(join(metadata.workspace, "notes.md"), "Orchard compositionprivatefruit.");
    expect(text(await invoke(service, connection, "ctx_index", { path: "notes.md", source: "notes" }))).toContain("Indexed");
    writeFileSync(join(metadata.home, "settings.json"), JSON.stringify({ permissions: { deny: ["Read(~/project/notes.md)"] } }));
    expect((await invoke(service, connection, "ctx_index", { path: "notes.md", source: "denied" })).isError).toBe(true);
    expect(text(await invoke(service, connection, "ctx_search", { queries: ["orchard"] }))).not.toContain("compositionprivatefruit");
  });

  test("hook and MCP credentials cannot cross purposes and no issuance HTTP route exists", async () => {
    const service = await create();
    const grant = service.issue(metadata);
    expect(await hook(service, grant, { hook_event_name: "SessionStart", session_id: "root", cwd: metadata.workspace }, grant.mcpCapability)).toBe(401);
    await expect(connect(service, { ...grant, mcpCapability: grant.hookCapability })).rejects.toThrow();
    for (const path of ["/issue", "/launch", "/control/issue"]) {
      const response = await fetch(url(service, path), { method: "POST", headers: { authorization: `Bearer ${grant.mcpCapability}` } });
      await response.text();
      expect(response.status).toBe(404);
    }
  });

  test("private revocation invalidates existing HTTP sessions and hook registration", async () => {
    const service = await create();
    const grant = service.issue(metadata);
    expect(await start(service, grant)).toBe(202);
    const connection = await connect(service, grant);
    service.revoke(grant.scope);
    await expect(invoke(service, connection, "ctx_stats")).rejects.toThrow();
    expect(await start(service, grant)).toBe(401);
  });

  test("shared TTL closes admission without renewing via duplicate native registration", async () => {
    const service = await create();
    const grant = service.issue(metadata);
    expect(await start(service, grant)).toBe(202);
    clock = 59_999;
    expect(await start(service, grant)).toBe(202);
    clock = 60_000;
    expect(await start(service, grant)).toBe(401);
    await expect(connect(service, grant)).rejects.toThrow();
  });

  test("HTTP and authority use explicit bounds without silently widening them", async () => {
    const base = options();
    const service = await create({ maxLaunches: 1, http: { ...base.http, limits: { ...base.http.limits, maxBodyBytes: 256 } } });
    const grant = service.issue(metadata);
    expect(() => service.issue(metadata)).toThrow();
    expect(await hook(service, grant, { hook_event_name: "SessionStart", session_id: "root", cwd: metadata.workspace, omitted: "x".repeat(512) })).toBe(413);
    expect(await start(service, grant)).toBe(202);
  });

  test("shutdown still closes listener/runtime if authority registry cleanup fails", async () => {
    const service = await create();
    const grant = service.issue(metadata);
    expect(await start(service, grant)).toBe(202);
    const connection = await connect(service, grant);
    expect(text(await invoke(service, connection, "ctx_index", { content: "Orchard shutdownplums.", source: "notes" }))).toContain("Indexed");
    const healthUrl = url(service, "/health");
    clock = Number.NaN; // Real registry rejects revocation clock; no mock cleanup error.
    const closing = service.close();
    expect(() => service.issue(metadata)).toThrow();
    await expect(closing).rejects.toThrow();
    expect(service.health().state).toBe("closed");
    await expect(fetch(healthUrl)).rejects.toThrow();
    expect(service.close()).toBe(closing);
  });

  test("new service epoch rejects old grants and restores persistent logical owner only after registration", async () => {
    const first = await create();
    const old = first.issue(metadata);
    expect(await start(first, old)).toBe(202);
    const original = await connect(first, old);
    expect(text(await invoke(first, original, "ctx_index", { content: "Orchard restartcompositioncherries.", source: "notes" }))).toContain("Indexed");
    await original.client.close();
    await first.close();
    const second = await create();
    await expect(connect(second, old)).rejects.toThrow();
    expect(await start(second, old)).toBe(401);
    const fresh = second.issue(metadata);
    expect(fresh.scope.launchId !== old.scope.launchId).toBe(true);
    const resumed = await connect(second, fresh);
    expect((await invoke(second, resumed, "ctx_search", { queries: ["orchard"] })).isError).toBe(true);
    expect(await start(second, fresh)).toBe(202);
    expect(text(await invoke(second, resumed, "ctx_search", { queries: ["orchard"] }))).toContain("restartcompositioncherries");
    const other = second.issue(metadata);
    expect(await start(second, other, "other-session")).toBe(202);
    expect(text(await invoke(second, await connect(second, other, "codex", "other-session"), "ctx_search", { queries: ["orchard"] }))).not.toContain("restartcompositioncherries");
    const worktree = second.issue({ ...metadata, workspace: join(root, "other-project") });
    expect(await start(second, worktree, "root", join(root, "other-project"))).toBe(202);
    expect(text(await invoke(second, await connect(second, worktree), "ctx_search", { queries: ["orchard"] }))).not.toContain("restartcompositioncherries");
  });

  test.each(["maxIdentities", "maxLaunches", "maxProjects", "maxSessions", "ttlMs"] as const)("rejects invalid %s before exposing a service", async (key) => {
    await expect(createSharedService({ ...options(), [key]: 0 })).rejects.toThrow(/Invalid/);
  });
});
