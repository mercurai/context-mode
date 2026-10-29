// Runner integration regressions only: Node substitutes for Codex. Never invoke a native model client.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runClient, readProductionEvidence } from "./run.mjs";
import { parseCodexChildEvidence, parseCodexParentEvidence } from "./production-evidence.mjs";

const runner = fileURLToPath(new URL("./run.mjs", import.meta.url));
test("production dry-run describes the real tool scope without starting a service or reading a provider home", async () => {
  const run = await runClient(process.execPath, [runner, "--backend", "production", "--client", "all", "--dry-run"],
    { PATH: dirname(process.execPath), CODEX_HOME: "/nonexistent/probe-home", CLAUDE_CONFIG_DIR: "/nonexistent/probe-home" }, process.cwd());
  assert.equal(run.code, 0);
  const receipt = JSON.parse(run.stdout);
  assert.equal(receipt.backend, "shared-service");
  assert.deepEqual(receipt.tools, ["ctx_index", "ctx_search", "ctx_stats"]);
  assert.ok(receipt.flows.includes("restart-resume-A") && receipt.flows.includes("child"));
  assert.equal(receipt.executionOverlap, "pending");
  assert.equal(receipt.modelCalls, 0);
  assert.ok(!run.stdout.includes("probe-home"));
});

test("actual production runner stops before model calls when reviewed hook qualification fails", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ctx-production-runner-offline-")));
  try {
    const run = await runClient(process.execPath, [runner, "--backend", "production", "--client", "codex", "--codex-bin", process.execPath],
      { PATH: dirname(process.execPath), CODEX_HOME: root, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: root,
        CONTEXT_MODE_DIR: join(root, "storage") }, root, { timeoutMs: 15_000 });
    assert.equal(run.failure, undefined);
    assert.equal(run.code, 1);
    const receipt = JSON.parse(run.stdout);
    assert.equal(receipt.backend, "shared-service");
    assert.equal(receipt.passed, false);
    assert.equal(receipt.failure.phase, "codex-hook-trust");
    assert.equal(receipt.modelCalls, 0);
    assert.deepEqual(receipt.flows, []);
    assert.equal(receipt.executionOverlap.status, "pending");
    assert.ok(!run.stdout.includes(root) && !run.stdout.includes("Bearer"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native runner bounds discarded stderr as well as captured stdout", async () => {
  const run = await runClient(process.execPath, ["-e", "process.stderr.write('x'.repeat(4096))"], {}, process.cwd(), { maxOutputBytes: 128 });
  assert.equal(run.failure, "output-limit");
  assert.equal(run.stdout, "");
});


const syntheticRoot = "private-root-id", syntheticChild = "private-child-id";
const syntheticCalls = () => ["ctx_index", "ctx_search", "ctx_stats"].map((tool, index) => ({
  id: `private-tool-${index}`, type: "mcp_tool_call", server: "probe", tool, status: "completed",
  arguments: { synthetic: "private-input" }, result: { content: [{ type: "text", text: "private-output" }] }, error: null,
}));
function syntheticRun(children = 0) {
  const events = [{ type: "thread.started", thread_id: syntheticRoot },
    ...syntheticCalls().map((item) => ({ type: "item.completed", item })),
    ...Array.from({ length: children }, (_, index) => ({ type: "item.completed", item: {
      type: "collab_tool_call", id: `private-spawn-${index}`, tool: "spawn_agent", status: "completed",
      sender_thread_id: syntheticRoot, receiver_thread_ids: [`${syntheticChild}-${index}`],
    } })), { type: "turn.completed", usage: {} }];
  return { code: 0, timedOut: false, stdout: events.map((event) => JSON.stringify(event)).join("\n") };
}
function noPrivateReceipt(diagnostics, error) {
  assert.ok(!JSON.stringify(diagnostics).includes("private"));
  if (error) assert.ok(!error.message.includes("private"));
}

function syntheticParent() {
  return { thread: { id: syntheticRoot, cwd: "/synthetic/workspace", model: "private-selected-model",
    preview: "private parent prose", turns: [{ id: "private-parent-turn", itemsView: "full",
      status: "completed", error: null, items: [{ type: "subAgentActivity", id: "private-spawn",
        kind: "started", agentThreadId: syntheticChild, agentPath: "/root/private-child",
        model: "private-child-model", reasoningEffort: null }] }] } };
}
function syntheticChildEvidence(child, status = "completed") {
  return parseCodexChildEvidence({ thread: { id: child.id, cwd: "/synthetic/workspace",
    source: { subAgent: { thread_spawn: { parent_thread_id: child.parentId } } }, turns: [{
      id: "private-child-turn", itemsView: "full", status, error: null,
      items: syntheticCalls().map(({ type, ...call }) => ({ ...call, id: "child-" + call.id, type: "mcpToolCall" })),
    }] } }, { childId: child.id, parentId: child.parentId, cwd: "/synthetic/workspace" });
}
test("production missing V1 spawn uses exact-parent V2 activity then completed exact-child evidence", async () => {
  const run = syntheticRun(), diagnostics = {}, reads = [];
  const evidence = await readProductionEvidence({ run, client: "codex", childExpected: true, diagnostics,
    readParent: async (parentId) => {
      reads.push("parent"); assert.equal(parentId, syntheticRoot);
      return parseCodexParentEvidence(syntheticParent(), { parentId, cwd: "/synthetic/workspace" });
    },
    readChild: async (child) => {
      reads.push("child"); assert.deepEqual(child, { id: syntheticChild, parentId: syntheticRoot });
      return syntheticChildEvidence(child);
    },
  });
  assert.deepEqual(reads, ["parent", "child"]);
  assert.deepEqual(evidence.children, [{ id: syntheticChild, parentId: syntheticRoot }]);
  assert.equal(evidence.calls.filter((call) => call.owner === syntheticChild).length, 3);
  assert.equal(diagnostics.childObservation, "v2-activity");
  assert.equal(diagnostics.native.parentStartedActivities, 1);
  assert.equal(diagnostics.native.parentCompletedActivities, 0);
  assert.equal(diagnostics.native.completedChildren, 1);
  assert.equal(diagnostics.checkpoint, "evidence-ready");
  assert.equal(run.stdout, ""); noPrivateReceipt(diagnostics);
});
test("production completed V1 child avoids parent fallback", async () => {
  let parentReads = 0;
  const evidence = await readProductionEvidence({ run: syntheticRun(1), client: "codex", childExpected: true, diagnostics: {},
    readParent: async () => { parentReads++; throw new Error("private forbidden parent lookup"); },
    readChild: async (child) => syntheticChildEvidence(child),
  });
  assert.equal(parentReads, 0); assert.equal(evidence.children.length, 1);
});
for (const mode of ["multiple-v1", "invalid-native", "no-child-expected"]) {
  test("production parent lookup is forbidden for " + mode, async () => {
    const run = syntheticRun(mode === "multiple-v1" ? 2 : 0);
    if (mode === "invalid-native") run.stdout = "private invalid stream";
    let reads = 0;
    const result = readProductionEvidence({ run, client: "codex", childExpected: mode !== "no-child-expected",
      diagnostics: {}, readParent: async () => { reads++; throw new Error("private forbidden parent lookup"); },
      readChild: async () => { reads++; throw new Error("private forbidden child lookup"); },
    });
    if (mode === "no-child-expected") assert.equal((await result).children.length, 0);
    else await assert.rejects(result, { code: mode === "multiple-v1"
      ? "PRODUCTION_CHILD_COUNT_MISMATCH" : "PRODUCTION_EVIDENCE_INVALID" });
    assert.equal(reads, 0); assert.equal(run.stdout, "");
  });
}
test("production parent lookup redacts native API errors before any child read", async () => {
  const run = syntheticRun(), diagnostics = {};
  let parentReads = 0, childReads = 0;
  await assert.rejects(readProductionEvidence({ run, client: "codex", childExpected: true, diagnostics,
    readParent: async (parentId) => {
      parentReads++; assert.equal(parentId, syntheticRoot);
      throw Object.assign(new Error("private native parent response"), { code: "private-code" });
    },
    readChild: async () => { childReads++; },
  }), (error) => {
    assert.equal(error.code, "PRODUCTION_PARENT_READ_FAILED"); noPrivateReceipt(diagnostics, error); return true;
  });
  assert.equal(parentReads, 1); assert.equal(childReads, 0);
  assert.equal(diagnostics.checkpoint, "parent-read"); assert.equal(run.stdout, "");
});
test("production parent validation publishes the fixed projection reason without native fields", async () => {
  const run = syntheticRun(), diagnostics = {};
  let childReads = 0;
  await assert.rejects(readProductionEvidence({ run, client: "codex", childExpected: true, diagnostics,
    readParent: async (parentId) => {
      const response = syntheticParent();
      response.thread.model = { private: "native model payload" };
      return parseCodexParentEvidence(response, { parentId, cwd: "/synthetic/workspace" });
    },
    readChild: async () => { childReads++; },
  }), (error) => {
    assert.equal(error.code, "PRODUCTION_EVIDENCE_INVALID"); noPrivateReceipt(diagnostics, error); return true;
  });
  assert.equal(diagnostics.parentValidationReason, "model");
  assert.equal(diagnostics.checkpoint, "parent-read");
  assert.equal(childReads, 0); assert.equal(run.stdout, "");
});
for (const reason of ["private native reason", { native: "private error payload" }]) {
  test("production parent validation excludes untrusted " + typeof reason + " reasons", async () => {
    const run = syntheticRun(), diagnostics = {};
    await assert.rejects(readProductionEvidence({ run, client: "codex", childExpected: true, diagnostics,
      readParent: async () => { throw Object.assign(new Error("private native failure"), {
        code: "PRODUCTION_EVIDENCE_INVALID", parentValidationReason: reason, response: { native: "private payload" },
      }); },
    }), (error) => {
      assert.equal(error.code, "PRODUCTION_EVIDENCE_INVALID"); noPrivateReceipt(diagnostics, error); return true;
    });
    assert.equal(diagnostics.parentValidationReason, "unclassified");
    assert.equal(diagnostics.checkpoint, "parent-read"); assert.equal(run.stdout, "");
  });
}
test("production parent transport errors cannot masquerade as projection rejection reasons", async () => {
  const diagnostics = {};
  await assert.rejects(readProductionEvidence({ run: syntheticRun(), client: "codex", childExpected: true, diagnostics,
    readParent: async () => { throw Object.assign(new Error("private transport failure"), {
      code: "HOOK_TRUST_PROTOCOL", parentValidationReason: "model",
    }); },
  }), (error) => {
    assert.equal(error.code, "HOOK_TRUST_PROTOCOL"); noPrivateReceipt(diagnostics, error); return true;
  });
  assert.equal(diagnostics.parentValidationReason, undefined);
});

test("production V2 parent started activity never substitutes for completed child proof", async () => {
  const run = syntheticRun(), diagnostics = {};
  let childReads = 0;
  await assert.rejects(readProductionEvidence({ run, client: "codex", childExpected: true, diagnostics,
    readParent: async (parentId) => parseCodexParentEvidence(syntheticParent(), { parentId, cwd: "/synthetic/workspace" }),
    readChild: async (child) => { childReads++; return syntheticChildEvidence(child, "inProgress"); },
  }), (error) => {
    assert.equal(error.code, "PRODUCTION_EVIDENCE_INVALID"); noPrivateReceipt(diagnostics, error); return true;
  });
  assert.equal(childReads, 1); assert.equal(diagnostics.checkpoint, "child-read"); assert.equal(run.stdout, "");
});

for (const children of [0, 2]) {
  test(`production diagnostics reject ${children} completed children before any child read`, async () => {
    const run = syntheticRun(children), diagnostics = {};
    let reads = 0;
    await assert.rejects(readProductionEvidence({ run, client: "codex", childExpected: true, diagnostics,
      readChild: async () => { reads++; throw new Error("private child reader must not run"); },
    }), (error) => {
      assert.equal(error.code, "PRODUCTION_CHILD_COUNT_MISMATCH"); noPrivateReceipt(diagnostics, error); return true;
    });
    assert.equal(reads, 0);
    assert.equal(diagnostics.checkpoint, "child-count");
    assert.deepEqual(diagnostics.native, { expectedChildren: 1, completedChildren: children,
      rootTools: { index: 1, search: 1, stats: 1 } });
    assert.equal(run.stdout, "");
  });
}

for (const [failure, expected] of [["output-limit", "output-limit"], ["cleanup-unconfirmed", "cleanup-unconfirmed"],
  ["private unexpected failure detail", "unknown"]]) {
  test(`production diagnostics distinguish exit zero with ${expected} client failure`, async () => {
    const run = { ...syntheticRun(1), failure }, diagnostics = {};
    let reads = 0;
    await assert.rejects(readProductionEvidence({ run, client: "codex", childExpected: true, diagnostics,
      readChild: async () => { reads++; },
    }), (error) => {
      assert.equal(error.code, "PRODUCTION_CLIENT_FAILED"); noPrivateReceipt(diagnostics, error); return true;
    });
    assert.equal(diagnostics.checkpoint, "native-client");
    assert.equal(diagnostics.clientFailure, expected);
    assert.equal(reads, 0);
    assert.equal(run.stdout, "");
  });
}

test("production diagnostics discard malformed native output without exposing it", async () => {
  const run = { code: 0, timedOut: false, stdout: "private malformed native stream" }, diagnostics = {};
  await assert.rejects(readProductionEvidence({ run, client: "codex", childExpected: true, diagnostics }), (error) => {
    assert.equal(error.code, "PRODUCTION_EVIDENCE_INVALID"); noPrivateReceipt(diagnostics, error); return true;
  });
  assert.equal(diagnostics.checkpoint, "parent-parse");
  assert.equal(run.stdout, "");
});

test("production diagnostics classify child read errors without serializing native error payloads", async () => {
  const run = syntheticRun(1), diagnostics = {};
  await assert.rejects(readProductionEvidence({ run, client: "codex", childExpected: true, diagnostics,
    readChild: async (child) => {
      assert.equal(child.id, `${syntheticChild}-0`); assert.equal(child.parentId, syntheticRoot);
      throw Object.assign(new Error("private child error response"), { code: "private-untrusted-code" });
    },
  }), (error) => {
    assert.equal(error.code, "PRODUCTION_CHILD_READ_FAILED"); noPrivateReceipt(diagnostics, error); return true;
  });
  assert.equal(diagnostics.checkpoint, "child-read");
  assert.equal(diagnostics.childReadAttempted, true);
  assert.equal(run.stdout, "");
});

test("production diagnostics retain exact child evidence privately and publish only tool counts", async () => {
  const run = syntheticRun(1), diagnostics = {};
  const evidence = await readProductionEvidence({ run, client: "codex", childExpected: true, diagnostics,
    readChild: async (child) => parseCodexChildEvidence({ thread: { id: child.id, cwd: "/synthetic/workspace",
      source: { subAgent: { thread_spawn: { parent_thread_id: child.parentId } } }, turns: [{ itemsView: "full",
        status: "completed", error: null, items: syntheticCalls().map(({ type, ...call }) => ({ ...call, type: "mcpToolCall" })) }],
    } }, { childId: child.id, parentId: child.parentId, cwd: "/synthetic/workspace" }),
  });
  assert.equal(evidence.calls.length, 6);
  assert.equal(evidence.calls.filter((call) => call.owner === `${syntheticChild}-0`).length, 3);
  assert.equal(diagnostics.checkpoint, "evidence-ready");
  assert.equal(diagnostics.childReadAttempted, true);
  assert.deepEqual(diagnostics.native, { expectedChildren: 1, completedChildren: 1,
    rootTools: { index: 1, search: 1, stats: 1 }, childTools: { index: 1, search: 1, stats: 1 } });
  assert.equal(run.stdout, ""); noPrivateReceipt(diagnostics);
});
