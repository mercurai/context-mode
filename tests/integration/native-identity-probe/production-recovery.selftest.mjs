import test from "node:test";
import assert from "node:assert/strict";

const module = () => import("./production-recovery.mjs");
const launch = { provider: "claude", home: "/synthetic/profile", userHome: "/synthetic/user",
  workspace: "/synthetic/workspace", mcpUrl: "http://127.0.0.1:1234/mcp", hookUrl: "http://127.0.0.1:1234/hooks",
  mcpCapability: "synthetic-mcp-capability-for-tests", hookCapability: "synthetic-hook-capability-for-tests" };
const config = (extra = {}) => ({ launch, hookCommand: "node /synthetic/shared-service.mjs",
  files: { mcp: "/synthetic/mcp.json", settings: "/synthetic/settings.json" }, prompt: "synthetic request",
  env: { PATH: "/synthetic/bin", PROBE_CAP: "stale", CONTEXT_MODE_SHARED_HOOK_CAP: "stale" }, ...extra });
const claude = (answer = "recoveryclueabc", extra = []) => [
  { type: "system", subtype: "init", session_id: "root-a" }, ...extra,
  { type: "assistant", message: { content: [{ type: "text", text: answer }] } },
  { type: "result", subtype: "success", is_error: false, session_id: "root-a", result: answer },
];
const codex = (answer = "recoveryclueabc", extra = []) => [
  { type: "thread.started", thread_id: "root-a" }, { type: "turn.started" }, ...extra,
  { type: "item.completed", item: { id: "answer-a", type: "agent_message", text: answer } },
  { type: "turn.completed", usage: {} },
];
const options = (client, events, extra = {}) => ({ client, expectedSessionId: "root-a", expected: "recoveryclueabc",
  foreign: ["recoveryclueforeign"], run: { code: 0, timedOut: false, stdout: events.map((x) => JSON.stringify(x)).join("\n") }, ...extra });

test("recovery launch selects production hook environment and provider start envelopes", async () => {
  const { recoveryClientConfig } = await module();
  const result = recoveryClientConfig(config());
  assert.equal(result.env.CONTEXT_MODE_SHARED_HOOK_CAP, launch.hookCapability);
  assert.equal(result.env.CONTEXT_MODE_SHARED_HOOK_URL, launch.hookUrl);
  assert.equal(result.env.CONTEXT_MODE_SHARED_PROVIDER, "claude-code");
  assert.equal(result.env.CONTEXT_MODE_SHARED_MCP_SERVER, "probe");
  assert.equal(result.env.CLAUDE_CONFIG_DIR, launch.home);
  assert.deepEqual(Object.keys(result.files.settings.hooks).sort(), ["PreToolUse", "SessionStart", "SubagentStart"]);
  for (const event of ["SessionStart", "SubagentStart"]) {
    assert.deepEqual(result.files.settings.hooks[event], [{ hooks: [{ type: "command", command: config().hookCommand, timeout: 15 }] }]);
  }
  const serialized = JSON.stringify({ files: result.files, args: result.args });
  assert.ok(!serialized.includes(launch.hookCapability) && !serialized.includes(launch.mcpCapability));
  assert.ok(!serialized.includes("stale"));
});

test("Codex recovery preserves the exact qualified start declarations", async () => {
  const { recoveryClientConfig } = await module();
  const base = recoveryClientConfig(config({ launch: { ...launch, provider: "codex" } }));
  const qualifiedConfigArgs = [...base.configArgs, "-c", 'hooks.state={"owned"={enabled=true,trusted_hash="synthetic"}}'];
  const resumed = recoveryClientConfig(config({ launch: { ...launch, provider: "codex" }, qualifiedConfigArgs, resumeId: "root-a" }));
  assert.deepEqual(resumed.configArgs, qualifiedConfigArgs);
  assert.equal(resumed.env.CONTEXT_MODE_SHARED_PROVIDER, "codex");
  assert.equal(resumed.env.CODEX_HOME, launch.home);
  assert.deepEqual(resumed.args.slice(-2), ["root-a", "synthetic request"]);
  assert.equal(resumed.configArgs.filter((x) => /^hooks\.(SessionStart|SubagentStart)=/.test(x)).length, 2);
});

for (const [client, fixture] of [["claude", claude], ["codex", codex]]) {
  test(`${client} accepts only the completed model answer for the exact conversation`, async () => {
    const { verifyRecoveryAnswer } = await module();
    assert.deepEqual(verifyRecoveryAnswer(options(client, fixture())), { sessionId: "root-a", answerMatched: true });
    assert.throws(() => verifyRecoveryAnswer(options(client, fixture(), { expectedSessionId: "root-b" })), /Recovery evidence invalid/);
    assert.throws(() => verifyRecoveryAnswer(options(client, fixture("other"))), /Recovery evidence invalid/);
    assert.throws(() => verifyRecoveryAnswer(options(client, fixture("recoveryclueabc recoveryclueforeign"))), /Recovery evidence invalid/);
  });
  test(`${client} hook output or quoted user content cannot stand in for a model answer`, async () => {
    const { verifyRecoveryAnswer } = await module();
    const events = fixture("none", [{ type: "system", subtype: "hook_response", output: "recoveryclueabc" }]);
    assert.throws(() => verifyRecoveryAnswer(options(client, events)), /Recovery evidence invalid/);
  });
  test(`${client} native process failure or unconfirmed cleanup prevents acceptance`, async () => {
    const { verifyRecoveryAnswer } = await module();
    for (const patch of [{ code: 1 }, { timedOut: true }, { failure: "output-limit" }, { cleanup: "unconfirmed" }]) {
      const input = options(client, fixture()); input.run = { ...input.run, ...patch };
      assert.throws(() => verifyRecoveryAnswer(input), /Recovery evidence invalid/);
    }
  });
}

test("Claude cannot recover a clue by reading files or calling MCP", async () => {
  const { verifyRecoveryAnswer } = await module();
  for (const name of ["Read", "Bash", "mcp__probe__ctx_search"]) {
    const extra = [{ type: "assistant", message: { content: [{ type: "tool_use", id: "tool-a", name, input: {} }] } }];
    assert.throws(() => verifyRecoveryAnswer(options("claude", claude("recoveryclueabc", extra))), /Recovery evidence invalid/);
  }
});

test("Codex cannot recover a clue through tool activity or an unknown item type", async () => {
  const { verifyRecoveryAnswer } = await module();
  for (const type of ["command_execution", "mcp_tool_call", "file_change", "web_search", "collab_tool_call", "new_tool_type"]) {
    assert.throws(() => verifyRecoveryAnswer(options("codex", codex("recoveryclueabc", [
      { type: "item.completed", item: { id: "tool-a", type } },
    ]))), /Recovery evidence invalid/);
  }
});

test("duplicate terminal results, missing completion and malformed output are refused", async () => {
  const { verifyRecoveryAnswer } = await module();
  for (const [client, fixture] of [["claude", claude], ["codex", codex]]) {
    const events = fixture();
    for (const changed of [events.slice(0, -1), [...events, events.at(-1)]]) {
      assert.throws(() => verifyRecoveryAnswer(options(client, changed)), /Recovery evidence invalid/);
    }
    const input = options(client, events); input.run.stdout += "\nnot-json";
    assert.throws(() => verifyRecoveryAnswer(input), /Recovery evidence invalid/);
  }
});

test("fresh conversation accepts none without exposing any other owner clue", async () => {
  const { verifyRecoveryAnswer } = await module();
  assert.deepEqual(verifyRecoveryAnswer(options("claude", claude("none"), { expected: "none" })),
    { sessionId: "root-a", answerMatched: true });
});
