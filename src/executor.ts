import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  detectRuntimes,
  buildCommand,
  type RuntimeMap,
  type Language,
} from "./runtime.js";
export type { ExecResult } from "./types.js";
import type { ExecResult } from "./types.js";

const isWin = process.platform === "win32";

/**
 * Pure helper: extension map for temp script files per language.
 * On Windows, shell scripts usually get NO extension to avoid Windows
 * file-association for `.sh` (which spawns a visible Git Bash window over the
 * user's IDE). Windows PowerShell/pwsh is the exception because `-File`
 * requires `.ps1` there.
 */
const SCRIPT_EXT: Record<Language, string> = {
  javascript: "js",
  typescript: "ts",
  python: "py",
  shell: "sh",
  ruby: "rb",
  go: "go",
  rust: "rs",
  php: "php",
  perl: "pl",
  r: "R",
  elixir: "exs",
  csharp: "csx",
};

/** Pure helper — exported for unit testing. Returns "script" or "script.<ext>". */
export function buildScriptFilename(
  language: Language,
  platform: NodeJS.Platform,
  shellPath?: string | null,
): string {
  if (platform === "win32" && language === "shell") {
    const shellName = shellPath?.toLowerCase() ?? "";
    if (shellName.includes("powershell") || shellName.includes("pwsh")) return "script.ps1";
    const shellBase = shellName.split(/[\\/]/).pop() ?? shellName;
    if (shellBase === "cmd" || shellBase === "cmd.exe") return "script.cmd";
    return "script";
  }
  return `script.${SCRIPT_EXT[language]}`;
}

/**
 * Pure helper — exported for unit testing. Adds `windowsHide: true` on Windows
 * to prevent the spawned shell from creating a visible console window that
 * intercepts stdout (issue #384).
 */
export function buildSpawnOptions(platform: NodeJS.Platform): { windowsHide: boolean } {
  return { windowsHide: platform === "win32" };
}

function quoteForPosixShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Pure helper — exported for unit testing. Restores parent PATH after shell startup. */
export function buildShellScriptContent(
  code: string,
  inheritedPath: string | undefined,
  platform: NodeJS.Platform,
): string {
  if (platform === "win32" || !inheritedPath) return code;
  return `export PATH=${quoteForPosixShell(inheritedPath)}\n${code}`;
}

function isPowerShell(shellPath: string | null | undefined): boolean {
  const shellName = shellPath?.toLowerCase() ?? "";
  return shellName.includes("powershell") || shellName.includes("pwsh");
}

export function buildPowerShellScriptContent(code: string): string {
  // Prefix a UTF-8 BOM so Windows PowerShell 5.1 reliably detects the script
  // file as UTF-8 (without it, 5.1 falls back to the ANSI code page and
  // mangles non-ASCII characters in the script body).
  return [
    "\uFEFF[Console]::InputEncoding = [System.Text.UTF8Encoding]::new()",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()",
    "$OutputEncoding = [System.Text.UTF8Encoding]::new()",
    code,
  ].join("\n");
}

/**
 * Resolve the real OS temp directory, bypassing any TMPDIR env override.
 * os.tmpdir() reads TMPDIR from the environment, which some shells/tools
 * set to the project root — causing temp files to pollute the working tree.
 */
const OS_TMPDIR = (() => {
  if (isWin) return process.env.TEMP ?? process.env.TMP ?? tmpdir();
  try {
    const result = execFileSync(
      process.platform === "darwin" ? "getconf" : "mktemp",
      process.platform === "darwin" ? ["DARWIN_USER_TEMP_DIR"] : ["-u", "-d"],
      { env: { ...process.env, TMPDIR: undefined as unknown as string }, encoding: "utf-8" },
    ).trim();
    const dir = process.platform === "darwin" ? result : resolve(result, "..");
    if (dir && dir !== process.cwd()) return dir;
  } catch { /* fall through */ }
  return "/tmp";
})();

/**
 * Pure helper — exported for unit testing. Issue #782.
 *
 * On Windows, the sandbox shell runtime is Git Bash. A bare `mvn` invocation
 * runs Maven's POSIX shell script, which on the `mingw=true` branch (uname →
 * MINGW64_NT-*) fails to convert `CLASSWORLDS_JAR` from a POSIX path
 * (`/c/tools/maven/boot/plexus-classworlds-*.jar`) to a Windows path. Native
 * `java.exe` then can't resolve the bootstrap jar → ClassNotFoundException for
 * `org.codehaus.plexus.classworlds.launcher.Launcher`.
 *
 * The third-way fix (issue Option C): rewrite the bare `mvn` token to `mvn.cmd`,
 * the native Windows launcher that uses Windows-native paths and bypasses the
 * broken mingw shell branch entirely. This does NOT touch the global MSYS
 * path-conversion env (MSYS_NO_PATHCONV / MSYS2_ARG_CONV_EXCL), which #826/#791
 * deliberately leave unset so native git.exe launched from bash keeps its
 * /tmp→C:\ argument conversion. Re-enabling global suppression would re-break
 * native git; rewriting only the mvn token keeps both correct.
 *
 * Only a `mvn` that starts a command (start of string, or after a shell
 * separator `&& | ; ( newline`) is rewritten. `mvnw`, `mvnd`, `mymvn`,
 * paths like `./mvnw`, and an already-`mvn.cmd` token are left untouched
 * (the token must be exactly `mvn` followed by whitespace or end-of-string).
 */
export function rewriteWindowsBuildTools(
  code: string,
  platform: NodeJS.Platform,
): string {
  if (platform !== "win32") return code;
  // Rewrite a bare `mvn` command token to `mvn.cmd` (Maven's native Windows launcher).
  // Algorithmic (no regex): only at a command-start position (string start or right
  // after a shell separator ; & | ( newline, skipping leading spaces/tabs) and only
  // when the token is exactly `mvn` followed by whitespace or end — leaves
  // mvnw / mvnd / ./mvnw / already-mvn.cmd untouched.
  const SEP = new Set([";", "&", "|", "(", "\n"]);
  let out = "";
  let atStart = true;
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (atStart && (ch === " " || ch === "\t")) {
      out += ch;
      i++;
      continue;
    }
    if (atStart && code.startsWith("mvn", i)) {
      const after = code[i + 3];
      if (after === undefined || after === " " || after === "\t" || after === "\n") {
        out += "mvn.cmd";
        i += 3;
        atStart = false;
        continue;
      }
    }
    out += ch;
    atStart = SEP.has(ch);
    i++;
  }
  return out;
}

/**
 * Remove a sandbox temp dir, retrying on Windows. Issue #788.
 *
 * On Windows, a child process that opened SQLite databases inside the sandbox
 * can leave `*-wal` / `*-shm` files with handles that linger briefly after the
 * process exits. A single `rmSync` then throws EBUSY/EPERM/ENOTEMPTY and the
 * old silent `catch {}` swallowed it, leaking `.ctx-mode-*` directories under
 * `%TEMP%`. Node's `rmSync({ maxRetries, retryDelay })` is purpose-built for
 * exactly this Windows-handle race, so let it back off and retry.
 */
function cleanupTmpDir(tmpDir: string): void {
  try {
    rmSync(tmpDir, {
      recursive: true,
      force: true,
      maxRetries: isWin ? 8 : 2,
      retryDelay: 100,
    });
  } catch {
    /* best-effort — OS will reclaim %TEMP% eventually */
  }
}

/** Kill process tree — on Windows uses taskkill /T; on Unix kills the process group. */
function killTree(proc: ReturnType<typeof spawn>): void {
  // POSIX descendants can retain the owned group and pipes after their leader
  // exits. Callers retire that ownership on close, not on the leader's exit.
  // Windows taskkill cannot recover a tree after its leader exits; shared
  // Windows execution requires the harness JobObject runner for that case.
  if (isWin && (proc.exitCode !== null || proc.signalCode !== null)) return;
  if (isWin && proc.pid) {
    try {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(proc.pid)], { stdio: "pipe", windowsHide: true });
    } catch { /* already dead */ }
  } else if (proc.pid) {
    try {
      // Kill entire process group (negative PID) to prevent orphaned children
      process.kill(-proc.pid, "SIGKILL");
    } catch { /* already dead */ }
  }
}

interface ExecuteOptions {
  language: Language;
  code: string;
  timeout?: number;
  /** Keep process running after timeout instead of killing it. */
  background?: boolean;
  /** Cancels only this execution, including a job already returned as backgrounded. */
  signal?: AbortSignal;
  /**
   * Per-call working directory. The script itself stays in a private temporary
   * directory; execution and relative executeFile paths use this workspace.
   */
  cwd?: string;
}

interface ExecuteFileOptions extends ExecuteOptions {
  path: string;
}

interface SpawnContext {
  environment: Readonly<NodeJS.ProcessEnv>;
  timeout?: number;
  background?: boolean;
  signal?: AbortSignal;
}

interface OwnedJob {
  backgrounded: boolean;
  cancel: () => void;
  closed: Promise<void>;
}

function cancelledResult(): ExecResult {
  return { stdout: "", stderr: "Execution cancelled", exitCode: 1, timedOut: false, cancelled: true };
}

export class PolyglotExecutor {
  #hardCapBytes: number;
  /**
   * Resolves the project root on every access. Stored as a thunk so the
   * executor stays in sync with server-side env-cascade resolvers (e.g.
   * `getProjectDir` in server.ts) instead of capturing a snapshot of
   * `CLAUDE_PROJECT_DIR` at construction time. String inputs are wrapped
   * to preserve constructor backward compatibility.
   */
  #projectRootResolver: () => string;
  #runtimes: RuntimeMap;
  #environment?: Readonly<NodeJS.ProcessEnv>;
  #jobs = new Set<OwnedJob>();
  #closed = false;

  constructor(opts?: {
    hardCapBytes?: number;
    projectRoot?: string | (() => string);
    runtimes?: RuntimeMap;
    /** Explicit owner environment. Omitted preserves legacy per-call inheritance. */
    environment?: Readonly<NodeJS.ProcessEnv>;
  }) {
    this.#hardCapBytes = opts?.hardCapBytes ?? 100 * 1024 * 1024; // 100MB
    const pr = opts?.projectRoot;
    if (typeof pr === "function") {
      this.#projectRootResolver = pr;
    } else if (typeof pr === "string") {
      this.#projectRootResolver = () => pr;
    } else {
      this.#projectRootResolver = () => process.cwd();
    }
    this.#runtimes = { ...(opts?.runtimes ?? detectRuntimes()) };
    if (opts?.environment !== undefined) this.#environment = Object.freeze({ ...opts.environment });
  }

  get #projectRoot(): string {
    return this.#projectRootResolver();
  }

  get runtimes(): RuntimeMap {
    return { ...this.#runtimes };
  }

  /** Kill all backgrounded processes to prevent zombie/port-conflict issues. */
  cleanupBackgrounded(): void {
    for (const job of this.#jobs) {
      if (job.backgrounded) job.cancel();
    }
  }

  /** Stop this owner's jobs and wait for their process handles to close. */
  async close(): Promise<void> {
    this.#closed = true;
    const jobs = [...this.#jobs];
    for (const job of jobs) job.cancel();
    await Promise.all(jobs.map(job => job.closed));
  }

  async execute(opts: ExecuteOptions): Promise<ExecResult> {
    const { language, code, timeout, background = false, signal, cwd: cwdOverride } = opts;
    if (this.#closed || signal?.aborted) return cancelledResult();
    const cwd = cwdOverride ?? this.#projectRoot;
    const environment = this.#environment ?? { ...process.env };
    const tmpDir = mkdtempSync(join(OS_TMPDIR, ".ctx-mode-"));

    try {
      const filePath = this.#writeScript(tmpDir, code, language, { cwd, environment });
      const cmd = buildCommand(this.#runtimes, language, filePath);

      // Every language runs in the project directory so git, relative paths,
      // and other project-aware tools resolve naturally. The script FILE lives
      // in the sandbox tmpDir and is passed to the runtime by absolute path
      // (see buildCommand), so cwd is free to be the project root.
      //
      // Issue #788 — previously only `shell` used the project root; non-shell
      // runtimes (python/js/ts/…) used tmpDir, so repo-relative checks like
      // `pathlib.Path("package.json").exists()` silently failed depending on
      // the chosen language. Unifying cwd removes that surprise.
      // Issue #45 — `cwdOverride` lets per-call sites (Codex MCP handlers) pin
      // cwd without mutating process-wide state.
      const context = { timeout, background, signal, environment };
      const result = cmd[0] === "__rust_compile_run__"
        ? await this.#compileAndRun(filePath, cwd, tmpDir, context)
        : await this.#spawn(cmd, cwd, tmpDir, context);

      // Skip tmpDir cleanup if process was backgrounded — it may still need files
      if (!result.backgrounded) {
        cleanupTmpDir(tmpDir);
      }

      return result;
    } catch (err) {
      cleanupTmpDir(tmpDir);
      throw err;
    }
  }

  async executeFile(opts: ExecuteFileOptions): Promise<ExecResult> {
    const { path: filePath, language, code, cwd = this.#projectRoot, ...execution } = opts;
    if (this.#closed || execution.signal?.aborted) return cancelledResult();
    const absolutePath = resolve(cwd, filePath);
    const wrappedCode = this.#wrapWithFileContent(
      absolutePath,
      language,
      code,
    );
    return this.execute({ ...execution, language, code: wrappedCode, cwd });
  }

  #writeScript(tmpDir: string, code: string, language: Language, context: { cwd: string; environment: Readonly<NodeJS.ProcessEnv> }): string {
    // Go needs a main package wrapper if not present
    if (language === "go" && !code.includes("package ")) {
      code = `package main\n\nimport "fmt"\n\nfunc main() {\n${code}\n}\n`;
    }

    // PHP needs opening tag if not present
    if (language === "php" && !code.trimStart().startsWith("<?")) {
      code = `<?php\n${code}`;
    }

    // Elixir: prepend compiled BEAM paths when inside a Mix project
    if (language === "elixir" && existsSync(join(context.cwd, "mix.exs"))) {
      const escaped = JSON.stringify(join(context.cwd, "_build/dev/lib"));
      code = `Path.wildcard(Path.join(${escaped}, "*/ebin"))\n|> Enum.each(&Code.prepend_path/1)\n\n${code}`;
    }

    const fp = join(
      tmpDir,
      buildScriptFilename(
        language,
        process.platform,
        language === "shell" ? this.#runtimes.shell : null,
      ),
    );
    if (language === "shell") {
      const shellPath = this.#runtimes.shell;
      // #782 — on Windows Git Bash, rewrite bare `mvn` → `mvn.cmd` so Maven
      // uses its native Windows launcher (correct path handling) instead of
      // the broken mingw shell branch. No-op on non-Windows.
      const rewritten = rewriteWindowsBuildTools(code, process.platform);
      const shellCode = isWin && isPowerShell(shellPath)
        ? buildPowerShellScriptContent(rewritten)
        : rewritten;
      writeFileSync(
        fp,
        buildShellScriptContent(shellCode, context.environment.PATH, process.platform),
        { encoding: "utf-8", mode: 0o700 },
      );
    } else {
      writeFileSync(fp, code, "utf-8");
    }
    return fp;
  }

  async #compileAndRun(
    srcPath: string,
    cwd: string,
    tmpDir: string,
    context: SpawnContext,
  ): Promise<ExecResult> {
    const binSuffix = isWin ? ".exe" : "";
    const binPath = srcPath.replace(/\.rs$/, "") + binSuffix;

    // Compile — cap rustc invocation at 60s when caller didn't bound the
    // overall timeout (a hung compile shouldn't run forever even if the
    // caller is fine with a long-running binary afterwards).
    const compiler = this.#runtimes.rust;
    if (!compiler) throw new Error("Rust runtime is unavailable");
    const compiled = await this.#spawn([compiler, srcPath, "-o", binPath], cwd, tmpDir, {
      ...context,
      background: false,
      timeout: context.timeout === undefined ? 60_000 : Math.min(context.timeout, 60_000),
    });
    if (compiled.cancelled) return compiled;
    if (compiled.exitCode !== 0) {
      return { ...compiled, stderr: `Compilation failed:\n${compiled.stderr}` };
    }

    // Run
    return this.#spawn([binPath], cwd, tmpDir, context);
  }

  async #spawn(
    cmd: string[],
    cwd: string,
    sandboxTmpDir: string,
    context: SpawnContext,
  ): Promise<ExecResult> {
    const { timeout, background = false, signal } = context;
    if (this.#closed || signal?.aborted) return cancelledResult();
    return new Promise((res) => {
      // Only .cmd/.bat shims need shell on Windows; real executables don't.
      // Using shell: true globally causes process-tree kill issues with MSYS2/Git Bash.
      // "bun" is included as defense-in-depth: bunCommand() prefers absolute
      // .exe paths now (#506), but if it falls back to the bare "bun" string
      // on Windows that resolution typically goes through a `bun.cmd` shim
      // (npm i -g bun) which CreateProcess can't execute without cmd.exe.
      const needsShell = isWin && ["tsx", "ts-node", "elixir", "bun", "dotnet-script"].includes(cmd[0]);

      // On Windows with Git Bash, pass the script as `bash -c "source /posix/path"`
      // rather than `bash /path/to/script.sh`. This avoids MSYS2 path mangling
      // while still allowing MSYS_NO_PATHCONV to protect non-ASCII paths in commands.
      let spawnCmd = cmd[0];
      let spawnArgs: string[];
      if (isWin && cmd.length === 2 && cmd[1]) {
        const posixPath = cmd[1].replace(/\\/g, "/");
        spawnArgs = [posixPath];
      } else {
        spawnArgs = isWin
          ? cmd.slice(1).map(a => a.replace(/\\/g, "/"))
          : cmd.slice(1);
      }

      // Common options shared by both spawn variants below.
      const commonOpts = {
        cwd,
        stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
        env: this.#buildSafeEnv(sandboxTmpDir, context.environment),
        // On Unix, create a new process group so killTree can kill all children
        detached: !isWin,
        // Hide the spawned-process console window on Windows. Without this,
        // child_process.spawn creates a visible window that intercepts stdout,
        // leaving the MCP response empty and popping a Git Bash terminal over
        // the user's IDE. Issue #384.
        ...buildSpawnOptions(process.platform),
      };

      // DEP0190 fix: when shell is true (Windows .cmd/.bat shims), pass a
      // single command string instead of cmd + args array. Node.js warns
      // that args are unsafely concatenated when shell:true is combined with
      // the args-array form of spawn(). Colllapsing to a string avoids the
      // warning while preserving the same shell behavior.
      let proc: ReturnType<typeof spawn>;
      if (needsShell) {
        const fullCmd = [spawnCmd, ...spawnArgs]
          .map(a => /\s/.test(a) ? JSON.stringify(a) : a)
          .join(" ");
        proc = spawn(fullCmd, [], { ...commonOpts, shell: true });
      } else {
        proc = spawn(spawnCmd, spawnArgs, { ...commonOpts, shell: false });
      }

      let timedOut = false;
      let resolved = false;
      let cancelled = false;
      let closed = false;
      let finishClosed!: () => void;
      const job: OwnedJob = {
        backgrounded: false,
        closed: new Promise<void>(resolve => { finishClosed = resolve; }),
        cancel: () => {
          if (cancelled || closed || (isWin && (proc.exitCode !== null || proc.signalCode !== null))) return;
          cancelled = true;
          killTree(proc);
        },
      };
      this.#jobs.add(job);
      const abort = () => job.cancel();
      signal?.addEventListener("abort", abort, { once: true });
      // Registration and spawning are synchronous, but callers can provide a
      // signal that became aborted while a subprocess was being created.
      if (signal?.aborted) abort();
      // Issue #406 — if the caller didn't pass a timeout we don't fire one.
      // Timeout policy belongs to the MCP host/client (Claude Code, VSCode,
      // JetBrains all enforce their own RPC timeouts); imposing a second
      // policy here turned 30-minute Gradle/Maven/SBT builds into spurious
      // false negatives whenever the caller forgot the explicit value.
      const timer: NodeJS.Timeout | undefined = timeout === undefined ? undefined : setTimeout(() => {
        if (cancelled || closed || (isWin && (proc.exitCode !== null || proc.signalCode !== null))) return;
        timedOut = true;
        if (background) {
          // Background mode: detach process, return partial output, keep running
          resolved = true;
          job.backgrounded = true;
          proc.unref();
          // Do NOT destroy stdout/stderr — closing the read end of the pipe
          // sends SIGPIPE to the child on its next write, killing it.
          // Instead, replace the data listeners with no-op drains that
          // consume the stream without accumulating buffers. This keeps
          // the pipe open and prevents the child from blocking on a full
          // pipe buffer.
          if (proc.stdout) {
            proc.stdout.removeAllListeners("data");
            proc.stdout.on("data", () => {});
          }
          if (proc.stderr) {
            proc.stderr.removeAllListeners("data");
            proc.stderr.on("data", () => {});
          }
          const rawStdout = Buffer.concat(stdoutChunks).toString("utf-8");
          const rawStderr = Buffer.concat(stderrChunks).toString("utf-8");
          res({
            stdout: rawStdout,
            stderr: rawStderr,
            exitCode: 0,
            timedOut: true,
            backgrounded: true,
          });
        } else {
          killTree(proc);
        }
      }, timeout);

      // Stream-level byte cap: kill the process once combined stdout+stderr
      // exceeds hardCapBytes. Without this, a command like `yes` or
      // `cat /dev/urandom | base64` can accumulate gigabytes in memory
      // before the timeout fires.
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let totalBytes = 0;
      let capExceeded = false;

      proc.stdout!.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes <= this.#hardCapBytes) {
          stdoutChunks.push(chunk);
        } else if (!capExceeded) {
          capExceeded = true;
          killTree(proc);
        }
      });

      proc.stderr!.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes <= this.#hardCapBytes) {
          stderrChunks.push(chunk);
        } else if (!capExceeded) {
          capExceeded = true;
          killTree(proc);
        }
      });

      proc.on("close", (exitCode) => {
        closed = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.#jobs.delete(job);
        if (job.backgrounded) cleanupTmpDir(sandboxTmpDir);
        finishClosed();
        if (resolved) return; // Already resolved by background timeout
        resolved = true;
        const rawStdout = Buffer.concat(stdoutChunks).toString("utf-8");
        let rawStderr = Buffer.concat(stderrChunks).toString("utf-8");

        if (capExceeded) {
          rawStderr += `\n[output capped at ${(this.#hardCapBytes / 1024 / 1024).toFixed(0)}MB — process killed]`;
        }

        const stdout = rawStdout;
        const stderr = rawStderr;

        res({
          stdout,
          stderr,
          exitCode: timedOut || cancelled ? 1 : (exitCode ?? 1),
          timedOut,
          ...(cancelled ? { cancelled: true } : {}),
        });
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        if (resolved) return; // Already resolved by background timeout
        resolved = true;
        res({
          stdout: "",
          stderr: err.message,
          exitCode: 1,
          timedOut: false,
          ...(cancelled ? { cancelled: true } : {}),
        });
      });
    });
  }

  #buildSafeEnv(tmpDir: string, source: Readonly<NodeJS.ProcessEnv>): Record<string, string> {
    const realHome = source.HOME ?? source.USERPROFILE ?? tmpDir;

    // Denylist: env vars that corrupt sandbox stdout, inject code, or break
    // language runtimes. Each entry is backed by CVE, MITRE, or live testing.
    // See: https://www.elttam.com/blog/env/, MITRE T1574.006
    const DENIED = new Set([
      // Shell — auto-execute scripts, override builtins
      "BASH_ENV",             // sourced by non-interactive bash
      "ENV",                  // sourced by sh/dash
      "PROMPT_COMMAND",       // runs before each prompt
      "PS4",                  // $(cmd) expansion in xtrace
      "SHELLOPTS",            // enables xtrace/verbose, dumps to stdout
      "BASHOPTS",             // bash-specific shell options
      "CDPATH",               // makes cd print to stdout
      "INPUTRC",              // readline key rebinding
      "BASH_XTRACEFD",        // redirects debug output to stdout
      // Node.js — require injection, inspector
      "NODE_OPTIONS",         // --require, --loader, --inspect
      "NODE_PATH",            // module search path injection
      // Python — stdlib override, startup injection
      "PYTHONSTARTUP",        // auto-executes in interactive mode
      "PYTHONHOME",           // overrides stdlib location (breaks Python)
      "PYTHONWARNINGS",       // triggers module import chain → RCE
      "PYTHONBREAKPOINT",     // arbitrary callable
      "PYTHONINSPECT",        // enters interactive mode after script
      // Ruby — option/module injection
      "RUBYOPT",              // injects CLI options (-r loads files)
      "RUBYLIB",              // module search path injection
      // Perl — option/module injection
      "PERL5OPT",             // injects CLI options (-M runs code)
      "PERL5LIB",             // module search path injection
      "PERLLIB",              // legacy module search path
      "PERL5DB",              // debugger command injection
      // Elixir/Erlang — eval injection
      "ERL_AFLAGS",           // prepends erl flags (-eval runs code)
      "ERL_FLAGS",            // appends erl flags
      "ELIXIR_ERL_OPTIONS",   // Elixir-specific erl flags
      "ERL_LIBS",             // beam file loading
      // Go — compiler/linker injection
      "GOFLAGS",              // injects go command flags
      "CGO_CFLAGS",           // C compiler flag injection
      "CGO_LDFLAGS",          // linker flag injection
      // Rust — compiler substitution
      "RUSTC",                // arbitrary compiler binary
      "RUSTC_WRAPPER",        // compiler wrapper injection
      "RUSTC_WORKSPACE_WRAPPER",
      "CARGO_BUILD_RUSTC",
      "CARGO_BUILD_RUSTC_WRAPPER",
      "RUSTFLAGS",            // compiler flag injection
      // PHP — config injection
      "PHPRC",                // auto_prepend_file → RCE
      "PHP_INI_SCAN_DIR",     // additional .ini loading
      // R — startup script injection
      "R_PROFILE",            // site-wide R profile
      "R_PROFILE_USER",       // user R profile
      "R_HOME",               // R installation override
      // .NET / C# — runtime/startup hooks, additional deps
      "DOTNET_STARTUP_HOOKS",       // injects managed assemblies on startup
      "DOTNET_ADDITIONAL_DEPS",     // additional .deps.json injection
      "DOTNET_SHARED_STORE",        // shared assembly probe path injection
      "DOTNET_ROOT",                // arbitrary .NET runtime override
      "DOTNET_ROOT(x86)",           // 32-bit override
      "DOTNET_HOST_PATH",           // host binary substitution
      // .NET / C# — profiler attach (loads arbitrary DLL into dotnet host)
      // and IPC-based debugger/IL injection. PR #546 follow-up.
      // learn.microsoft.com/en-us/dotnet/core/runtime-config/debugging-profiling
      "CORECLR_PROFILER",                 // CLSID of profiler to attach
      "CORECLR_PROFILER_PATH",            // path to profiler DLL
      "CORECLR_PROFILER_PATH_32",         // 32-bit specific profiler DLL
      "CORECLR_PROFILER_PATH_64",         // 64-bit specific profiler DLL
      "CORECLR_PROFILER_PATH_ARM32",      // ARM32 specific profiler DLL
      "CORECLR_PROFILER_PATH_ARM64",      // ARM64 specific profiler DLL
      "CORECLR_ENABLE_PROFILING",         // gates profiler load
      "DOTNET_PROFILER_PATH",             // cross-platform alias
      "DOTNET_PROFILER_PATH_32",
      "DOTNET_PROFILER_PATH_64",
      "DOTNET_PROFILER_PATH_ARM32",
      "DOTNET_PROFILER_PATH_ARM64",
      "DOTNET_DiagnosticPorts",           // peer attach via diagnostic IPC
      "DOTNET_BUNDLE_EXTRACT_BASE_DIR",   // single-file extraction hijack
      // Dynamic linker — shared library injection
      "LD_PRELOAD",           // loads .so before all others (Linux)
      "DYLD_INSERT_LIBRARIES", // macOS equivalent of LD_PRELOAD
      // OpenSSL — engine loading
      "OPENSSL_CONF",         // loads engine modules → .so exec
      "OPENSSL_ENGINES",      // engine directory override
      // Compiler — binary substitution
      "CC",                   // C compiler override
      "CXX",                  // C++ compiler override
      "AR",                   // archiver override
      // Git — command injection via hooks/config
      "GIT_TEMPLATE_DIR",     // hook injection on git init
      "GIT_CONFIG_GLOBAL",    // core.pager/editor runs commands
      "GIT_CONFIG_SYSTEM",    // system-level config injection
      "GIT_EXEC_PATH",        // substitute git subcommands
      "GIT_SSH",              // arbitrary command instead of ssh
      "GIT_SSH_COMMAND",      // arbitrary ssh command
      "GIT_ASKPASS",          // arbitrary credential command
    ]);

    // Start with parent env, then strip dangerous vars and apply overrides.
    // The `COMPlus_` prefix sweep covers every COMPlus_* synonym of the
    // DOTNET_* runtime knobs (.NET back-compat alias — case-insensitive).
    // PR #546 follow-up: closes the alias bypass for the explicit denylist
    // entries above.
    const env: Record<string, string> = {};
    for (const [key, val] of Object.entries(source)) {
      if (
        val !== undefined &&
        !DENIED.has(key) &&
        !key.startsWith("BASH_FUNC_") &&
        !/^COMPlus_/i.test(key)
      ) {
        env[key] = val;
      }
    }

    // Sandbox overrides — forced values for correct sandbox behavior
    env["TMPDIR"] = tmpDir;
    env["HOME"] = realHome;
    env["LANG"] = "en_US.UTF-8";
    env["PYTHONDONTWRITEBYTECODE"] = "1";
    env["PYTHONUNBUFFERED"] = "1";
    env["PYTHONUTF8"] = "1";
    env["NO_COLOR"] = "1";
    // Windows uses "Path" (not "PATH") — normalize to "PATH" for consistency
    if (isWin && !env["PATH"] && env["Path"]) {
      env["PATH"] = env["Path"];
      delete env["Path"];
    }
    if (!env["PATH"]) {
      env["PATH"] = isWin ? "" : "/usr/local/bin:/usr/bin:/bin";
    }

    // Windows-critical PATH fixes.
    if (isWin) {
      // Do not carry global MSYS path-conversion blockers into Git Bash.
      // Native Windows tools launched from bash (notably git.exe) need MSYS
      // to convert /tmp-style arguments to Windows paths so sibling tools see
      // the same filesystem location (#791).
      for (const key of Object.keys(env)) {
        const upper = key.toUpperCase();
        if (upper === "MSYS_NO_PATHCONV" || upper === "MSYS2_ARG_CONV_EXCL") {
          delete env[key];
        }
      }

      const gitUsrBin = "C:\\Program Files\\Git\\usr\\bin";
      const gitBin = "C:\\Program Files\\Git\\bin";
      if (!env["PATH"].includes(gitUsrBin)) {
        env["PATH"] = `${gitUsrBin};${gitBin};${env["PATH"]}`;
      }
    }

    // Ensure SSL_CERT_FILE is set so Python/Ruby HTTPS works in sandbox.
    if (!env["SSL_CERT_FILE"]) {
      const certPaths = isWin ? [] : [
        "/etc/ssl/cert.pem",                         // macOS, some Linux
        "/etc/ssl/certs/ca-certificates.crt",         // Debian/Ubuntu/Alpine
        "/etc/pki/tls/certs/ca-bundle.crt",           // RHEL/CentOS/Fedora
        "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem", // Fedora alt
      ];
      for (const p of certPaths) {
        if (existsSync(p)) {
          env["SSL_CERT_FILE"] = p;
          break;
        }
      }
    }

    return env;
  }

  #wrapWithFileContent(
    absolutePath: string,
    language: Language,
    code: string,
  ): string {
    const escaped = JSON.stringify(absolutePath);
    switch (language) {
      case "javascript":
      case "typescript":
        return `const FILE_CONTENT_PATH = ${escaped};\nconst file_path = FILE_CONTENT_PATH;\nconst FILE_CONTENT = require("fs").readFileSync(FILE_CONTENT_PATH, "utf-8");\n${code}`;
      case "python":
        return `FILE_CONTENT_PATH = ${escaped}\nfile_path = FILE_CONTENT_PATH\nwith open(FILE_CONTENT_PATH, "r", encoding="utf-8") as _f:\n    FILE_CONTENT = _f.read()\n${code}`;
      case "shell": {
        // Single-quote the path to prevent $, backtick, and ! expansion
        const sq = "'" + absolutePath.replace(/'/g, "'\\''") + "'";
        return `FILE_CONTENT_PATH=${sq}\nfile_path=${sq}\nFILE_CONTENT=$(cat ${sq})\n${code}`;
      }
      case "ruby":
        return `FILE_CONTENT_PATH = ${escaped}\nfile_path = FILE_CONTENT_PATH\nFILE_CONTENT = File.read(FILE_CONTENT_PATH, encoding: "utf-8")\n${code}`;
      case "go":
        return `package main\n\nimport (\n\t"fmt"\n\t"os"\n)\n\nvar FILE_CONTENT_PATH = ${escaped}\nvar file_path = FILE_CONTENT_PATH\n\nfunc main() {\n\tb, _ := os.ReadFile(FILE_CONTENT_PATH)\n\tFILE_CONTENT := string(b)\n\t_ = FILE_CONTENT\n\t_ = fmt.Sprint()\n${code}\n}\n`;
      case "rust":
        return `#![allow(unused_variables)]\nuse std::fs;\n\nfn main() {\n    let file_content_path = ${escaped};\n    let file_path = file_content_path;\n    let file_content = fs::read_to_string(file_content_path).unwrap();\n${code}\n}\n`;
      case "php":
        return `<?php\n$FILE_CONTENT_PATH = ${escaped};\n$file_path = $FILE_CONTENT_PATH;\n$FILE_CONTENT = file_get_contents($FILE_CONTENT_PATH);\n${code}`;
      case "perl":
        return `my $FILE_CONTENT_PATH = ${escaped};\nmy $file_path = $FILE_CONTENT_PATH;\nopen(my $fh, '<:encoding(UTF-8)', $FILE_CONTENT_PATH) or die "Cannot open: $!";\nmy $FILE_CONTENT = do { local $/; <$fh> };\nclose($fh);\n${code}`;
      case "r":
        return `FILE_CONTENT_PATH <- ${escaped}\nfile_path <- FILE_CONTENT_PATH\nFILE_CONTENT <- readLines(FILE_CONTENT_PATH, warn=FALSE, encoding="UTF-8")\nFILE_CONTENT <- paste(FILE_CONTENT, collapse="\\n")\n${code}`;
      case "elixir":
        return `file_content_path = ${escaped}\nfile_path = file_content_path\nfile_content = File.read!(file_content_path)\n${code}`;
      case "csharp":
        // .csx forbids `using` directives after any other top-level statement
        // (CS1529). User code inside executeFile must use fully-qualified type
        // names (e.g. `System.Text.Json.JsonDocument`) instead of `using`.
        return `var FILE_CONTENT_PATH = ${escaped};\nvar file_path = FILE_CONTENT_PATH;\nvar FILE_CONTENT = System.IO.File.ReadAllText(FILE_CONTENT_PATH);\n${code}`;
    }
  }
}
