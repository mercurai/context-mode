import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bindExecutionPolicy, resolveTrustedRuntimePaths, type TrustedExecutionLaunch } from "../../src/shared/execution-policy.js";
import type { NativeToolCall, ResolvedIdentity } from "../../src/shared/identity.js";

describe("trusted native execution policy binding", () => {
  let root: string;
  let identity: ResolvedIdentity;
  let launch: TrustedExecutionLaunch;
  let request: NativeToolCall;
  let state: Record<string, unknown>;
  let active: boolean;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "ctx-native-policy-")));
    const home = join(root, "home"), workspace = join(root, "workspace");
    mkdirSync(home); mkdirSync(workspace);
    identity = { provider: "codex", home, workspace, launchId: "launch-a", sessionId: "session-a", threadId: "thread-a" };
    active = true;
    launch = {
      scope: { provider: identity.provider, home, launchId: identity.launchId }, workspace, revision: "policy-1",
      // No subprocess is launched in these pure binding tests. Executable
      // capability verification belongs to the protected launcher integration.
      codexExecutable: realpathSync(process.execPath),
      environment: { HOME: home, CTX_SYNTHETIC_OWNER: "owner-a", CTX_MCP_CAP: "synthetic-mcp", ctx_hook_cap: "synthetic-hook" },
      runtimePaths: { javascript: realpathSync(process.execPath) },
      capabilityEnvironmentKeys: ["CTX_MCP_CAP", "CTX_HOOK_CAP"],
      isActive: (scope, revision) => active && scope.launchId === "launch-a" && revision === "policy-1",
    };
    state = { permissionProfile: { type: "disabled" }, sandboxCwd: pathToFileURL(workspace).href,
      codexLinuxSandboxExe: null, useLegacyLandlock: false, useMxc: false,
      futureField: { nested: ["must", "survive"] } };
    request = { name: "ctx_execute", _meta: { threadId: identity.threadId, sessionId: identity.sessionId,
      "codex/sandbox-state": state }, arguments: { language: "javascript", code: "0" } };
  });

  afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

  test("preserves the entire native sandbox object as one unchanged argument", () => {
    const bound = bindExecutionPolicy(launch, identity, request);
    expect(bound.executable).toBe(launch.codexExecutable);
    expect(bound.argsPrefix).toEqual(["sandbox", "--sandbox-state-json", JSON.stringify(state), "--"]);
    expect(JSON.parse(bound.argsPrefix[2])).toEqual(state);
    expect(bound.identity).toEqual(identity);
  });

  test("snapshots ownership, policy and environment while retaining live revocation", () => {
    const bound = bindExecutionPolicy(launch, identity, request);
    const original = JSON.stringify(state);
    (state.futureField as { nested: string[] }).nested.push("mutated");
    identity.threadId = "other-thread";
    launch.revision = "policy-2";
    (launch.environment as Record<string, string>).CTX_SYNTHETIC_OWNER = "other-owner";
    (launch.runtimePaths as Record<string, string>).javascript = join(root, "untrusted-program");
    expect(bound.argsPrefix[2]).toBe(original);
    expect(bound.identity.threadId).toBe("thread-a");
    expect(bound.revision).toBe("policy-1");
    expect(bound.environment.CTX_SYNTHETIC_OWNER).toBe("owner-a");
    expect(bound.runtimePaths.javascript).toBe(realpathSync(process.execPath));
    Reflect.set(bound.environment, "CTX_SYNTHETIC_OWNER", "tampered");
    expect(bound.environment.CTX_SYNTHETIC_OWNER).toBe("owner-a");
    expect(() => bound.assertActive()).not.toThrow();
    active = false;
    expect(() => bound.assertActive()).toThrow(/inactive|revoked|authority/i);
  });

  test.each(["provider", "home", "workspace", "launchId"] as const)("rejects a resolved identity from another %s", (field) => {
    const foreign = { ...identity, [field]: field === "provider" ? "claude-code" : field === "home" || field === "workspace" ? root : "other-launch" };
    expect(() => bindExecutionPolicy(launch, foreign as ResolvedIdentity, request)).toThrow(/identity|launch|scope|binding/i);
  });

  test("separates identical conversations across policy revisions and launches", () => {
    const first = bindExecutionPolicy(launch, identity, request);
    const revised = bindExecutionPolicy({ ...launch, revision: "policy-2", isActive: () => true }, identity, request);
    const other = bindExecutionPolicy({ ...launch, scope: { ...launch.scope, launchId: "launch-b" }, isActive: () => true },
      { ...identity, launchId: "launch-b" }, request);
    expect(new Set([first.authorityId, revised.authorityId, other.authorityId]).size).toBe(3);
  });

  test("changed native policy cannot reuse an old authority identity at the same launch revision", () => {
    const first = bindExecutionPolicy(launch, identity, request);
    const changed = { ...request, _meta: { ...(request._meta as object), "codex/sandbox-state": { ...state, useMxc: true } } };
    expect(bindExecutionPolicy(launch, identity, changed).authorityId).not.toBe(first.authorityId);
    active = false;
    expect(() => bindExecutionPolicy(launch, identity, request)).toThrow(/inactive|revoked|authority/i);
  });

  test("never accepts model arguments as native policy or a launcher path", () => {
    const forged = { ...request, _meta: { threadId: identity.threadId, sessionId: identity.sessionId },
      arguments: { "codex/sandbox-state": state, codexExecutable: process.execPath } };
    expect(() => bindExecutionPolicy(launch, identity, forged)).toThrow(/native|sandbox|policy/i);
    expect(() => bindExecutionPolicy({ ...launch, codexExecutable: undefined }, identity, request)).toThrow(/launcher|executable/i);
  });

  test("refuses contradictory aliases rather than selecting a weaker sandbox policy", () => {
    const mismatched = { ...request, _meta: { ...(request._meta as object), "codex/sandbox-state-meta": { different: true } } };
    expect(() => bindExecutionPolicy(launch, identity, mismatched)).toThrow(/conflict|alias|policy/i);
  });

  test("rejects oversized opaque policy unchanged with a redacted error", () => {
    const marker = "synthetic-private-policy-value";
    state.futureField = marker.repeat(900);
    const before = JSON.stringify(state);
    let message = "";
    try { bindExecutionPolicy(launch, identity, request); }
    catch (error) { message = String(error); }
    expect(message).toMatch(/policy.*(size|limit|large)|argument.*limit/i);
    expect(message).not.toContain(marker);
    expect(JSON.stringify(state)).toBe(before);
  });

  test("excludes service capabilities case-insensitively without inheriting process environment", () => {
    vi.stubEnv("CTX_SERVICE_ONLY", "synthetic-service-secret");
    const bound = bindExecutionPolicy(launch, identity, request);
    expect(bound.environment).toEqual({ HOME: identity.home, CTX_SYNTHETIC_OWNER: "owner-a" });
    expect(JSON.stringify(bound)).not.toMatch(/synthetic-mcp|synthetic-hook|synthetic-service-secret/);
  });

  test("Claude permission_mode and project settings cannot stand in for effective native policy", () => {
    const claude = { ...identity, provider: "claude-code" as const };
    const claudeLaunch = { ...launch, scope: { ...launch.scope, provider: "claude-code" as const } };
    const call = { name: "ctx_execute", _meta: { "claudecode/toolUseId": "tool-1", permission_mode: "bypassPermissions" },
      arguments: { policy: { allow: ["Bash(*)"] } } };
    expect(() => bindExecutionPolicy(claudeLaunch, claude, call)).toThrow(/Claude.*policy.*(unavailable|unsupported|missing)|effective.*policy/i);
  });

  test("resolves executable names only through trusted PATH and trusted cwd", () => {
    const name = process.platform === "win32" ? "fixture-runtime.exe" : "fixture-runtime";
    const trusted = join(identity.workspace, "bin"), rogue = join(root, "rogue");
    mkdirSync(trusted); mkdirSync(rogue);
    for (const directory of [trusted, rogue]) { writeFileSync(join(directory, name), "fixture executable"); chmodSync(join(directory, name), 0o755); }
    vi.stubEnv("PATH", rogue); vi.stubEnv("Path", rogue);
    const resolved = resolveTrustedRuntimePaths({ javascript: name }, { path: "bin", cwd: identity.workspace });
    expect(resolved).toEqual({ javascript: realpathSync(join(trusted, name)) });
    expect(() => resolveTrustedRuntimePaths({ javascript: name }, { path: "", cwd: identity.home })).toThrow(/runtime|executable|resolve/i);
    expect(() => resolveTrustedRuntimePaths({ javascript: "missing-runtime" }, { path: trusted, cwd: identity.workspace })).toThrow(/runtime|executable|resolve/i);
  });
});
