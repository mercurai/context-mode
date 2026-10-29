import type { AuthenticatedScope, NativeToolCall, ResolvedIdentity } from "./identity.js";
import { createHash } from "node:crypto";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

/** Protected launcher input; accepting this object is not authentication. */
export interface TrustedExecutionLaunch {
  scope: Readonly<AuthenticatedScope>;
  workspace: string;
  revision: string;
  codexExecutable?: string;
  environment: Readonly<Record<string, string>>;
  runtimePaths: Readonly<Record<string, string>>;
  capabilityEnvironmentKeys: readonly string[];
  isActive: (scope: Readonly<AuthenticatedScope>, revision: string) => boolean;
}

export interface BoundExecutionPolicy {
  readonly authorityId: string;
  readonly identity: Readonly<ResolvedIdentity>;
  readonly revision: string;
  readonly executable: string;
  /** Native sandbox prefix ending with --; command arguments follow unchanged. */
  readonly argsPrefix: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly runtimePaths: Readonly<Record<string, string>>;
  assertActive(): void;
}

function text(value: unknown, maximum = 4096): string {
  if (typeof value !== "string" || !value || value.includes("\0") || Buffer.byteLength(value) > maximum) {
    throw new Error("Invalid execution policy input");
  }
  return value;
}

function canonical(path: unknown, directory: boolean): string {
  const original = text(path);
  if (!isAbsolute(original)) throw new Error("Execution policy requires an absolute executable or directory");
  try {
    const result = realpathSync(original);
    const stat = statSync(result);
    if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error();
    if (!directory) accessSync(result, constants.X_OK);
    return result;
  } catch { throw new Error("Execution policy executable or directory is unavailable"); }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("Invalid native policy object");
  return value as Record<string, unknown>;
}

/** Validate JSON data without executing accessors or invoking toJSON hooks. */
function jsonValue(value: unknown, seen = new Set<object>(), depth = 0): void {
  if (depth > 64) throw new Error("Native policy structure limit exceeded");
  if (value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))) return;
  if (!value || typeof value !== "object" || seen.has(value)) throw new Error("Invalid native policy value");
  if (!Array.isArray(value)) record(value);
  seen.add(value);
  for (const key of Object.keys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in property)) throw new Error("Invalid native policy accessor");
    jsonValue(property.value, seen, depth + 1);
  }
  seen.delete(value);
}

export function resolveTrustedRuntimePaths(
  candidates: Readonly<Record<string, string>>,
  context: { path: string; cwd: string },
): Readonly<Record<string, string>> {
  const cwd = canonical(context.cwd, true);
  if (typeof context.path !== "string" || context.path.includes("\0")) throw new Error("Invalid trusted runtime PATH");
  const directories = context.path.split(delimiter).filter(Boolean).map((path) => resolve(cwd, path));
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(candidates)) {
    const candidate = text(value);
    const paths = isAbsolute(candidate) || /[\\/]/.test(candidate)
      ? [resolve(cwd, candidate)] : directories.map((directory) => resolve(directory, candidate));
    let executable: string | undefined;
    for (const path of paths) {
      try { executable = canonical(path, false); break; } catch { /* Only the explicit trusted search list is consulted. */ }
    }
    if (!executable) throw new Error("Trusted runtime executable could not be resolved");
    resolved[name] = executable;
  }
  return Object.freeze(resolved);
}

export function bindExecutionPolicy(
  launch: TrustedExecutionLaunch,
  identity: Readonly<ResolvedIdentity>,
  request: NativeToolCall,
): BoundExecutionPolicy {
  const scope = Object.freeze({ provider: launch.scope.provider, home: canonical(launch.scope.home, true),
    launchId: text(launch.scope.launchId, 256) });
  const workspace = canonical(launch.workspace, true);
  const revision = text(launch.revision, 256);
  if (identity.provider !== scope.provider || identity.home !== scope.home || identity.workspace !== workspace ||
    identity.launchId !== scope.launchId) throw new Error("Execution identity does not match launch scope");
  const isActive = launch.isActive;
  const assertActive = () => {
    let active = false;
    try { active = isActive(scope, revision) === true; } catch { /* Never expose control-plane diagnostics. */ }
    if (!active) throw new Error("Execution authority is inactive or revoked");
  };
  assertActive();
  if (scope.provider === "claude-code") throw new Error("Claude effective execution policy is unavailable");
  if (scope.provider !== "codex") throw new Error("Unsupported native execution policy provider");
  if (!launch.codexExecutable) throw new Error("Trusted Codex launcher executable is missing");
  const executable = canonical(launch.codexExecutable, false);
  const meta = record(request._meta);
  const state = meta["codex/sandbox-state"] ?? meta["codex/sandbox-state-meta"];
  record(state); jsonValue(state);
  if (meta["codex/sandbox-state"] !== undefined && meta["codex/sandbox-state-meta"] !== undefined &&
    !isDeepStrictEqual(meta["codex/sandbox-state"], meta["codex/sandbox-state-meta"])) {
    throw new Error("Conflicting native sandbox policy aliases");
  }
  const serialized = JSON.stringify(state);
  if (Buffer.byteLength(serialized) > 16384) throw new Error("Native sandbox policy argument limit exceeded");
  const excluded = new Set(launch.capabilityEnvironmentKeys.map((key) => text(key).toLowerCase()));
  const entries = Object.entries(record(launch.environment)).filter(([key]) => !excluded.has(key.toLowerCase()));
  if (entries.length > 512 || entries.some(([key, value]) => !key || /[=\0]/.test(key) || Buffer.byteLength(key) > 32768 ||
    typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > 32768)) {
    throw new Error("Invalid execution policy environment");
  }
  const environment = Object.freeze(Object.fromEntries(entries) as Record<string, string>);
  const runtimePaths = Object.freeze(Object.fromEntries(Object.entries(record(launch.runtimePaths))
    .map(([name, path]) => [name, canonical(path, false)])));
  const snapshot = Object.freeze({ ...identity });
  const authorityId = createHash("sha256").update(JSON.stringify([
    scope.provider, scope.home, workspace, scope.launchId, revision, snapshot.sessionId,
    snapshot.threadId ?? snapshot.agentId ?? snapshot.sessionId, serialized,
  ])).digest("hex");
  return Object.freeze({ authorityId, identity: snapshot, revision, executable,
    argsPrefix: Object.freeze(["sandbox", "--sandbox-state-json", serialized, "--"]),
    environment, runtimePaths, assertActive });
}
