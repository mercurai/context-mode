import { expect, test } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PolyglotExecutor } from "../../src/executor.js";
import type { RuntimeMap } from "../../src/runtime.js";

test("configured compiler uses explicit owner context and cancellation prevents the run stage", async () => {
  const root = mkdtempSync(join(tmpdir(), "ctx-owned-compiler-"));
  const ready = join(root, "compiler.ready");
  const release = join(root, "compiler.release");
  const executed = join(root, "run-stage-executed");
  // A real Node process acts as a controllable compiler through the existing
  // RuntimeMap seam. The .rs input deliberately contains its fixture program.
  const runtimes: RuntimeMap = {
    javascript: process.execPath, typescript: null, python: null,
    shell: process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash",
    ruby: null, go: null, rust: process.execPath, php: null, perl: null,
    r: null, elixir: null, csharp: null,
  };
  const executor = new PolyglotExecutor({
    runtimes, projectRoot: root,
    environment: {
      HOME: root, USERPROFILE: root, CTX_SYNTHETIC_OWNER: "compiler-owner",
      PATH: process.env.PATH ?? process.env.Path ?? "",
      ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
    },
  });
  const controller = new AbortController();
  let readyResolve!: () => void;
  const readiness = new Promise<void>(resolve => { readyResolve = resolve; });
  const watcher = watch(root, () => { if (existsSync(ready)) readyResolve(); });
  const code = `
const fs = require("node:fs");
const release = ${JSON.stringify(release)};
let completed = false;
function finish() {
  if (completed || !fs.existsSync(release)) return;
  completed = true;
  watcher.close();
  const output = process.argv[process.argv.indexOf("-o") + 1];
  fs.writeFileSync(output, ${JSON.stringify(`#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(executed)}, "executed");\n`)});
  fs.chmodSync(output, 0o700);
}
const watcher = fs.watch(${JSON.stringify(root)}, finish);
fs.writeFileSync(${JSON.stringify(ready + ".writing")}, JSON.stringify({owner:process.env.CTX_SYNTHETIC_OWNER,cwd:process.cwd()}));
fs.renameSync(${JSON.stringify(ready + ".writing")}, ${JSON.stringify(ready)});
finish();
`;
  const running = executor.execute({ language: "rust", code, signal: controller.signal });
  try {
    // A configured-compiler failure is reported promptly, not hidden behind a
    // readiness timeout. The test runner bounds a broken compiler that hangs.
    await Promise.race([
      readiness,
      running.then(() => { throw new Error("Execution ended before the configured compiler became ready"); }),
    ]);
    expect(JSON.parse(readFileSync(ready, "utf8"))).toEqual({ owner: "compiler-owner", cwd: root });
    controller.abort();
    writeFileSync(release, "release");
    expect(await running).toMatchObject({ cancelled: true, timedOut: false, exitCode: 1 });
    expect(existsSync(executed)).toBe(false);
  } finally {
    watcher.close();
    controller.abort();
    writeFileSync(release, "release");
    await running;
    if (typeof executor.close === "function") await executor.close();
    rmSync(root, { recursive: true, force: true });
  }
});
