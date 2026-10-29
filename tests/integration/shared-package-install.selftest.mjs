import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

// Explicit opt-in command; installation may compile a native dependency, so the
// coordinator must admit this entire foreground command on the execution host.
const artifact = process.env.CONTEXT_MODE_PACKAGE_TARBALL;
const npmCli = process.env.CONTEXT_MODE_TEST_NPM_CLI;
assert.ok(artifact && isAbsolute(artifact) && existsSync(artifact), "Supply the freshly packed CONTEXT_MODE_PACKAGE_TARBALL");
assert.ok(npmCli && isAbsolute(npmCli) && existsSync(npmCli), "Supply absolute CONTEXT_MODE_TEST_NPM_CLI (npm-cli.js)");
const probe = fileURLToPath(new URL("./shared-package-sdk.fixture.mjs", import.meta.url));

function isolatedEnvironment(root) {
  const env = {};
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "COMSPEC", "PATHEXT"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  for (const directory of ["home", "tmp", "cache", "config", "data"]) mkdirSync(join(root, directory));
  const userConfig = join(root, "user-npmrc");
  const globalConfig = join(root, "global-npmrc");
  writeFileSync(userConfig, "");
  writeFileSync(globalConfig, "");
  return { ...env, HOME: join(root, "home"), USERPROFILE: join(root, "home"),
    CODEX_HOME: join(root, "home", ".codex"), CLAUDE_CONFIG_DIR: join(root, "home", ".claude"),
    CONTEXT_MODE_DIR: join(root, "data"), CONTEXT_MODE_PROJECT_DIR: root, CLAUDE_PROJECT_DIR: root,
    TMPDIR: join(root, "tmp"), TEMP: join(root, "tmp"), TMP: join(root, "tmp"),
    XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"),
    npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig, npm_config_cache: join(root, "cache", "npm"),
    npm_config_registry: "https://registry.npmjs.org/", npm_config_global: "false",
    npm_config_jobs: "2", CMAKE_BUILD_PARALLEL_LEVEL: "2", MAKEFLAGS: "-j2",
    npm_config_fetch_retries: "1", npm_config_fetch_timeout: "30000" };
}

function run(root, env, args, label) {
  // No shell, inherited npm configuration, credentials, NODE_OPTIONS, or NODE_PATH.
  const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${label} exited ${result.status}\n${result.stdout.slice(-6000)}\n${result.stderr.slice(-6000)}`);
  return result.stdout.trim();
}

function sdkResolutionScript() {
  const script = `
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {readFileSync} from 'node:fs';
const require=createRequire(join(process.cwd(),'node_modules/context-mode/package.json'));
const entry=require.resolve('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js');
const sdk=dirname(dirname(dirname(dirname(entry))));
console.log(JSON.stringify({root:sdk,version:JSON.parse(readFileSync(join(sdk,'package.json'),'utf8')).version}));`;
  return script;
}

function sqliteProbeScript(helper, packageRoot) {
  return `
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
const {healBetterSqlite3Binding}=await import(${JSON.stringify(pathToFileURL(helper).href)});
const result=healBetterSqlite3Binding(${JSON.stringify(packageRoot)});
assert.equal(result.healed,true);
const require=createRequire(join(${JSON.stringify(packageRoot)},'package.json'));
const Database=require('better-sqlite3');
const db=new Database(':memory:');
try { assert.deepEqual(db.prepare('SELECT 7 AS value').get(),{value:7}); } finally { db.close(); }
console.log(JSON.stringify({reason:result.reason,binding:join(dirname(require.resolve('better-sqlite3/package.json')),
  'build','Release','better_sqlite3.node')}));`;
}

function exerciseDependencyRepair(root, env, packageRoot, binding, installedProbe, mode = "postinstall") {
  const runtime = mode !== "postinstall";
  const refuse = mode === "bad-patch" || mode === "missing-finalizer";
  const paths = JSON.parse(run(root, env, ["--input-type=module", "-e", `
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
const require=createRequire(${JSON.stringify(join(packageRoot, "package.json"))});
const sqlite=require.resolve('better-sqlite3/package.json');
const fromSqlite=createRequire(sqlite);
console.log(JSON.stringify([dirname(fromSqlite.resolve('prebuild-install/bin')),
  join(dirname(sqlite),'node_modules','prebuild-install'),
  ${JSON.stringify(join(packageRoot, "node_modules", "prebuild-install"))}]));`], "find real Layer A packages"));
  const parked = join(root, "unavailable-prebuild-packages");
  mkdirSync(parked);
  const packages = [...new Set(paths.filter((path) => existsSync(path)).map((path) => realpathSync(path)))];
  for (const [index, path] of packages.entries()) {
    const owned = relative(root, path);
    assert.ok(owned && !owned.startsWith("..") && !isAbsolute(owned), "only move fixture-owned packages");
    assert.equal(JSON.parse(readFileSync(join(path, "package.json"), "utf8")).name, "prebuild-install");
    renameSync(path, join(parked, String(index)));
  }
  const ownedBinding = relative(root, realpathSync(binding));
  assert.ok(ownedBinding && !ownedBinding.startsWith("..") && !isAbsolute(ownedBinding));
  unlinkSync(binding);
  run(root, env, ["--input-type=module", "-e", `
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
const require=createRequire(${JSON.stringify(join(packageRoot, "package.json"))});
const fromSqlite=createRequire(require.resolve('better-sqlite3/package.json'));
let resolved;
try { resolved=fromSqlite.resolve('prebuild-install/bin'); }
catch(error) { assert.equal(error.code,'MODULE_NOT_FOUND'); }
assert.equal(resolved,undefined,'Layer A must be unavailable in a fresh process');
for(const directory of ${JSON.stringify(paths)}) assert.equal(existsSync(directory+'/bin.js'),false);
assert.equal(existsSync(${JSON.stringify(binding)}),false);`], "prove Layer A unavailable");
  const damagedFile = mode === "bad-patch" ? join(packageRoot, "patches", "@modelcontextprotocol+sdk+1.26.0.patch")
    : mode === "missing-finalizer" ? join(packageRoot, "scripts", "patch-dependencies.mjs") : undefined;
  const original = damagedFile ? readFileSync(damagedFile) : undefined;
  if (mode === "bad-patch") writeFileSync(damagedFile, "invalid fixture patch\n");
  if (mode === "missing-finalizer") unlinkSync(damagedFile);
  // Exercise the actual packed entry point. Runtime hooks import ensure-deps
  // directly, without invoking the package's postinstall finalizer themselves.
  // npm's real repair must produce the new tree; no command is mocked.
  const command = runtime ? ["--input-type=module", "-e",
    `try { await import(${JSON.stringify(pathToFileURL(join(packageRoot, "hooks", "ensure-deps.mjs")).href)});
      process.stdout.write('RUNTIME_READY\\n'); }
    catch(error) { process.stderr.write(String(error?.code ?? 'UNCLASSIFIED_REPAIR_FAILURE')); process.exitCode=1; }`]
    : [npmCli, "run", "postinstall", "--ignore-scripts=false"];
  const lifecycle = spawnSync(process.execPath, command, {
    cwd: packageRoot, env: { ...env, NODE_ENV: "production", npm_config_omit: "dev" },
    encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
  });
  assert.ifError(lifecycle.error);
  if (!refuse) assert.equal(lifecycle.status, 0, `repair lifecycle failed\n${lifecycle.stderr.slice(-6000)}`);
  run(root, env, ["--input-type=module", "-e", `
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(${JSON.stringify(join(packageRoot, "package.json"))});
const Database=require('better-sqlite3');
const db=new Database(':memory:');
try { assert.deepEqual(db.prepare('SELECT 7 AS value').get(),{value:7}); } finally { db.close(); }`], "fresh native resolution after repair");
  if (refuse) {
    assert.notEqual(lifecycle.status, 0, "runtime must refuse a repaired tree whose SDK patch cannot be finalized");
    assert.doesNotMatch(lifecycle.stdout, /RUNTIME_READY/);
    assert.equal(lifecycle.stderr, "CONTEXT_MODE_DEPENDENCY_PATCH_FAILED", "report a stable code without captured subprocess logs");
    // The failed finalizer already left a working SQLite binding on disk.
    // A fresh hook must not mistake that native health for SDK patch success.
    const retry = spawnSync(process.execPath, command, { cwd: packageRoot,
      env: { ...env, NODE_ENV: "production", npm_config_omit: "dev" }, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    assert.ifError(retry.error);
    assert.notEqual(retry.status, 0, "a fresh runtime retry must remain blocked until SDK finalization succeeds");
    assert.doesNotMatch(retry.stdout, /RUNTIME_READY/);
    assert.equal(retry.stderr, "CONTEXT_MODE_DEPENDENCY_PATCH_FAILED");
    writeFileSync(damagedFile, original);
    const recovered = spawnSync(process.execPath, command, { cwd: packageRoot,
      env: { ...env, NODE_ENV: "production", npm_config_omit: "dev" }, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    assert.ifError(recovered.error);
    assert.equal(recovered.status, 0, `restoring the contract must allow repair\n${recovered.stderr}`);
    assert.match(recovered.stdout, /RUNTIME_READY/);
    assert.equal(run(root, env, [installedProbe], "SDK behavior after restored finalizer"), "SDK package cleanup verified");
    assert.equal(run(root, env, ["--input-type=module", "-e", `
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
let patchCalls=0;
for(const method of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) {
  const original=childProcess[method];
  childProcess[method]=function(...args) {
    if((typeof args[0]==='string' && args[0].includes('patch-dependencies.mjs')) ||
       (Array.isArray(args[1]) && args[1].some(value=>typeof value==='string' && value.includes('patch-dependencies.mjs')))) patchCalls++;
    return Reflect.apply(original,this,args);
  };
}
syncBuiltinESMExports();
await import(${JSON.stringify(pathToFileURL(join(packageRoot, "hooks", "ensure-deps.mjs")).href)});
assert.equal(patchCalls,0,'a verified healthy retry must not spawn the patch CLI');
console.log('VERIFIED_SDK_REUSED');`], "healthy verification without patch subprocess"), "VERIFIED_SDK_REUSED");
    return;
  }
  assert.equal(run(root, env, [installedProbe], `SDK behavior after real ${runtime ? "runtime" : "postinstall"} repair`), "SDK package cleanup verified");
  assert.doesNotMatch(lifecycle.stderr, /native binding could not be installed automatically/,
    "healer must recognize the freshly resolved working binding instead of its stale path");
}

const repairModes = { "hoisted-layer-b-repair": "postinstall", "hoisted-runtime-repair": "runtime",
  "hoisted-runtime-bad-patch": "bad-patch", "hoisted-runtime-missing-finalizer": "missing-finalizer" };
for (const layout of ["hoisted", "version-conflict", "hoisted-runtime-healthy", ...Object.keys(repairModes)]) {
  test(`packed production install patches its resolved SDK (${layout})`, () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "shared-package-install-")));
    const env = isolatedEnvironment(root);
    try {
      // Hoisting is a strategy, not a guarantee for one transitive package.
      // Pin SDK at the consumer and align its Zod peer with context-mode's
      // dependency so npm need not create a second SDK peer placement.
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "shared-package-consumer", version: "1.0.0",
        private: true, type: "module", dependencies: { "context-mode": pathToFileURL(resolve(artifact)).href,
          "@modelcontextprotocol/sdk": layout === "version-conflict" ? "1.25.3" : "1.26.0",
          zod: "^3.25.0" } }));
      run(root, env, [npmCli, "install", "--omit=dev", "--ignore-scripts=false", "--foreground-scripts",
        "--install-strategy=hoisted", "--no-audit", "--no-fund"], "production install");
      const info = JSON.parse(run(root, env, ["--input-type=module", "-e", sdkResolutionScript()], "resolve installed SDK"));
      assert.equal(info.version, "1.26.0");
      const expected = layout !== "version-conflict"
        ? join(root, "node_modules", "@modelcontextprotocol", "sdk")
        : join(root, "node_modules", "context-mode", "node_modules", "@modelcontextprotocol", "sdk");
      assert.equal(realpathSync(info.root), realpathSync(expected), "test must exercise the intended real npm layout");
      const packageRoot = join(root, "node_modules", "context-mode");
      const native = JSON.parse(run(root, env, ["--input-type=module", "-e",
        sqliteProbeScript(join(packageRoot, "scripts", "heal-better-sqlite3.mjs"), packageRoot)], "healthy native dependency"));
      assert.equal(native.reason, "binding-present", "a healthy resolved binding must not trigger repair");
      if (layout !== "version-conflict") assert.equal(realpathSync(native.binding),
        realpathSync(join(root, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node")));
      const afterNative = JSON.parse(run(root, env, ["--input-type=module", "-e", sdkResolutionScript()], "SDK after native check"));
      assert.equal(realpathSync(afterNative.root), realpathSync(expected), "healthy binding recognition must preserve SDK placement");
      if (layout === "version-conflict") {
        assert.equal(JSON.parse(readFileSync(join(root, "node_modules", "@modelcontextprotocol", "sdk", "package.json"))).version, "1.25.3");
      }
      const installedProbe = join(root, "sdk-probe.mjs");
      copyFileSync(probe, installedProbe);
      assert.equal(run(root, env, [installedProbe], "installed SDK behavior"), "SDK package cleanup verified");
      const fingerprints = () => ["esm", "cjs"].map((format) => createHash("sha256")
        .update(readFileSync(join(info.root, "dist", format, "server", "webStandardStreamableHttp.js"))).digest("hex"));
      const before = fingerprints();
      run(root, env, [npmCli, "rebuild", "context-mode", "--ignore-scripts=false", "--foreground-scripts",
        "--no-audit", "--no-fund"], "idempotent rebuild");
      assert.deepEqual(fingerprints(), before, "rebuild must preserve the applied SDK patch");
      assert.equal(run(root, env, [installedProbe], "rebuilt SDK behavior"), "SDK package cleanup verified");
      if (layout === "hoisted-runtime-healthy") {
        run(root, env, ["--input-type=module", "-e",
          `await import(${JSON.stringify(pathToFileURL(join(packageRoot, "hooks", "ensure-deps.mjs")).href)});`], "healthy runtime bootstrap");
        const afterRuntime = JSON.parse(run(root, env, ["--input-type=module", "-e", sdkResolutionScript()], "SDK after healthy bootstrap"));
        assert.equal(realpathSync(afterRuntime.root), realpathSync(expected), "healthy runtime bootstrap must not replace its dependency graph");
        assert.equal(existsSync(join(packageRoot, "node_modules", "better-sqlite3")), false);
        assert.equal(run(root, env, [installedProbe], "SDK behavior after healthy bootstrap"), "SDK package cleanup verified");
      }
      if (repairModes[layout]) {
        exerciseDependencyRepair(root, env, packageRoot, native.binding, installedProbe, repairModes[layout]);
      }
    } finally {
      // Only remove the exact fixture created here; never follow an arbitrary path.
      assert.equal(dirname(root), realpathSync(tmpdir()));
      assert.ok(relative(realpathSync(tmpdir()), root).startsWith("shared-package-install-"));
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("standalone native repair handles a missing package and a missing binding", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "shared-package-install-")));
  const env = isolatedEnvironment(root);
  const helper = fileURLToPath(new URL("../../scripts/heal-better-sqlite3.mjs", import.meta.url));
  let binding;
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "shared-native-repair", version: "1.0.0",
      private: true, dependencies: { "better-sqlite3": "^12.6.2" } }));
    await t.test("installs a genuinely missing standalone package with a usable binding", () => {
      assert.equal(existsSync(join(root, "node_modules", "better-sqlite3")), false);
      const result = JSON.parse(run(root, env, ["--input-type=module", "-e", sqliteProbeScript(helper, root)], "missing package repair"));
      assert.equal(result.reason, "package-installed");
      binding = realpathSync(result.binding);
      assert.ok(binding.startsWith(root + "/") || binding.startsWith(root + "\\"));
    });
    await t.test("repairs a genuinely missing standalone native binding", () => {
      assert.ok(binding, "package repair must complete first");
      unlinkSync(binding);
      assert.equal(existsSync(binding), false);
      const result = JSON.parse(run(root, env, ["--input-type=module", "-e", sqliteProbeScript(helper, root)], "missing binding repair"));
      assert.ok(["prebuild-install", "npm-install"].includes(result.reason));
      assert.equal(realpathSync(result.binding), binding);
    });
  } finally {
    assert.equal(dirname(root), realpathSync(tmpdir()));
    assert.ok(relative(realpathSync(tmpdir()), root).startsWith("shared-package-install-"));
    rmSync(root, { recursive: true, force: true });
  }
});
