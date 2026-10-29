#!/usr/bin/env node
/** Apply the shipped SDK patch to the dependency this package actually resolves. */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function patchDependencies() {
  // npm can hoist SDK beside context-mode or nest it when the consumer uses a
  // different version. Resolve from this package instead of assuming either.
  const entry = require.resolve("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js");
  const sdkRoot = dirname(dirname(dirname(dirname(entry))));
  const sdk = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8"));
  if (sdk.name !== "@modelcontextprotocol/sdk" || sdk.version !== "1.26.0") {
    throw new Error("SDK dependency patch requires @modelcontextprotocol/sdk 1.26.0");
  }
  const installRoot = dirname(dirname(dirname(sdkRoot)));
  const expectedRoot = join(installRoot, "node_modules", "@modelcontextprotocol", "sdk");
  if (!existsSync(join(installRoot, "package.json")) || !existsSync(expectedRoot) ||
      realpathSync(expectedRoot) !== realpathSync(sdkRoot) ||
      entry !== join(sdkRoot, "dist", "cjs", "server", "webStandardStreamableHttp.js") ||
      !existsSync(join(sdkRoot, "dist", "esm", "server", "webStandardStreamableHttp.js"))) {
    throw new Error("SDK dependency patch requires a supported node_modules package layout");
  }
  const patches = join(packageRoot, "patches");
  const patchDir = relative(installRoot, patches);
  if (isAbsolute(patchDir) || !existsSync(join(patches, "@modelcontextprotocol+sdk+1.26.0.patch"))) {
    throw new Error("SDK dependency patch is unavailable from the dependency installation root");
  }
  // Invoke the dependency's declared public CLI, not its implementation API.
  const patchManifest = require.resolve("patch-package/package.json");
  const patchPackage = JSON.parse(readFileSync(patchManifest, "utf8"));
  if (patchPackage.name !== "patch-package" || patchPackage.version !== "8.0.1" ||
      patchPackage.bin !== "./index.js") {
    throw new Error("SDK dependency patch requires the pinned patch-package CLI");
  }
  const result = spawnSync(process.execPath, [resolve(dirname(patchManifest), patchPackage.bin),
    "--error-on-fail", "--patch-dir", patchDir], { cwd: installRoot, stdio: "inherit" });
  if (result.error) throw new Error("SDK dependency patch CLI could not start");
  process.exitCode = result.status ?? 1;
}

try { patchDependencies(); }
catch (error) {
  process.stderr.write(`context-mode: ${error instanceof Error ? error.message : "SDK dependency patch failed"}\n`);
  process.exitCode = 1;
}
