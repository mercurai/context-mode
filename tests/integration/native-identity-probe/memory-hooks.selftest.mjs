// Fixture-only qualification logic. These tests make no native-client, model,
// HTTP, filesystem or transcript calls and cannot establish native support.
import test from "node:test";
import assert from "node:assert/strict";
import { projectMemoryHook, summarizeMemoryHooks } from "./memory-hooks.mjs";

const LIMITS = { maxObservations: 128, maxIdentities: 128 };
const launch = (provider = "claude", overrides = {}) => ({ provider,
  home: "/fixture/config", workspace: "/fixture/worktree", launchId: "fixture-launch", ...overrides });
const owner = (scope, overrides = {}) => ({ ...scope, sessionId: "fixture-session",
  ...(scope.provider === "codex" ? { threadId: "fixture-session" } : {}), ...overrides });
const native = (event, overrides = {}) => ({ hook_event_name: event,
  session_id: "fixture-session", cwd: "/fixture/worktree",
  ...(["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(event)
    ? { tool_name: "mcp__probe__identity_echo" } : {}), ...overrides });
const observation = (event, nativeFields = {}, { provider = "claude", scope = launch(provider),
  identity = owner(scope), flow = "root-A" } = {}) => ({ scope, identity, flow,
  hook: projectMemoryHook(provider, JSON.stringify(native(event, nativeFields))) });
const summarize = (observations, limits = LIMITS) => summarizeMemoryHooks(observations, limits);

test("projection retains identity candidates and known field names but drops every content-bearing value", () => {
  const projected = projectMemoryHook("claude", JSON.stringify(native("PostToolUse", {
    prompt_id: "fixture-prompt", tool_use_id: "fixture-tool", tool_name: "Bash",
    prompt: "OMIT-PROMPT", tool_input: { command: "OMIT-INPUT" }, tool_response: "OMIT-OUTPUT",
    transcript_path: "/OMIT-TRANSCRIPT", permission_mode: "OMIT-PERMISSION", model: "OMIT-MODEL",
    authorization: "OMIT-AUTH", env: { TOKEN: "OMIT-TOKEN" },
    "OMIT-UNKNOWN-KEY": "OMIT-UNKNOWN-VALUE",
  })));
  assert.equal(projected.event, "PostToolUse");
  assert.equal(projected.sessionId, "fixture-session");
  assert.equal(projected.toolUseId, "fixture-tool");
  assert.equal(projected.toolName, "Bash");
  assert.equal(projected.promptId, "fixture-prompt");
  assert.ok(projected.fields.includes("tool_response"));
  assert.ok(projected.fields.includes("transcript_path"));
  assert.ok(!projected.fields.includes("OMIT-UNKNOWN-KEY"));
  assert.equal(projected.unknownFields, 3);
  assert.ok(!JSON.stringify(projected).includes("OMIT-"));
  assert.deepEqual(Object.keys(projected).sort(),
    ["cwd", "event", "fields", "promptId", "sessionId", "toolName", "toolUseId", "unknownFields"].sort());
});

test("projection never copies prototype keys or nested payload keys", () => {
  const input = '{"hook_event_name":"UserPromptSubmit","session_id":"fixture-session",' +
    '"cwd":"/fixture/worktree","prompt_id":"fixture-prompt","prompt":"fixture",' +
    '"__proto__":{"polluted":"OMIT-PROTOTYPE"},"tool_input":{"OMIT-NESTED-KEY":"OMIT-NESTED"}}';
  const projected = projectMemoryHook("claude", input);
  assert.equal(Object.getPrototypeOf(projected), Object.prototype);
  assert.equal(Object.hasOwn(projected, "__proto__"), false);
  assert.equal({}.polluted, undefined);
  assert.ok(!JSON.stringify(projected).includes("OMIT-"));
});

for (const [label, provider, raw] of [
  ["provider", "unknown", JSON.stringify(native("SessionStart"))],
  ["event", "claude", JSON.stringify(native("OMIT-UNSUPPORTED-EVENT"))],
  ["unsupported Codex failure event", "codex", JSON.stringify(native("PostToolUseFailure"))],
  ["malformed JSON", "claude", '{"secret":"OMIT-PARSE'],
  ["array", "claude", "[]"],
  ["numeric session", "claude", JSON.stringify(native("SessionStart", { session_id: 1 }))],
  ["control character", "claude", JSON.stringify(native("SessionStart", { session_id: "bad\nidentifier" }))],
  ["relative cwd", "claude", JSON.stringify(native("SessionStart", { cwd: "relative" }))],
  ["oversize identifier", "claude", JSON.stringify(native("UserPromptSubmit", { prompt_id: "x".repeat(1025) }))],
  ["UTF-8 body bound", "claude", JSON.stringify(native("UserPromptSubmit", { prompt: "🍎".repeat(17_000) }))],
]) {
  test(`projection rejects ${label} with a fixed non-payload error`, () => {
    assert.throws(() => projectMemoryHook(provider, raw), (error) => {
      assert.match(error.message, /^Invalid memory hook projection$/);
      assert.ok(!error.message.includes("OMIT-"));
      return true;
    });
  });
}

test("absent observations never qualify prompt, tool or recovery support", () => {
  const report = summarize([]);
  for (const provider of ["claude", "codex"]) {
    assert.equal(report.providers[provider].observations, 0);
    assert.equal(report.providers[provider].prompt.eligible, false);
    assert.equal(report.providers[provider].tools.eligible, false);
    assert.equal(report.providers[provider].recovery.eligible, false);
  }
});

test("Claude distinct native prompts across exact-session resume qualify independently of prompt text", () => {
  const report = summarize([
    observation("UserPromptSubmit", { prompt_id: "native-prompt-a", prompt: "SAME-TEXT" }),
    observation("UserPromptSubmit", { prompt_id: "native-prompt-b", prompt: "SAME-TEXT" }, { flow: "resume-A" }),
  ]).providers.claude;
  assert.equal(report.prompt.observations, 2);
  assert.equal(report.prompt.occurrenceIds, 2);
  assert.equal(report.prompt.distinctOccurrences, 2);
  assert.equal(report.prompt.distinctAcrossFlows, true);
  assert.equal(report.prompt.eligible, true);
});

test("reused prompt ID across separate submissions cannot qualify distinct occurrences", () => {
  const report = summarize([
    observation("UserPromptSubmit", { prompt_id: "reused", prompt: "FIRST" }),
    observation("UserPromptSubmit", { prompt_id: "reused", prompt: "SECOND" }, { flow: "resume-A" }),
  ]).providers.claude;
  assert.equal(report.prompt.distinctOccurrences, 1);
  assert.equal(report.prompt.distinctAcrossFlows, false);
  assert.equal(report.prompt.eligible, false);
});

test("missing Claude prompt ID remains unqualified rather than inferred from session or content", () => {
  const report = summarize([
    observation("UserPromptSubmit", { prompt: "FIRST" }),
    observation("UserPromptSubmit", { prompt: "SECOND" }, { flow: "resume-A" }),
  ]).providers.claude;
  assert.equal(report.prompt.occurrenceIds, 0);
  assert.equal(report.prompt.distinctOccurrences, 0);
  assert.equal(report.prompt.eligible, false);
});

test("different roots cannot substitute for exact-session prompt occurrence consistency", () => {
  const scope = launch();
  const report = summarize([
    observation("UserPromptSubmit", { prompt_id: "native-prompt-a" }),
    observation("UserPromptSubmit", { session_id: "other-session", prompt_id: "native-prompt-b" },
      { scope, identity: owner(scope, { sessionId: "other-session" }), flow: "root-B" }),
  ]).providers.claude;
  assert.equal(report.prompt.distinctOccurrences, 2);
  assert.equal(report.prompt.distinctAcrossFlows, false);
  assert.equal(report.prompt.eligible, false);
});

test("Codex turn IDs never become prompt occurrence IDs, even when each observed turn differs", () => {
  const report = summarize([
    observation("UserPromptSubmit", { turn_id: "native-turn-a", prompt: "FIRST" }, { provider: "codex" }),
    observation("UserPromptSubmit", { turn_id: "native-turn-b", prompt: "SECOND" }, { provider: "codex", flow: "resume-A" }),
  ]).providers.codex;
  assert.equal(report.prompt.observations, 2);
  assert.equal(report.prompt.occurrenceIds, 0);
  assert.equal(report.prompt.eligible, false);
  assert.ok(report.events.UserPromptSubmit.fields.includes("turn_id"));
});

test("a payload-supplied Codex prompt_id cannot upgrade the pinned unsupported occurrence contract", () => {
  const report = summarize([
    observation("UserPromptSubmit", { turn_id: "turn", prompt_id: "invented-a" }, { provider: "codex" }),
    observation("UserPromptSubmit", { turn_id: "turn", prompt_id: "invented-b" }, { provider: "codex", flow: "resume-A" }),
  ]).providers.codex;
  assert.equal(report.prompt.occurrenceIds, 0);
  assert.equal(report.prompt.eligible, false);
});

for (const provider of ["claude", "codex"]) {
  test(`${provider} pre/post tool IDs correlate only within one resolved owner`, () => {
    const report = summarize([
      observation("PreToolUse", { tool_use_id: "native-tool-a" }, { provider }),
      observation("PostToolUse", { tool_use_id: "native-tool-a" }, { provider }),
    ]).providers[provider];
    assert.equal(report.tools.pre, 1); assert.equal(report.tools.post, 1);
    assert.equal(report.tools.matched, 1); assert.equal(report.tools.unmatched, 0);
    assert.equal(report.tools.eligible, true);
  });

  test(`${provider} a different tool completion ID cannot satisfy correlation`, () => {
    const report = summarize([
      observation("PreToolUse", { tool_use_id: "native-tool-a" }, { provider }),
      observation("PostToolUse", { tool_use_id: "native-tool-b" }, { provider }),
    ]).providers[provider];
    assert.equal(report.tools.matched, 0);
    assert.ok(report.tools.unmatched > 0);
    assert.equal(report.tools.eligible, false);
  });
}

test("Claude failure completion has explicit correlation and is not treated as success", () => {
  const report = summarize([
    observation("PreToolUse", { tool_use_id: "native-tool-a" }),
    observation("PostToolUseFailure", { tool_use_id: "native-tool-a", error: "OMIT-FAILURE" }),
  ]).providers.claude;
  assert.equal(report.tools.matched, 1);
  assert.equal(report.events.PostToolUseFailure.observations, 1);
  assert.equal(report.tools.eligible, true);
  assert.ok(!JSON.stringify(report).includes("OMIT-FAILURE"));
});

test("a tool ID reused with a different tool name cannot satisfy correlation", () => {
  const report = summarize([
    observation("PreToolUse", { tool_use_id: "native-tool", tool_name: "Bash" }),
    observation("PostToolUse", { tool_use_id: "native-tool", tool_name: "Read" }),
  ]).providers.claude;
  assert.equal(report.tools.matched, 0);
  assert.equal(report.tools.conflicts, 1);
  assert.equal(report.tools.eligible, false);
});

for (const dimension of ["provider", "home", "workspace", "launchId", "sessionId", "agentId"]) {
  test(`tool ID reuse cannot correlate across ${dimension}`, () => {
    const a = launch();
    const b = launch(dimension === "provider" ? "codex" : "claude",
      ["home", "workspace", "launchId"].includes(dimension) ? { [dimension]: dimension === "launchId" ? "other-launch" : `/other/${dimension}` } : {});
    const different = owner(b, ["sessionId", "agentId"].includes(dimension) ? { [dimension]: "other-native-owner" } : {});
    const hook = { tool_use_id: "reused-tool", cwd: b.workspace, session_id: different.sessionId,
      ...(different.agentId ? { agent_id: different.agentId } : {}) };
    const report = summarize([
      observation("PreToolUse", { tool_use_id: "reused-tool" }, { scope: a }),
      observation("PostToolUse", hook, { provider: b.provider, scope: b, identity: different }),
    ]);
    assert.equal(report.providers.claude.tools.matched + report.providers.codex.tools.matched, 0);
    assert.equal(report.providers.claude.tools.eligible, false);
    assert.equal(report.providers.codex.tools.eligible, false);
  });
}

test("Codex root and registered child never correlate a shared tool ID", () => {
  const scope = launch("codex"), child = owner(scope, { threadId: "native-child" });
  const report = summarize([
    observation("PreToolUse", { tool_use_id: "reused-tool" }, { provider: "codex", scope }),
    observation("PostToolUse", { tool_use_id: "reused-tool", agent_id: "native-child" },
      { provider: "codex", scope, identity: child, flow: "child" }),
  ]).providers.codex;
  assert.equal(report.tools.matched, 0);
  assert.equal(report.tools.eligible, false);
});

test("wrong native cwd or session cannot contribute eligible evidence", () => {
  const report = summarize([
    observation("SessionStart", { cwd: "/other/worktree" }),
    observation("UserPromptSubmit", { session_id: "other-session", prompt_id: "native-prompt" }),
    observation("PostToolUse", { tool_use_id: "native-tool", agent_id: "unregistered-child" }),
  ]).providers.claude;
  assert.equal(report.unbound, 3);
  assert.equal(report.prompt.eligible, false);
  assert.equal(report.tools.eligible, false);
  assert.equal(report.recovery.eligible, false);
});

test("lifecycle recovery is owner-bound and does not create delivery occurrence evidence", () => {
  const report = summarize([
    observation("SessionStart"), observation("PreCompact"), observation("Stop"),
  ]).providers.claude;
  assert.equal(report.recovery.observations, 3);
  assert.equal(report.recovery.eligible, true);
  assert.equal(report.prompt.occurrenceIds, 0);
  assert.equal(report.tools.matched, 0);
  assert.equal(report.prompt.eligible, false);
  assert.equal(report.tools.eligible, false);
});

test("duplicate observation does not inflate unique completed-tool counts", () => {
  const pre = observation("PreToolUse", { tool_use_id: "native-tool" });
  const post = observation("PostToolUse", { tool_use_id: "native-tool" });
  const report = summarize([pre, post, structuredClone(post)]).providers.claude;
  assert.equal(report.observations, 3);
  assert.equal(report.tools.matched, 1);
  assert.equal(report.tools.eligible, true);
  assert.equal(report.nativeRetryObserved, false); // Replaying a fixture is not native retry evidence.
});

test("summary is a fixed vocabulary of field names, enums, booleans and counts only", () => {
  const scope = launch("claude", { home: "/OMIT-HOME", launchId: "OMIT-LAUNCH", workspace: "/OMIT-WORKSPACE" });
  const identity = owner(scope, { sessionId: "OMIT-SESSION" });
  const report = summarize([
    observation("PreToolUse", { cwd: scope.workspace, session_id: identity.sessionId, tool_use_id: "OMIT-TOOL" }, { scope, identity }),
    observation("PostToolUse", { cwd: scope.workspace, session_id: identity.sessionId, tool_use_id: "OMIT-TOOL" }, { scope, identity }),
  ]);
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes("OMIT-"));
  assert.ok(!/\b[a-f0-9]{32,}\b/i.test(serialized)); // No persisted surrogate identifiers or content digests.
  function inspect(value) {
    if (typeof value === "string") {
      assert.match(value, /^(?:session_id|cwd|tool_use_id|tool_name|hook_event_name)$/);
    } else if (Array.isArray(value)) value.forEach(inspect);
    else if (value && typeof value === "object") Object.values(value).forEach(inspect);
    else assert.ok(typeof value === "boolean" || (Number.isSafeInteger(value) && value >= 0));
  }
  inspect(report);
});

test("summary rejects forged projection field names rather than persisting caller-controlled keys", () => {
  const value = observation("SessionStart");
  value.hook.fields.push("OMIT-UNTRUSTED-KEY");
  assert.throws(() => summarize([value]), /^Error: Invalid memory hook observation$/);
});

test("summary rejects observation and native-identity capacity overflow", () => {
  const first = observation("PreToolUse", { tool_use_id: "tool-a" });
  const second = observation("PostToolUse", { tool_use_id: "tool-b" });
  assert.throws(() => summarize([first, second], { maxObservations: 1, maxIdentities: 128 }), /^Error: Memory hook observation capacity exceeded$/);
  assert.throws(() => summarize([first, second], { maxObservations: 128, maxIdentities: 1 }), /^Error: Memory hook identity capacity exceeded$/);
});

test("summary rejects unbounded limits and unrecognized flow labels without echoing caller data", () => {
  assert.throws(() => summarize([], { maxObservations: 0, maxIdentities: 128 }), /^Error: Invalid memory hook bounds$/);
  assert.throws(() => summarize([], { maxObservations: Infinity, maxIdentities: 128 }), /^Error: Invalid memory hook bounds$/);
  assert.throws(() => summarize([observation("SessionStart", {}, { flow: "OMIT-UNTRUSTED-FLOW" })]),
    /^Error: Invalid memory hook observation$/);
});
