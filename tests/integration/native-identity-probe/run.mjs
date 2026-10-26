// Runs the installed native Claude Code / Codex clients against the synthetic probe server and prints a redacted
// receipt (versions, key names, aliased identities, booleans, counts). Foreground and sequential; stops only its own
// server and children. Usage: node run.mjs [--client claude|codex|all] [--hook-type http|command] [--dry-run]
// Every client call is a real model turn with a one-line synthetic prompt.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProbeServer } from "./server.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const dryRun = args.includes("--dry-run");
const which = option("--client", "all");
const hookType = option("--hook-type", "http");
const codexBin = option("--codex-bin", "codex");
const TIMEOUT_MS = Number(option("--timeout-s", "240")) * 1000;
const PROMPT_FOR = {};
const PROMPT = "Call the mcp__probe__identity_echo tool exactly once with no arguments, then reply with the single word done.";
const CODEX_PROMPT = "Call the identity_echo tool of the probe MCP server exactly once with no arguments, then reply with the single word done.";
PROMPT_FOR.claude = PROMPT;
PROMPT_FOR.codex = CODEX_PROMPT;
const CHILD_PROMPT = "First call the identity_echo tool of the probe MCP server yourself, once, with no arguments. Then launch exactly one subagent whose only task is to call the same identity_echo tool once with no arguments. Reply with the single word done.";

const version = (command) => spawnSync(command, ["--version"], { encoding: "utf8" }).stdout?.trim() ?? "unavailable";
const binary = (client) => (client === "codex" ? codexBin : client);

function claudeFiles(dir, port) {
  const mcp = join(dir, "claude-mcp.json");
  writeFileSync(mcp, JSON.stringify({ mcpServers: { probe: { type: "http", url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: "Bearer ${PROBE_CAP}" } } } }));
  const hook =
    hookType === "command"
      ? { type: "command", command: `curl -sS --max-time 10 -H "Authorization: Bearer $PROBE_CAP" -H 'content-type: application/json' --data-binary @- http://127.0.0.1:${port}/hook` }
      : { type: "http", url: `http://127.0.0.1:${port}/hook`, headers: { Authorization: "Bearer $PROBE_CAP" }, allowedEnvVars: ["PROBE_CAP"] };
  const settings = join(dir, "claude-settings.json");
  writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "mcp__probe__.*", hooks: [hook] }] } }));
  return { mcp, settings };
}

const claudeArgs = ({ mcp, settings }, prompt, extra = []) => [
  "-p", prompt, "--output-format", "json", "--strict-mcp-config", "--mcp-config", mcp, "--settings", settings,
  "--setting-sources", "project", "--allowedTools", "mcp__probe__identity_echo,Task,Agent", ...extra,
];

const codexArgs = (port, dir, prompt, resumeId) => {
  const config = ["-c", `mcp_servers.probe.url="http://127.0.0.1:${port}/mcp"`, "-c", 'mcp_servers.probe.bearer_token_env_var="PROBE_CAP"'];
  const common = ["--json", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", ...config];
  // `exec resume` takes no sandbox flag: the resumed session keeps the one it was created with.
  return resumeId
    ? ["exec", "resume", ...common, resumeId, prompt]
    : ["exec", "-C", dir, "-s", "read-only", ...common, prompt];
};

function plan(port = "<port>", dir = "<tmp>") {
  const files = { mcp: `${dir}/claude-mcp.json`, settings: `${dir}/claude-settings.json` };
  return [
    ["claude", "root-A", claudeArgs(files, PROMPT)],
    ["claude", "root-B", claudeArgs(files, PROMPT)],
    ["claude", "resume-A", claudeArgs(files, PROMPT, ["--resume", "<session-A>"])],
    ["claude", "child", claudeArgs(files, CHILD_PROMPT)],
    ["codex", "root-A", codexArgs(port, dir, CODEX_PROMPT)],
    ["codex", "root-B", codexArgs(port, dir, CODEX_PROMPT)],
    ["codex", "resume-A", codexArgs(port, dir, CODEX_PROMPT, "<thread-A>")],
    ["codex", "child", codexArgs(port, dir, CHILD_PROMPT)],
    ["claude", "concurrent-1 and concurrent-2 (together)", claudeArgs(files, PROMPT)],
    ["codex", "concurrent-1 and concurrent-2 (together)", codexArgs(port, dir, CODEX_PROMPT)],
  ].filter(([client]) => which === "all" || which === client);
}

function runClient(command, argv, env, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", () => {});
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, stdout });
    });
  });
}

// Native ids are read from client output in memory only, to drive resume; they are never printed.
function nativeId(client, stdout) {
  if (client === "claude") {
    try {
      const events = JSON.parse(stdout);
      return (Array.isArray(events) ? events : [events]).find((event) => event?.session_id)?.session_id;
    } catch { return undefined; }
  }
  for (const line of stdout.split("\n")) {
    try {
      const event = JSON.parse(line);
      if (event.type === "thread.started" && event.thread_id) return event.thread_id;
    } catch { /* not a JSON line */ }
  }
  return undefined;
}

async function negativeChecks(port, capability) {
  const send = async (headers, body) => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "identity_echo", arguments: { threadId: "forged" } } };
  const noAuth = await send({}, call);
  const unbound = await send({ authorization: `Bearer ${capability}` }, call);
  return { noAuthRejected401: noAuth.status === 401, unboundCallRejectedBeforeTool: unbound.body?.error?.message === "unbound identity" };
}

async function main() {
  if (dryRun) {
    for (const [client, name, argv] of plan()) console.log(`${client} ${name}: PROBE_CAP=<in-memory> ${binary(client)} ${argv.join(" ")}`);
    return;
  }
  const capability = randomBytes(24).toString("base64url");
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ctx-identity-probe-")));
  const probe = createProbeServer({ capability, expectedCwd: dir });
  const port = await probe.listen();
  const env = { ...process.env, PROBE_CAP: capability };
  const files = claudeFiles(dir, port);
  const flows = [];
  const ids = new Map();
  try {
    const keyOf = (client, id) => (id ? `${client === "codex" ? "codex" : "claude"}:${id}` : undefined);
    const one = async (client, name, prompt, resumeId) => {
      const argv = client === "claude" ? claudeArgs(files, prompt, resumeId ? ["--resume", resumeId] : []) : codexArgs(port, dir, prompt, resumeId);
      const result = await runClient(binary(client), argv, env, dir);
      return { client, name, exit: result.code, timedOut: result.timedOut, nativeKey: keyOf(client, nativeId(client, result.stdout)) };
    };
    for (const client of ["claude", "codex"].filter((c) => which === "all" || which === c)) {
      const sequential = [["root-A", PROMPT_FOR[client]], ["root-B", PROMPT_FOR[client]], ["resume-A", PROMPT_FOR[client]], ["child", CHILD_PROMPT]];
      let rootA;
      for (const [name, prompt] of sequential) {
        if (name === "resume-A" && !rootA) {
          flows.push({ client, name, skipped: "no native id from root-A" });
          continue;
        }
        const before = probe.report().calls.length;
        const flow = await one(client, name, prompt, name === "resume-A" ? rootA : undefined);
        if (name === "root-A") rootA = flow.nativeKey?.slice(flow.nativeKey.indexOf(":") + 1);
        flows.push({ ...flow, calls: probe.report().calls.slice(before) });
      }
      const pair = await Promise.all(["concurrent-1", "concurrent-2"].map((name) => one(client, name, PROMPT_FOR[client])));
      flows.push(...pair.map((flow) => ({ ...flow, concurrent: true })));
    }
    const report = probe.report();
    for (const flow of flows) {
      const own = flow.nativeKey ? probe.aliasForKey(flow.nativeKey) : undefined;
      flow.boundToOwnNativeId = flow.nativeKey ? own !== undefined && (flow.concurrent ? true : flow.calls.some((c) => c.identity === own)) : null;
      flow.ownAlias = own ?? null;
      delete flow.nativeKey;
    }
    const negatives = await negativeChecks(port, capability);
    const receipt = {
      observedOn: "linux (ServerOne); Windows-native leg NOT covered",
      versions: { claude: version("claude"), codex: version(codexBin), node: process.version },
      flows,
      checks: summarize(flows),
      negatives,
      stats: report.stats,
      metaKeys: report.metaKeys,
      hookKeys: report.hookKeys,
      turnMetadataKeys: report.turnMetadataKeys,
      argumentKeys: report.argumentKeys,
      identities: report.identities,
    };
    console.log(JSON.stringify(receipt, null, 2));
  } finally {
    await probe.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function summarize(flows) {
  const concurrent = (client) => flows.filter((f) => f.client === client && f.concurrent);
  const bound = (client, name) => flows.find((f) => f.client === client && f.name === name)?.calls?.find((c) => c.bound);
  const out = {};
  for (const client of ["claude", "codex"]) {
    const [a, b, resumed] = ["root-A", "root-B", "resume-A"].map((n) => bound(client, n));
    const pairCalls = flows.find((f) => f.client === client && f.name === "child")?.calls?.filter((c) => c.bound) ?? [];
    const child = pairCalls.find((c) => c.lineage === "child");
    const parent = pairCalls.find((c) => c.lineage === "root");
    const childPair = child && parent ? [parent, child] : null;
    out[client] = {
      twoSessionsDistinct: a && b ? a.identity !== b.identity : null,
      resumeKeepsIdentity: a && resumed ? a.identity === resumed.identity : null,
      resumeUsedNewConnection: a && resumed ? a.connection !== resumed.connection : null,
            concurrentRootsDistinct: concurrent(client).length === 2 && concurrent(client).every((f) => f.ownAlias) ? concurrent(client)[0].ownAlias !== concurrent(client)[1].ownAlias : null,
      allFlowsBoundToOwnNativeId: flows.filter((f) => f.client === client && f.boundToOwnNativeId !== null).every((f) => f.boundToOwnNativeId === true),
      childLineage: child?.lineage ?? null,
      childSharesRootSession: childPair ? childPair[0].session === childPair[1].session : null,
      childPairDistinct: childPair ? childPair[0].identity !== childPair[1].identity : null,
    };
  }
  return out;
}

main().catch((error) => {
  console.error(`probe failed: ${error?.message ?? error}`);
  process.exitCode = 1;
});
