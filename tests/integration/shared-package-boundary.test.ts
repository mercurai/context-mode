import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

/** Root prepares a real npm pack --ignore-scripts artifact after emitting build/. */
describe("packed shared security exports", () => {
  let fixture: string;
  let packageRoot: string;

  beforeEach(() => {
    const artifact = process.env.CONTEXT_MODE_PACKAGE_TARBALL;
    if (!artifact || !existsSync(artifact)) throw new Error("Prepare CONTEXT_MODE_PACKAGE_TARBALL with npm pack --ignore-scripts first");
    fixture = mkdtempSync(join(tmpdir(), "shared-package-boundary-"));
    packageRoot = join(fixture, "node_modules", "context-mode");
    mkdirSync(packageRoot, { recursive: true });
    execFileSync("tar", ["-xzf", resolve(artifact), "--strip-components=1", "-C", packageRoot], { stdio: "pipe" });
    writeFileSync(join(fixture, "package.json"), JSON.stringify({ type: "module", private: true }));
  });

  afterEach(() => { if (fixture) rmSync(fixture, { recursive: true, force: true }); });

  test("the public control export imports without starting an engine, listener, process or stdin consumer", () => {
    const loader = join(fixture, "control-boundary-loader.mjs");
    writeFileSync(loader, `
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (result.url.includes('/node_modules/context-mode/') &&
      !/\\/build\\/shared\\/control\\.js$/.test(result.url)) {
    throw new Error('Control import loaded a service implementation');
  }
  return result;
}
`);
    const probe = join(fixture, "control-probe.mjs");
    writeFileSync(probe, `
import assert from 'node:assert/strict';
import net from 'node:net';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
net.Server.prototype.listen = function () { throw new Error('Import started a listener'); };
process.dlopen = function () { throw new Error('Import loaded a native addon'); };
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[method] = function () { throw new Error('Import spawned a process'); };
}
syncBuiltinESMExports();
const before = [process.stdin.listenerCount('data'), process.listenerCount('SIGTERM')];
const control = await import('context-mode/shared/control');
assert.equal(typeof control.runServiceControl, 'function');
assert.deepEqual([process.stdin.listenerCount('data'), process.listenerCount('SIGTERM')], before);
console.log('control-only package import passed');
`);
    const result = spawnSync(process.execPath, ["--no-warnings", "--loader", pathToFileURL(loader).href, probe], {
      cwd: fixture, encoding: "utf8", timeout: 15_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, "packed public control import must succeed").toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("control-only package import passed");
  });

  test("identity and launch authority import and enforce real identity without engine or listener dependencies", () => {
    const loader = join(fixture, "boundary-loader.mjs");
    writeFileSync(loader, `
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (result.url.includes('/node_modules/context-mode/') &&
      !/\\/build\\/shared\\/(identity|launch-authority)\\.js$/.test(result.url)) {
    throw new Error('Security-only import loaded an engine module');
  }
  return result;
}
`);
    const probe = join(fixture, "probe.mjs");
    writeFileSync(probe, `
import assert from 'node:assert/strict';
import net from 'node:net';
import childProcess from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
net.Server.prototype.listen = function () { throw new Error('Import started a listener'); };
process.dlopen = function () { throw new Error('Import loaded a native addon'); };
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[method] = function () { throw new Error('Import spawned a process'); };
}
syncBuiltinESMExports();
const events = ['SIGINT', 'SIGTERM', 'exit', 'uncaughtException', 'unhandledRejection'];
const listeners = events.map(event => process.listeners(event));
const { SharedIdentityRegistry } = await import('context-mode/shared/identity');
const { createSharedLaunchAuthority } = await import('context-mode/shared/launch-authority');
const registry = new SharedIdentityRegistry({ now: () => new Date(0), ttlMs: 1000, maxEntries: 4 });
const authority = createSharedLaunchAuthority({ identityRegistry: registry, now: () => new Date(0),
  ttlMs: 1000, maxLaunches: 2, mcpServerName: 'codegraph', toolNames: ['query'] });
const workspace = join(process.cwd(), 'workspace');
mkdirSync(workspace);
const canonical = realpathSync(workspace);
const grant = authority.issue({ provider: 'codex', home: canonical, userHome: canonical, workspace: canonical });
const request = { headers: { authorization: 'Bearer ' + grant.hookCapability },
  rawHeaders: ['Authorization', 'Bearer ' + grant.hookCapability] };
authority.registerHook(request, { hook_event_name: 'SessionStart', session_id: 'root', cwd: canonical });
const call = { name: 'query', _meta: { threadId: 'root', sessionId: 'root' } };
assert.equal(registry.resolve(grant.scope, call).workspace, canonical);
assert.throws(() => authority.authenticate(request));
authority.revoke(grant.scope);
assert.throws(() => registry.resolve(grant.scope, call));
authority.close();
assert.deepEqual(events.map(event => process.listeners(event)), listeners);
console.log('security-only package import passed');
`);
    const result = spawnSync(process.execPath, ["--no-warnings", "--loader", pathToFileURL(loader).href, probe], {
      cwd: fixture, encoding: "utf8", timeout: 15_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("security-only package import passed");
  });

  test("published subpaths resolve emitted runtime files and useful declarations", () => {
    const source = join(fixture, "consumer.ts");
    writeFileSync(source, `
import type { AuthenticatedScope } from 'context-mode/shared/identity';
import type { SharedLaunchMetadata } from 'context-mode/shared/launch-authority';
import type { SharedService } from 'context-mode/shared/service';
import type { ControlledService, ServiceControlOptions } from 'context-mode/shared/control';
const scope: AuthenticatedScope = { provider: 'codex', home: '/config', launchId: 'launch' };
const metadata: SharedLaunchMetadata = { provider: scope.provider, home: scope.home, userHome: '/user', workspace: '/work' };
// @ts-expect-error workspace is required by the public launch contract
const invalid: SharedLaunchMetadata = { provider: 'codex', home: '/config', userHome: '/user' };
declare const service: SharedService;
service.issue(metadata);
declare const controlled: ControlledService;
const options: ServiceControlOptions<{ ttlMs: number; maxLaunches: number }> = {
  kind: 'codegraph', input: null!, output: null!, now: () => new Date(0),
  parseOptions: () => ({ ttlMs: 1000, maxLaunches: 1 }),
  createService: async () => controlled,
};
// @ts-expect-error private protocol only admits its two supported service kinds
const invalidKind: ServiceControlOptions<{ ttlMs: number; maxLaunches: number }>['kind'] = 'arbitrary';
void options; void invalidKind;
void invalid;
`);
    const options: ts.CompilerOptions = { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022, strict: true, skipLibCheck: true, noEmit: true, types: [] };
    for (const name of ["identity", "launch-authority", "service", "control"]) {
      const resolved = ts.resolveModuleName(`context-mode/shared/${name}`, source, options, ts.sys).resolvedModule;
      expect(resolved?.resolvedFileName.replaceAll("\\", "/")).toBe(join(packageRoot, "build", "shared", `${name}.d.ts`).replaceAll("\\", "/"));
      expect(existsSync(join(packageRoot, "build", "shared", `${name}.js`))).toBe(true);
    }
    const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([source], options));
    expect(diagnostics.map((entry) => ts.flattenDiagnosticMessageText(entry.messageText, "\n"))).toEqual([]);
    const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    expect(metadata.dependencies["@modelcontextprotocol/sdk"]).toBe("1.26.0");
    expect(existsSync(join(packageRoot, "patches", "@modelcontextprotocol+sdk+1.26.0.patch"))).toBe(true);
  });
});
