import test from "node:test";
import assert from "node:assert/strict";
import { productionClientConfig } from "./run.mjs";

const launch = { provider: "claude", home: "/synthetic/operational-home", userHome: "/synthetic/user",
  workspace: "/synthetic/workspace", mcpUrl: "http://127.0.0.1:1234/mcp", hookUrl: "http://127.0.0.1:1234/hooks",
  mcpCapability: "synthetic-mcp-capability", hookCapability: "synthetic-hook-capability" };
const options = (extra = {}) => ({ launch, hookType: "command", hookCommand: "node /synthetic/hook.mjs",
  files: { mcp: "/synthetic/mcp.json", settings: "/synthetic/settings.json" }, prompt: "synthetic request",
  env: { PATH: "/synthetic/bin", PROBE_CAP: "stale-diagnostic", PROBE_MCP_CAP: "stale-mcp", PROBE_HOOK_CAP: "stale-hook" }, ...extra });
const assertPrivate = (result) => {
  const serialized = JSON.stringify({ args: result.args, configArgs: result.configArgs, files: result.files });
  assert.ok(!serialized.includes(launch.mcpCapability) && !serialized.includes(launch.hookCapability));
  assert.ok(!serialized.includes("stale-"));
  assert.ok(result.env.PROBE_MCP_CAP === launch.mcpCapability && result.env.PROBE_HOOK_CAP === launch.hookCapability);
  assert.equal(result.env.PROBE_CAP, undefined);
  assert.equal(result.env.PROBE_HOOK_URL, launch.hookUrl);
};

test("Claude production config streams actual tool events and grants exact production tools", () => {
  const result = productionClientConfig(options());
  assertPrivate(result);
  assert.equal(result.env.CLAUDE_CONFIG_DIR, launch.home);
  assert.equal(result.env.PATH, "/synthetic/bin");
  assert.equal(result.args[result.args.indexOf("--output-format") + 1], "stream-json");
  assert.ok(result.args.includes("--verbose"));
  assert.equal(result.args[result.args.indexOf("--allowedTools") + 1], "mcp__probe__ctx_index,mcp__probe__ctx_search,mcp__probe__ctx_stats,Task,Agent");
  assert.equal(result.files.mcp.mcpServers.probe.url, launch.mcpUrl);
  assert.equal(result.files.mcp.mcpServers.probe.headers.Authorization, "Bearer ${PROBE_MCP_CAP}");
  assert.deepEqual(result.files.settings.hooks.PreToolUse[0].hooks, [{ type: "command", command: "node /synthetic/hook.mjs" }]);
  assert.ok(!result.args.includes("--bare") && !JSON.stringify(result).includes("identity_echo"));
});
test("Claude HTTP hook uses only its hook capability env reference and production endpoint", () => {
  const result = productionClientConfig(options({ hookType: "http" }));
  assertPrivate(result);
  assert.deepEqual(result.files.settings.hooks.PreToolUse[0].hooks, [{ type: "http", url: launch.hookUrl,
    headers: { Authorization: "Bearer $PROBE_HOOK_CAP" }, allowedEnvVars: ["PROBE_HOOK_CAP"] }]);
});
test("Codex production config uses one exact hook declaration set for preflight and model argv", () => {
  const result = productionClientConfig(options({ launch: { ...launch, provider: "codex" } }));
  assertPrivate(result);
  assert.equal(result.env.CODEX_HOME, launch.home);
  assert.ok(result.configArgs.includes('mcp_servers.probe.bearer_token_env_var="PROBE_MCP_CAP"'));
  assert.ok(result.configArgs.includes(`mcp_servers.probe.url=${JSON.stringify(launch.mcpUrl)}`));
  assert.equal(result.configArgs.filter((value) => /^hooks\.(SessionStart|SubagentStart)=/.test(value)).length, 2);
  assert.ok(result.configArgs.filter((value) => value.startsWith("hooks.")).every((value) => value.includes("timeout=15")));
  assert.equal(result.args[0], "exec");
  assert.equal(result.args[result.args.indexOf("-C") + 1], launch.workspace);
  assert.ok(result.args.includes("--ignore-user-config") && result.args.includes("--ignore-rules"));
  const start = result.args.indexOf(result.configArgs[1]) - 1;
  assert.deepEqual(result.args.slice(start, start + result.configArgs.length), result.configArgs);
});
test("qualified Codex CLI trust state survives exact-conversation resume without being regenerated", () => {
  const base = productionClientConfig(options({ launch: { ...launch, provider: "codex" } }));
  const qualifiedConfigArgs = [...base.configArgs, "-c", 'hooks.state={"owned"={enabled=true,trusted_hash="synthetic"}}'];
  const resumed = productionClientConfig(options({ launch: { ...launch, provider: "codex" }, resumeId: "exact-root", qualifiedConfigArgs }));
  assert.deepEqual(resumed.args.slice(0, 2), ["exec", "resume"]);
  assert.ok(resumed.args.includes(qualifiedConfigArgs.at(-1)));
  assert.deepEqual(resumed.args.slice(-2), ["exact-root", "synthetic request"]);
  assert.ok(!resumed.args.includes("--last") && !resumed.args.includes("-s"));
  assert.deepEqual(resumed.configArgs, qualifiedConfigArgs);
});
test("Claude resume uses exact native conversation, never latest-session selection", () => {
  const result = productionClientConfig(options({ resumeId: "exact-root" }));
  assert.equal(result.args[result.args.indexOf("--resume") + 1], "exact-root");
  assert.ok(!result.args.includes("--continue"));
});
test("config refuses missing or equal purpose grants before emitting launch arguments", () => {
  for (const invalid of [{ ...launch, hookCapability: undefined }, { ...launch, hookCapability: launch.mcpCapability }]) {
    assert.throws(() => productionClientConfig(options({ launch: invalid })), { code: "PRODUCTION_CONFIG_INVALID" });
  }
});
