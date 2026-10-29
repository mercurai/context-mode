import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createSharedService, type SharedService } from "../../src/shared/service.js";
import { createSharedLaunchAuthority, type SharedLaunchAuthority, type SharedLaunchGrant, type SharedLaunchMetadata } from "../../src/shared/launch-authority.js";
import { SharedIdentityRegistry, type AuthenticatedScope } from "../../src/shared/identity.js";
import { getSharedToolContext } from "../../src/shared/runtime-context.js";
import type { SharedRuntime } from "../../src/shared/runtime.js";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function hookRequest(capability: string) {
  const request = new IncomingMessage(new Socket());
  request.headers.authorization = `Bearer ${capability}`; request.rawHeaders = ["Authorization", `Bearer ${capability}`];
  return request;
}
const text = (result: { content: Array<{ text?: string }>; isError?: boolean }) => {
  expect(result.isError).not.toBe(true); return result.content.map((part) => part.text ?? "").join("\n");
};

describe("shared capacity follows live launches and drained owners", () => {
  let root: string;
  let clock: number;
  let metadata: SharedLaunchMetadata;
  let service: SharedService | undefined;
  let runtime: SharedRuntime | undefined;
  let authority: SharedLaunchAuthority | undefined;
  let clients: Client[];
  let activity: ((scope: Readonly<AuthenticatedScope>) => boolean) | undefined;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "shared-capacity-"))); clock = 0; clients = []; activity = undefined;
    metadata = { provider: "codex", home: join(root, "config"), userHome: root, workspace: join(root, "project-a") };
    for (const path of [metadata.home, metadata.workspace, join(root, "project-b"), join(root, "fallback", "tmp")]) mkdirSync(path, { recursive: true });
    for (const [key, value] of Object.entries({ HOME: join(root, "fallback"), USERPROFILE: join(root, "fallback"),
      CODEX_HOME: join(root, "fallback"), CLAUDE_CONFIG_DIR: join(root, "fallback"), CONTEXT_MODE_DIR: join(root, "fallback", "store"),
      CLAUDE_PROJECT_DIR: join(root, "fallback"), CONTEXT_MODE_PROJECT_DIR: join(root, "fallback"),
      TMPDIR: join(root, "fallback", "tmp"), TEMP: join(root, "fallback", "tmp"), TMP: join(root, "fallback", "tmp"),
    })) vi.stubEnv(key, value);
    vi.stubEnv("CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS", undefined);
  });
  afterEach(async () => {
    try {
      await Promise.allSettled(clients.map((client) => client.close()));
      await service?.close(); await runtime?.close(); authority?.close();
    } finally { service = undefined; runtime = undefined; authority = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
  });
  async function start(bounds: { maxTransportSessions?: number; maxSessions?: number; maxProjects?: number } = {}) {
    service = await createSharedService({ now: () => new Date(clock), ttlMs: 1000, maxIdentities: 100,
      maxLaunches: 8, maxProjects: bounds.maxProjects ?? 4, maxSessions: bounds.maxSessions ?? 8, mcpServerName: "context-mode",
      http: { host: "127.0.0.1", port: 0, allowedOrigins: [], limits: { maxTransportSessions: bounds.maxTransportSessions ?? 8,
        maxPendingInitializations: 4, maxInFlightRequests: 8, maxBodyBytes: 2048 } } });
    await service.listen();
  }
  const url = (path: string) => new URL(`http://127.0.0.1:${service!.address().port}${path}`);
  async function connect(grant: SharedLaunchGrant) {
    const client = new Client({ name: "capacity-lifecycle", version: "1" }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(url("/mcp"), {
      requestInit: { headers: { authorization: `Bearer ${grant.mcpCapability}` } },
    }));
    return client;
  }
  async function register(grant: SharedLaunchGrant, session: string, workspace = metadata.workspace) {
    const response = await fetch(url("/hooks"), { method: "POST", headers: { authorization: `Bearer ${grant.hookCapability}`,
      "content-type": "application/json" }, body: JSON.stringify({ hook_event_name: "SessionStart", session_id: session, cwd: workspace }) });
    expect(response.status).toBe(202);
  }
  async function call(client: Client, session: string, name = "ctx_stats", args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args, _meta: { threadId: session, sessionId: session } });
    expect(result.isError).not.toBe(true); return JSON.stringify(result.content);
  }

  test.each(["revoke", "expire"])("new initialization sweeps abandoned %s transport without old-client DELETE", async (mode) => {
    await start({ maxTransportSessions: 1 });
    const a = service!.issue(metadata); const abandoned = await connect(a);
    await abandoned.listTools();
    // Closing the SDK client drops network streams without sending DELETE.
    // No background GET from A can accidentally trigger the old-ID sweep.
    await abandoned.close();
    expect(service!.health().transportSessions).toBe(1);
    if (mode === "revoke") service!.revoke(a.scope); else clock = 1000;
    const b = service!.issue(metadata); const client = await connect(b);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("ctx_stats");
    expect(service!.health().transportSessions).toBe(1);
  });

  test.each(["session", "project"])("inactive %s capacity is reclaimed and durable indexed memory survives", async (dimension) => {
    await start(dimension === "session" ? { maxSessions: 1 } : { maxProjects: 1 });
    const a = service!.issue(metadata); await register(a, "owner-a"); const ca = await connect(a);
    await call(ca, "owner-a", "ctx_index", { content: "Orchard durablealpha.", source: "notes" });
    service!.revoke(a.scope);
    const second = dimension === "project" ? { ...metadata, workspace: join(root, "project-b") } : metadata;
    const b = service!.issue(second); await register(b, "owner-b", second.workspace); const cb = await connect(b);
    expect(await call(cb, "owner-b")).toMatch(/context.mode/i);
    service!.revoke(b.scope);
    const resumed = service!.issue(metadata); await register(resumed, "owner-a"); const cc = await connect(resumed);
    expect(await call(cc, "owner-a", "ctx_search", { queries: ["orchard"] })).toContain("durablealpha");
  });

  async function direct() {
    const registry = new SharedIdentityRegistry({ now: () => new Date(clock), ttlMs: 1000, maxEntries: 100 });
    authority = createSharedLaunchAuthority({ identityRegistry: registry, now: () => new Date(clock), ttlMs: 1000,
      maxLaunches: 8, mcpServerName: "context-mode", toolNames: ["ctx_stats", "ctx_index", "ctx_search"] });
    const { createSharedRuntime } = await import("../../src/shared/runtime.js");
    const options = { identityRegistry: registry, maxProjects: 1, maxSessions: 1, now: () => clock,
      resolveUserHome: (scope: Readonly<AuthenticatedScope>) => authority!.metadata(scope).userHome,
      isActive: (scope: Readonly<AuthenticatedScope>) => activity ? activity(scope) : authority!.isActive(scope) };
    runtime = await createSharedRuntime(options);
  }
  function grant(session: string, workspace = metadata.workspace) {
    const issued = authority!.issue({ ...metadata, workspace });
    authority!.registerHook(hookRequest(issued.hookCapability), { hook_event_name: "SessionStart", session_id: session, cwd: workspace });
    return issued;
  }
  const invoke = (grant: SharedLaunchGrant, session: string, name = "ctx_stats", args: Record<string, unknown> = {}) =>
    runtime!.call(grant.scope, { name, arguments: args, _meta: { threadId: session, sessionId: session } });

  test("active launch B preserves the durable owner first opened by revoked launch A", async () => {
    await direct();
    const a = grant("shared-owner"); const b = grant("shared-owner"); const c = grant("other-owner");
    text(await invoke(a, "shared-owner", "ctx_index", { content: "Orchard sharedalpha.", source: "notes" }));
    text(await invoke(b, "shared-owner"));
    authority!.revoke(a.scope);
    await expect(invoke(c, "other-owner")).rejects.toThrow(/session capacity/i);
    expect(text(await invoke(b, "shared-owner", "ctx_search", { queries: ["orchard"] }))).toContain("sharedalpha");
    authority!.revoke(b.scope);
    expect(text(await invoke(c, "other-owner"))).toMatch(/context.mode/i);
  });

  test("revoked in-flight owner retains storage capacity until its actual handler finishes", async () => {
    await direct();
    const a = grant("owner-a"); const b = grant("owner-b", join(root, "project-b"));
    const { REGISTERED_CTX_TOOLS } = await import("../../src/server.js");
    const descriptor = REGISTERED_CTX_TOOLS.find((tool) => tool.name === "ctx_stats")!;
    const original = descriptor.handler; const entered = deferred<void>(); const release = deferred<void>();
    let closeStore: ReturnType<typeof vi.spyOn> | undefined;
    descriptor.handler = async (args, extra) => {
      const context = getSharedToolContext()!;
      if (context.identity.launchId === a.scope.launchId) {
        closeStore = vi.spyOn(context.store, "close"); entered.resolve(); await release.promise;
      }
      return original(args, extra);
    };
    const pending = invoke(a, "owner-a");
    try {
      await entered.promise; authority!.revoke(a.scope);
      await expect(invoke(b, "owner-b")).rejects.toThrow(/capacity/i);
      expect(closeStore).not.toHaveBeenCalled();
      release.resolve(); text(await pending);
      expect(text(await invoke(b, "owner-b"))).toMatch(/context.mode/i);
      expect(closeStore).toHaveBeenCalledTimes(1);
    } finally { release.resolve(); descriptor.handler = original; await pending.catch(() => undefined); }
  });

  test("expiry inside the admission sweep never dispatches through a closed cached owner", async () => {
    await direct();
    const a = grant("owner-a");
    const { REGISTERED_CTX_TOOLS } = await import("../../src/server.js");
    const descriptor = REGISTERED_CTX_TOOLS.find((tool) => tool.name === "ctx_stats")!;
    const original = descriptor.handler;
    let store: NonNullable<ReturnType<typeof getSharedToolContext>>["store"] | undefined;
    let closedStore = false;
    const closedAtDispatch: boolean[] = [];
    descriptor.handler = (args, extra) => {
      const context = getSharedToolContext()!;
      if (context.identity.launchId === a.scope.launchId) {
        if (!store) store = context.store;
        else closedAtDispatch.push(context.store === store && closedStore);
      }
      return original(args, extra);
    };
    try {
      text(await invoke(a, "owner-a"));
      const close = store!.close.bind(store);
      vi.spyOn(store!, "close").mockImplementation(() => { closedStore = true; close(); });
      let checks = 0;
      activity = (scope) => {
        if (scope.launchId === a.scope.launchId && ++checks === 2) clock = 1000;
        return authority!.isActive(scope);
      };
      // A request admitted just before expiry may finish or reject; in either
      // case its handler must never receive storage closed by its own sweep.
      await invoke(a, "owner-a").catch(() => undefined);
      expect(checks).toBeGreaterThanOrEqual(2);
      expect(closedAtDispatch).not.toContain(true);
      const b = grant("owner-b", join(root, "project-b"));
      expect(text(await invoke(b, "owner-b"))).toMatch(/context.mode/i);
      expect(closedStore).toBe(true);
      expect(() => authority!.metadata(a.scope)).toThrow();
    } finally { descriptor.handler = original; }
  });
});
