import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Diagnostic only. Run as one admitted foreground job: npm may build native
// dependencies. Retain the isolated fixture and bounded evidence for inspection.
const artifact = process.env.CONTEXT_MODE_PACKAGE_TARBALL;
const npmCli = process.env.CONTEXT_MODE_TEST_NPM_CLI;
assert.ok(artifact && isAbsolute(artifact) && existsSync(artifact), "Supply the packed artifact");
assert.ok(npmCli && isAbsolute(npmCli) && existsSync(npmCli), "Supply absolute npm-cli.js");
const root = realpathSync(mkdtempSync(join(tmpdir(), "shared-package-diagnostic-")));
const context = join(root, "node_modules", "context-mode");
for (const name of ["home", "tmp", "cache", "config", "data", "evidence"]) mkdirSync(join(root, name));
for (const name of ["user-npmrc", "global-npmrc"]) writeFileSync(join(root, name), "");
const env = {};
for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "COMSPEC", "PATHEXT"]) {
  if (process.env[key]) env[key] = process.env[key];
}
Object.assign(env, { HOME: join(root, "home"), USERPROFILE: join(root, "home"),
  CODEX_HOME: join(root, "home", ".codex"), CLAUDE_CONFIG_DIR: join(root, "home", ".claude"),
  CONTEXT_MODE_DIR: join(root, "data"), CONTEXT_MODE_PROJECT_DIR: root, CLAUDE_PROJECT_DIR: root,
  TMPDIR: join(root, "tmp"), TEMP: join(root, "tmp"), TMP: join(root, "tmp"),
  XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"),
  npm_config_userconfig: join(root, "user-npmrc"), npm_config_globalconfig: join(root, "global-npmrc"),
  npm_config_cache: join(root, "cache", "npm"), npm_config_registry: "https://registry.npmjs.org/",
  // npm supplies these to lifecycle children for the real --omit=dev install.
  NODE_ENV: "production", npm_config_omit: "dev",
  npm_config_global: "false", npm_config_jobs: "2", CMAKE_BUILD_PARALLEL_LEVEL: "2", MAKEFLAGS: "-j2",
  npm_config_fetch_retries: "1", npm_config_fetch_timeout: "30000" });
const report = { root, stages: [], snapshots: [] };

function run(name, args, cwd = root, required = true) {
  const result = spawnSync(process.execPath, args, { cwd, env, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const stage = { name, status: result.status, signal: result.signal, error: result.error?.code,
    stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr) };
  report.stages.push(stage);
  writeFileSync(join(root, "evidence", `${name}.log`), `${stdout.slice(-12000)}\n${stderr.slice(-12000)}`);
  console.log(JSON.stringify(stage));
  if (required) { assert.ifError(result.error); assert.equal(result.status, 0, `${name} failed; inspect retained evidence`); }
}

function packageMetadata(packageRoot, sdk = false) {
  if (!existsSync(join(packageRoot, "package.json"))) return { root: packageRoot, present: false };
  const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const result = { root: realpathSync(packageRoot), name: metadata.name, version: metadata.version };
  if (sdk) result.files = ["esm", "cjs"].map((format) => {
    const source = readFileSync(join(packageRoot, "dist", format, "server", "webStandardStreamableHttp.js"));
    return { format, sha256: createHash("sha256").update(source).digest("hex"),
      resolvesPendingJsonOnClose: source.includes("resolveJson?.(new Response(null, { status: 503 }))") };
  });
  else result.nativeBindingPresent = existsSync(join(packageRoot, "build", "Release", "better_sqlite3.node"));
  return result;
}

function snapshot(name) {
  const resolution = [];
  for (const base of [root, context]) {
    const require = createRequire(join(base, "package.json"));
    const sdkEntry = require.resolve("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js");
    resolution.push({ from: base, sdk: dirname(dirname(dirname(dirname(sdkEntry)))),
      sqlite: dirname(require.resolve("better-sqlite3/package.json")) });
  }
  const value = { name, resolution,
    sdk: [root, context].map((base) => packageMetadata(join(base, "node_modules", "@modelcontextprotocol", "sdk"), true)),
    sqlite: [root, context].map((base) => packageMetadata(join(base, "node_modules", "better-sqlite3"))) };
  report.snapshots.push(value);
  console.log(JSON.stringify(value));
}

try {
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "shared-package-diagnostic", version: "1.0.0",
    private: true, type: "module", dependencies: { "context-mode": pathToFileURL(resolve(artifact)).href,
      "@modelcontextprotocol/sdk": "1.26.0", zod: "^3.25.0" } }));
  const probe = join(root, "sdk-probe.mjs");
  copyFileSync(fileURLToPath(new URL("./shared-package-sdk.fixture.mjs", import.meta.url)), probe);
  run("01-install-without-lifecycle", [npmCli, "install", "--omit=dev", "--ignore-scripts=true",
    "--install-strategy=hoisted", "--no-audit", "--no-fund"]);
  snapshot("after-install-without-lifecycle");
  run("02-build-hoisted-native-binding", [npmCli, "rebuild", "better-sqlite3", "--ignore-scripts=false",
    "--foreground-scripts", "--no-audit", "--no-fund"]);
  snapshot("before-context-lifecycle");
  run("03-apply-shipped-sdk-patch", [join(context, "scripts", "patch-dependencies.mjs")], context);
  snapshot("after-sdk-patch");
  run("04-probe-before-postinstall", [probe]);
  run("05-run-unchanged-postinstall", [join(context, "scripts", "postinstall.mjs")], context);
  snapshot("after-postinstall");
  run("06-probe-after-postinstall", [probe], root, false);
} finally {
  const evidence = join(root, "evidence", "report.json");
  writeFileSync(evidence, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ retainedFixture: root, report: evidence }));
}
