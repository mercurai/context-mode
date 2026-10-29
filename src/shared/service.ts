import { SharedIdentityRegistry, type AuthenticatedScope } from "./identity.js";
import { createSharedHttpService, type SharedHttpOptions, type SharedHttpService } from "./http.js";
import { createSharedLaunchAuthority, type SharedLaunchAuthority, type SharedLaunchGrant, type SharedLaunchMetadata } from "./launch-authority.js";
import type { SharedMemoryRuntime, SharedRuntime } from "./runtime.js";
import { createMemoryHookProcessor } from "./memory-hooks.js";

export interface SharedServiceOptions {
  now: () => Date;
  ttlMs: number;
  maxIdentities: number;
  maxLaunches: number;
  maxProjects: number;
  maxSessions: number;
  /** Native MCP configuration key used in qualified hook tool names. */
  mcpServerName: string;
  http: Pick<SharedHttpOptions, "host" | "port" | "allowedOrigins" | "limits">;
}

export interface SharedService extends SharedHttpService {
  /** Trusted in-process launcher only. No public HTTP or MCP issuance method. */
  issue(metadata: SharedLaunchMetadata): SharedLaunchGrant;
  /** Trusted in-process control only; ordinary HTTP and hook traffic cannot renew. */
  renew(scope: Readonly<AuthenticatedScope>): void;
  revoke(scope: Readonly<AuthenticatedScope>): void;
}

function validate(options: SharedServiceOptions): void {
  if (!options || typeof options.now !== "function") throw new Error("Invalid shared service clock");
  for (const key of ["ttlMs", "maxIdentities", "maxLaunches", "maxProjects", "maxSessions"] as const) {
    if (!Number.isSafeInteger(options[key]) || options[key] <= 0) throw new Error("Invalid shared service capacity");
  }
  if (typeof options.mcpServerName !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(options.mcpServerName)) {
    throw new Error("Invalid shared service MCP name");
  }
  const http = options.http;
  if (!http || !["127.0.0.1", "::1"].includes(http.host) || !Number.isInteger(http.port) ||
      http.port < 0 || http.port > 65535 || !Array.isArray(http.allowedOrigins) ||
      http.allowedOrigins.some((origin) => typeof origin !== "string" || !origin)) {
    throw new Error("Invalid shared service listener");
  }
  for (const key of ["maxTransportSessions", "maxPendingInitializations", "maxInFlightRequests", "maxBodyBytes"] as const) {
    if (!Number.isSafeInteger(http.limits?.[key]) || http.limits[key] <= 0) throw new Error("Invalid shared service HTTP capacity");
  }
}

/** Stop credential admission first; always attempt all resource owners' cleanup. */
async function closeComponents(authority?: SharedLaunchAuthority, http?: SharedHttpService, runtime?: SharedRuntime): Promise<void> {
  const errors = new Set<unknown>();
  try { authority?.close(); } catch (error) { errors.add(error); }
  try { await http?.close(); } catch (error) { errors.add(error); }
  // HTTP normally closes its runtime. Calling the idempotent owner directly also
  // handles partial construction or an HTTP cleanup failure before that point.
  try { await runtime?.close(); } catch (error) { errors.add(error); }
  if (errors.size === 1) throw [...errors][0];
  if (errors.size > 1) throw new AggregateError([...errors], "Shared service cleanup failed");
}

/** Creates components without opening a listener; callers explicitly await listen(). */
export async function createSharedService(options: SharedServiceOptions): Promise<SharedService> {
  validate(options);
  // Snapshot caller-owned options before the asynchronous runtime import/setup.
  const { now, ttlMs, maxIdentities, maxLaunches, maxProjects, maxSessions, mcpServerName } = options;
  const listenerOptions = { host: options.http.host, port: options.http.port,
    allowedOrigins: [...options.http.allowedOrigins], limits: { ...options.http.limits } };
  const identityRegistry = new SharedIdentityRegistry({ now, ttlMs, maxEntries: maxIdentities });
  let runtime: SharedMemoryRuntime | undefined;
  let authority: SharedLaunchAuthority | undefined;
  let http: SharedHttpService | undefined;
  try {
    const { createSharedRuntime } = await import("./runtime.js");
    runtime = await createSharedRuntime({ identityRegistry, maxProjects, maxSessions,
      now: () => now().getTime(),
      isActive: (scope) => authority?.isActive(scope) ?? false,
      resolveUserHome: (scope) => {
        if (!authority) throw new Error("Shared launch authority is unavailable");
        return authority.metadata(scope).userHome;
      },
    });
    authority = createSharedLaunchAuthority({ identityRegistry, now, ttlMs, maxLaunches, mcpServerName,
      toolNames: runtime.listTools().map((tool) => tool.name) });
    http = createSharedHttpService({ ...listenerOptions, runtime, authority, hookAuthority: authority,
      memoryHook: createMemoryHookProcessor(authority, runtime) });
  } catch (error) {
    try { await closeComponents(authority, http, runtime); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Shared service construction failed"); }
    throw error;
  }
  const launchAuthority = authority;
  const transport = http;
  const sharedRuntime = runtime;
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    issue: (metadata: SharedLaunchMetadata) => launchAuthority.issue(metadata),
    renew: (scope: Readonly<AuthenticatedScope>) => launchAuthority.renew(scope),
    revoke: (scope: Readonly<AuthenticatedScope>) => launchAuthority.revoke(scope),
    listen: () => transport.listen(),
    address: () => transport.address(),
    health: () => transport.health(),
    close(): Promise<void> {
      closePromise ??= closeComponents(launchAuthority, transport, sharedRuntime);
      return closePromise;
    },
  });
}
