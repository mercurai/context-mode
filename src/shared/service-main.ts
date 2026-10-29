import type { Readable, Writable } from "node:stream";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runServiceControl } from "./control.js";
import type { SharedServiceOptions } from "./service.js";

type BootstrapOptions = Omit<SharedServiceOptions, "now">;

function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid bootstrap options");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== fields.length || Object.keys(input).some((key) => !fields.includes(key))) {
    throw new Error("Invalid bootstrap fields");
  }
  return input;
}

function parseOptions(value: unknown): BootstrapOptions {
  const input = exact(value, ["ttlMs", "maxIdentities", "maxLaunches", "maxProjects", "maxSessions", "mcpServerName", "http"]);
  const http = exact(input.http, ["host", "port", "allowedOrigins", "limits"]);
  exact(http.limits, ["maxTransportSessions", "maxPendingInitializations", "maxInFlightRequests", "maxBodyBytes"]);
  // The service's existing validation owns semantic capacity/path validation.
  return input as unknown as BootstrapOptions;
}

/** Explicit entry only; importing this module never starts a service or reads stdin. */
export async function main(input: Readable = process.stdin, output: Writable = process.stdout,
  now: () => Date = () => new Date()): Promise<void> {
  await runServiceControl({ kind: "context-mode", input, output, now, parseOptions,
    async createService(options, clock) {
      const { createSharedService } = await import("./service.js");
      return createSharedService({ ...options, now: clock });
    },
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void main().catch(() => { process.stderr.write("Shared service control failed\n"); process.exitCode = 1; });
}
