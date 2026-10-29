import { expect, test } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { PolyglotExecutor } from "../../src/executor.js";
import type { RuntimeMap } from "../../src/runtime.js";

const compiler = process.env.CONTEXT_MODE_TEST_RUSTC;

test.runIf(compiler)("real Rust compilation and execution retain explicit owner context and clean the sandbox", async () => {
  // The admitted test coordinator resolves and verifies the actual compiler
  // first. A rustup shim with a fixture HOME is not the underlying toolchain.
  expect(compiler, "set CONTEXT_MODE_TEST_RUSTC to a verified absolute rustc executable").toBeDefined();
  expect(isAbsolute(compiler!)).toBe(true);
  const root = mkdtempSync(join(tmpdir(), "ctx-owned-real-rust-"));
  writeFileSync(join(root, "input.txt"), "workspace-input");
  const runtimes: RuntimeMap = {
    javascript: process.execPath, typescript: null, python: null,
    shell: process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash",
    ruby: null, go: null, rust: compiler!, php: null, perl: null,
    r: null, elixir: null, csharp: null,
  };
  const owner = new PolyglotExecutor({
    runtimes, projectRoot: root,
    environment: {
      HOME: root, USERPROFILE: root, CTX_SYNTHETIC_OWNER: "rust-owner",
      PATH: process.env.PATH ?? process.env.Path ?? "",
      ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
    },
  });
  try {
    const result = await owner.execute({
      language: "rust",
      code: `
fn main() {
    println!("compile={}", option_env!("CTX_SYNTHETIC_OWNER").unwrap_or("missing"));
    println!("run={}", std::env::var("CTX_SYNTHETIC_OWNER").unwrap());
    println!("file={}", std::fs::read_to_string("input.txt").unwrap());
    println!("tmp={}", std::env::temp_dir().display());
}
`,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.cancelled).not.toBe(true);
    const lines = result.stdout.trim().split(/\r?\n/);
    expect(lines.slice(0, 3)).toEqual(["compile=rust-owner", "run=rust-owner", "file=workspace-input"]);
    expect(lines[3]).toMatch(/^tmp=.+/);
    expect(existsSync(lines[3].slice(4))).toBe(false);
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});
