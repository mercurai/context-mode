// Offline: actual built service + SDK clients. No native client/model or authentication-home access.
import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createProductionProbe } from "./production.mjs";
import { productionRootIdentity, unregisteredProductionCall } from "./run.mjs";

let root, previousEnv, launches, adapters, clients, callNumber;
beforeEach(() => {
  previousEnv = { ...process.env };
  root = realpathSync(mkdtempSync(join(tmpdir(), "ctx-production-adapter-")));
  const fallback = join(root, "fallback");
  mkdirSync(join(fallback, "tmp"), { recursive: true });
  Object.assign(process.env, { HOME: fallback, USERPROFILE: fallback, CODEX_HOME: fallback,
    CLAUDE_CONFIG_DIR: fallback, CONTEXT_MODE_DIR: join(fallback, "storage"),
    CLAUDE_PROJECT_DIR: fallback, CONTEXT_MODE_PROJECT_DIR: fallback,
    TMPDIR: join(fallback, "tmp"), TEMP: join(fallback, "tmp"), TMP: join(fallback, "tmp") });
  delete process.env.CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS;
  launches = [
    { name: "codex-a", provider: "codex", home: join(root, "codex-home"), userHome: root, workspace: join(root, "worktree-a") },
    { name: "claude-a", provider: "claude", home: join(root, "claude-home"), userHome: root, workspace: join(root, "worktree-a") },
    { name: "codex-b", provider: "codex", home: join(root, "codex-home"), userHome: root, workspace: join(root, "worktree-b") },
  ];
  for (const launch of launches) { mkdirSync(launch.home, { recursive: true }); mkdirSync(launch.workspace, { recursive: true }); }
  adapters = []; clients = []; callNumber = 0;
});
afterEach(async () => {
  try {
    await Promise.allSettled(clients.map((client) => client.close()));
    await Promise.allSettled(adapters.map((adapter) => adapter.close()));
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env, previousEnv);
    rmSync(root, { recursive: true, force: true });
  }
});

async function create(input = launches) {
  const adapter = await createProductionProbe({ launches: input, now: () => new Date(0) });
  adapters.push(adapter);
  return adapter;
}
async function connect(launch, capability = launch.mcpCapability) {
  const client = new Client({ name: "production-adapter-offline", version: "1" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(launch.mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${capability}` } },
  }));
  return client;
}
async function hook(launch, payload, capability = launch.hookCapability) {
  const response = await fetch(launch.hookUrl, { method: "POST", headers: {
    authorization: `Bearer ${capability}`, "content-type": "application/json",
  }, body: JSON.stringify({ cwd: launch.workspace, ...payload }) });
  const body = await response.json();
  if (response.ok) assert.deepEqual(body, { registered: true });
  return response.status;
}
const start = (launch, session = "root") => hook(launch, { hook_event_name: "SessionStart", session_id: session });
async function invoke(client, launch, name, args = {}, { session = "root", agent } = {}) {
  let meta;
  if (launch.provider === "codex") meta = { threadId: agent ?? session, sessionId: session };
  else {
    const id = `offline-call-${++callNumber}`;
    assert.equal(await hook(launch, { hook_event_name: "PreToolUse", session_id: session, tool_use_id: id,
      tool_name: `mcp__probe__${name}`, ...(agent ? { agent_id: agent } : {}) }), 202);
    meta = { "claudecode/toolUseId": id };
  }
  return client.callTool({ name, arguments: args, _meta: meta });
}
const text = (result) => result.content.map((part) => part.text ?? "").join("\n");
const search = (client, launch, identity) => invoke(client, launch, "ctx_search", { queries: ["orchard"] }, identity).then(text);

test("adapter exposes actual production tools and separate purpose-specific launch configuration", async () => {
  const adapter = await create();
  const launch = adapter.launch("codex-a");
  assert.equal(launch.home, launches[0].home);
  assert.equal(launch.workspace, launches[0].workspace);
  assert.equal(new URL(launch.mcpUrl).pathname, "/mcp");
  assert.equal(new URL(launch.hookUrl).pathname, "/hooks");
  assert.ok(launch.mcpCapability !== launch.hookCapability); // Never expose grants in failure output.
  const client = await connect(launch);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(["ctx_index", "ctx_search", "ctx_stats"].every((name) => names.includes(name)));
  assert.ok(!names.includes("identity_echo"));
  assert.equal((await invoke(client, launch, "ctx_stats")).isError, true);
  assert.equal(await start(launch), 202);
  assert.match(text(await invoke(client, launch, "ctx_index", { content: "Orchard actualproductionapples.", source: "notes" })), /Indexed/);
  assert.match(await search(client, launch), /actualproductionapples/);
  assert.notEqual((await invoke(client, launch, "ctx_stats")).isError, true);
});

test("real storage isolates provider, exact worktree and concrete conversation", async () => {
  const adapter = await create();
  const a = adapter.launch("codex-a"), b = adapter.launch("codex-b"), c = adapter.launch("claude-a");
  const ca = await connect(a), cb = await connect(b), cc = await connect(c);
  assert.equal(await start(a), 202);
  assert.equal(await start(b), 202);
  await invoke(ca, a, "ctx_index", { content: "Orchard alphaadapterapples.", source: "notes" });
  await invoke(cb, b, "ctx_index", { content: "Orchard betaadapterbananas.", source: "notes" });
  await invoke(cc, c, "ctx_index", { content: "Orchard claudeadaptercherries.", source: "notes" });
  const aa = await search(ca, a), bb = await search(cb, b), cl = await search(cc, c);
  assert.match(aa, /alphaadapterapples/); assert.doesNotMatch(aa, /betaadapterbananas|claudeadaptercherries/);
  assert.match(bb, /betaadapterbananas/); assert.doesNotMatch(bb, /alphaadapterapples|claudeadaptercherries/);
  assert.match(cl, /claudeadaptercherries/); assert.doesNotMatch(cl, /alphaadapterapples|betaadapterbananas/);
  assert.equal(await start(a, "other-root"), 202);
  assert.doesNotMatch(await search(ca, a, { session: "other-root" }), /alphaadapterapples/);
});

test("real Codex and Claude child owners cannot retrieve their parent marker", async () => {
  const adapter = await create();
  for (const name of ["codex-a", "claude-a"]) {
    const launch = adapter.launch(name), client = await connect(launch);
    if (launch.provider === "codex") {
      assert.equal(await start(launch), 202);
      assert.equal(await hook(launch, { hook_event_name: "SubagentStart", session_id: "root", agent_id: "child" }), 202);
    }
    await invoke(client, launch, "ctx_index", { content: "Orchard parentadapterplums.", source: "notes" });
    await invoke(client, launch, "ctx_index", { content: "Orchard childadapterpears.", source: "notes" }, { agent: "child" });
    const parent = await search(client, launch), child = await search(client, launch, { agent: "child" });
    assert.match(parent, /parentadapterplums/); assert.doesNotMatch(parent, /childadapterpears/);
    assert.match(child, /childadapterpears/); assert.doesNotMatch(child, /parentadapterplums/);
  }
});

test("production endpoints reject cross-purpose credentials", async () => {
  const adapter = await create(), launch = adapter.launch("codex-a");
  assert.equal(await hook(launch, { hook_event_name: "SessionStart", session_id: "root" }, launch.mcpCapability), 401);
  await assert.rejects(connect(launch, launch.hookCapability));
});

test("restart rejects old credentials and restores only a freshly registered same conversation", async () => {
  const adapter = await create();
  const old = adapter.launch("codex-a"), client = await connect(old);
  assert.equal(await start(old), 202);
  await invoke(client, old, "ctx_index", { content: "Orchard durableadapterdates.", source: "notes" });
  await client.close();
  await adapter.restart();
  const current = adapter.launch("codex-a");
  assert.ok(current.mcpCapability !== old.mcpCapability && current.hookCapability !== old.hookCapability);
  await assert.rejects(connect(current, old.mcpCapability));
  assert.equal(await hook(current, { hook_event_name: "SessionStart", session_id: "root" }, old.hookCapability), 401);
  const resumed = await connect(current);
  assert.equal((await invoke(resumed, current, "ctx_search", { queries: ["orchard"] })).isError, true);
  assert.equal(await start(current), 202);
  assert.match(await search(resumed, current), /durableadapterdates/);
  assert.equal(await start(current, "new-root"), 202);
  assert.doesNotMatch(await search(resumed, current, { session: "new-root" }), /durableadapterdates/);
});

test("report contains only backend, epoch, launch aliases and health without credentials or paths", async () => {
  const adapter = await create();
  const report = adapter.report();
  assert.equal(report.backend, "shared-service");
  assert.equal(report.epoch, 1);
  assert.equal(report.health.state, "ready");
  assert.deepEqual(report.launches, [{ alias: "l1", provider: "codex" }, { alias: "l2", provider: "claude" }, { alias: "l3", provider: "codex" }]);
  const serialized = JSON.stringify(report);
  for (const spec of launches) {
    const launch = adapter.launch(spec.name);
    assert.ok(!serialized.includes(launch.mcpCapability) && !serialized.includes(launch.hookCapability));
    assert.ok(!serialized.includes(spec.home) && !serialized.includes(spec.workspace) && !serialized.includes(spec.name));
  }
  assert.equal(report.overlapVerified, undefined); // No custom-server proof attributed to production.
});

test("closed adapter stops grant admission and has idempotent owned cleanup", async () => {
  const adapter = await create(), launch = adapter.launch("codex-a");
  const closing = adapter.close();
  assert.equal(adapter.close(), closing);
  assert.throws(() => adapter.launch("codex-a"));
  await closing;
  await assert.rejects(connect(launch));
  await assert.rejects(adapter.restart());
});

test("adapter rejects duplicate launcher labels rather than overwriting a grant", async () => {
  await assert.rejects(createProductionProbe({ launches: [launches[0], { ...launches[1], name: launches[0].name }], now: () => new Date(0) }), /Invalid/);
});

test("negative mutation witness: stale same-name stats binding must fail the unregistered-call check", async () => {
  const adapter = await create(), launch = adapter.launch("claude-a");
  for (const [id, name] of [["completed-index", "ctx_index"], ["completed-stats", "ctx_stats"]]) {
    assert.equal(await hook(launch, { hook_event_name: "PreToolUse", session_id: "root", tool_use_id: id,
      tool_name: `mcp__probe__${name}` }), 202);
  }
  const evidence = { sessionId: "root", children: [], calls: [
    { id: "completed-index", owner: "root", name: "ctx_index", args: {}, text: "Indexed" },
    { id: "completed-stats", owner: "root", name: "ctx_stats", args: {}, text: "Stats" },
  ] };
  const retained = productionRootIdentity(evidence, "p1");
  assert.equal(retained.toolId, "completed-stats");
  assert.equal(retained.process, "p1");
  // A preserved registration is the mutation being detected. A differently named
  // tool-use id instead returns an error and would hide this stale-binding defect.
  assert.equal(await unregisteredProductionCall(launch, retained), false);
  assert.equal(await unregisteredProductionCall(launch, { ...retained, toolId: "completed-index" }), true);
  assert.equal(await unregisteredProductionCall(launch, { ...retained, toolId: "never-registered" }), true);
});
