// Synthetic stdio protocol peer. Never invokes Codex, reads credentials, or writes files.
import { createInterface } from "node:readline";

const spec = JSON.parse(process.env.PROBE_TEST_SPEC);
const argv = process.argv.slice(2);
const stateArgs = argv.filter((arg) => arg.startsWith("hooks.state="));
const trusted = stateArgs.length === 1;
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const reply = (id, result) => send({ id, result });
const fail = (id) => send({ id, error: { code: -32602, message: "synthetic private diagnostic" } });
let initialized = false;
let notified = false;

function hooks() {
  const events = spec.memoryHooks ? ["sessionStart", "subagentStart", "userPromptSubmit", "preToolUse", "postToolUse", "stop"] : ["sessionStart", "subagentStart"];
  const values = events.map((eventName, index) => ({
    key: `/<session-flags>/config.toml:${eventName.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}:0:0`,
    currentHash: `sha256:${String(index + 1).repeat(64)}`, eventName,
    source: "sessionFlags", sourcePath: "/<session-flags>/config.toml", isManaged: false,
    handlerType: "command", command: spec.hookCommand, async: false, matcher: null,
    timeoutSec: 15, enabled: true, trustStatus: trusted ? "trusted" : "untrusted",
    additionalContextLimit: null, statusMessage: null, pluginId: null, displayOrder: index,
  }));
  if (spec.mode === "missing") values.pop();
  if (spec.mode === "duplicate") values.push({ ...values[0] });
  if (spec.mode === "wrong-command") values[0].command = "unreviewed-command";
  if (spec.mode === "async") values[0].async = true;
  if (spec.mode === "disabled") values[0].enabled = false;
  if (spec.mode === "wrong-source") values[0].source = "user";
  if (spec.mode === "bad-hash") values[0].currentHash = "";
  if (spec.mode === "untrusted-second" && trusted) values[0].trustStatus = "untrusted";
  if (spec.mode === "changed-second" && trusted) values[0].currentHash = `sha256:${"9".repeat(64)}`;
  // Listing other hooks must never cause us to approve them.
  values.push({ ...values[0], key: "unrelated:0:0", eventName: "preToolUse", source: "user", command: "unreviewed-command" });
  return values;
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { process.exitCode = 3; process.stdin.destroy(); return; }
  if (message.method === "initialize") {
    const expectedArgs = ["app-server", "--stdio", ...spec.configArgs];
    const cleanArgs = spec.threadRead || spec.promptRead ? argv : argv.filter((arg, i) => !arg.startsWith("hooks.state=") && !(arg === "-c" && argv[i + 1]?.startsWith("hooks.state=")));
    if (JSON.stringify(cleanArgs) !== JSON.stringify(expectedArgs) || process.cwd() !== spec.cwd || !message.params?.clientInfo?.name) return fail(message.id);
    if (spec.mode === "malformed") return process.stdout.write("not-json\n");
    if (spec.mode === "output-limit") return process.stdout.write("x".repeat(8192));
    if (spec.mode === "stderr-limit") return process.stderr.write("private".repeat(8192));
    if (spec.mode === "early-exit") return process.exit(4);
    initialized = true;
    reply(message.id, { userAgent: "synthetic", platformFamily: "unix", platformOs: "linux" });
    send({ method: "fixture/ready", params: {} });
    return;
  }
  if (message.method === "initialized" && initialized) { notified = true; return; }
  if (spec.promptRead && initialized && notified) {
    if (message.method === "thread/read") {
      if (JSON.stringify(message.params) !== JSON.stringify({ threadId: spec.target.threadId, includeTurns: false })) return fail(message.id);
      reply(message.id, { thread: { id: spec.target.threadId, sessionId: spec.target.sessionId, cwd: spec.cwd,
        parentThreadId: null, historyMode: spec.mode === "legacy" ? "legacy" : "paginated", turns: [],
        preview: "OMIT-PREVIEW", path: "/OMIT-HISTORY-PATH" } });
      return;
    }
    const params = message.params;
    if (message.method !== "thread/items/list" || params.threadId !== spec.target.threadId ||
        ![spec.target.turnId, spec.priorTarget?.turnId].includes(params.turnId) || !params.turnId ||
        params.limit !== 16 || params.sortDirection !== "asc" ||
        Object.keys(params).some((key) => !["threadId", "turnId", "limit", "sortDirection", "cursor"].includes(key))) return fail(message.id);
    if (spec.mode === "large-page") return reply(message.id, { data: [], nextCursor: "x".repeat(262_145), backwardsCursor: null });
    const page = params.cursor === undefined ? 0 : params.cursor === "page-2" ? 1 : Number(params.cursor.slice(5)) - 1;
    if (!Number.isSafeInteger(page) || page < 0 || page > 4) return fail(message.id);
    const count = spec.mode === "page-overflow" ? 16 : spec.mode === "zero" ? 0 : 1;
    const nextCursor = spec.mode === "page-overflow" ? `page-${page + 2}` :
      spec.mode === "cursor-loop" || (spec.mode === "two-pages" && page === 0) ? "page-2" : null;
    const data = Array.from({ length: count }, (_, index) => ({
      turnId: spec.mode === "wrong-turn" ? "OMIT-WRONG-TURN" : params.turnId,
      item: { type: "userMessage", id: `${params.turnId}-native-${page}-${index}`, clientId: "OMIT-CLIENT-ID",
        content: [{ type: "text", text: spec.expectedPrompt, text_elements: [] }] }, startedAtMs: 1, completedAtMs: 2,
    }));
    reply(message.id, { data, nextCursor, backwardsCursor: null });
    return;
  }
  if (spec.threadRead && initialized && notified) {
    const requestedId = spec.parentRead ? spec.parentId : spec.childId;
    if (message.method !== "thread/read" || JSON.stringify(message.params) !== JSON.stringify({ threadId: requestedId, includeTurns: true })) return fail(message.id);
    if (spec.mode === "stall") return;
    if (spec.mode === "rpc-error") return fail(message.id);
    if (spec.parentRead) {
      const thread = { id: spec.parentId, cwd: spec.cwd, model: "synthetic-model",
        preview: "private parent preview", path: "/private/native-history",
        turns: [{ id: "synthetic-parent-turn", itemsView: "full", status: "completed", error: null,
          items: [{ type: "subAgentActivity", id: "synthetic-native-spawn", kind: "started",
            agentThreadId: spec.childId, agentPath: "/root/probe_child", model: null, reasoningEffort: null }] }] };
      if (spec.mode === "wrong-parent") thread.id = "private-other-parent";
      if (spec.mode === "wrong-cwd") thread.cwd = "/private/other-workspace";
      reply(message.id, { thread });
      return;
    }
    const thread = { id: spec.childId, cwd: spec.cwd,
      source: { subAgent: { thread_spawn: { parent_thread_id: spec.parentId, depth: 1,
        agent_path: null, agent_nickname: null, agent_role: null } } },
      turns: [{ id: "synthetic-turn", itemsView: "full", status: "completed", error: null,
        items: [{ type: "mcpToolCall", id: "synthetic-call", server: "probe", tool: "ctx_stats",
          status: "completed", arguments: {}, result: { content: [{ type: "text", text: "synthetic statistics" }], structuredContent: null, _meta: null }, error: null }] }] };
    if (spec.mode === "wrong-child") thread.id = "unrequested-child";
    if (spec.mode === "wrong-parent") thread.source.subAgent.thread_spawn.parent_thread_id = "unrequested-parent";
    reply(message.id, { thread });
    return;
  }
  if (message.method !== "hooks/list" || !initialized || !notified || JSON.stringify(message.params?.cwds) !== JSON.stringify([spec.cwd])) return fail(message.id);
  if (spec.mode === "stall") return;
  if (spec.mode === "rpc-error") return fail(message.id);
  if (trusted) {
    const required = hooks().slice(0, spec.memoryHooks ? 6 : 2);
    const state = stateArgs[0];
    if (state.includes("unrelated") || !required.every((hook) => state.includes(JSON.stringify(hook.key))) ||
        !Array.from({ length: spec.memoryHooks ? 6 : 2 }, (_, index) => index + 1).every((number) => state.includes(`sha256:${String(number).repeat(64)}`))) return fail(message.id);
  }
  const entry = { cwd: spec.mode === "wrong-cwd" ? `${spec.cwd}/different` : spec.cwd, hooks: hooks(), warnings: [], errors: [] };
  if (spec.mode === "listing-error") entry.errors.push({ message: "synthetic private diagnostic" });
  if (spec.mode === "warning") entry.warnings.push("synthetic private diagnostic");
  reply(message.id, { data: [entry] });
});
