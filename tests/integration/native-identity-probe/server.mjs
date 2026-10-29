// Synthetic loopback MCP Streamable-HTTP server used to observe which trusted identity metadata each installed
// native client sends. Diagnostic only: one synthetic tool, no shell/file tools. Real identifiers stay in memory and
// leave only as ordinal aliases (u1, s1, c1 ...); the capability is never logged or returned.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { performance } from "node:perf_hooks";
import { isAbsolute, normalize } from "node:path";
import { createOverlapController } from "./overlap.mjs";
import { summarizeMemoryHooks, validMemoryHookProjection } from "./memory-hooks.mjs";
import { validCodexPromptTarget } from "./codex-prompt-evidence.mjs";

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const TOOL = {
  name: "identity_echo",
  description: "Synthetic diagnostic: returns the aliased identity the server resolved for this call.",
  inputSchema: { type: "object", properties: { note: { type: "string" } }, additionalProperties: false },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

const digest = (text) => createHash("sha256").update(text).digest();
const identifier = (value) => typeof value === "string" && value.length > 0 && value.length <= 1024;
const canonical = (value) => process.platform === "win32" ? normalize(value).toLowerCase() : normalize(value);

class Aliases {
  #seen = new Map();
  constructor(prefix) {
    this.prefix = prefix;
  }
  peek(value) {
    return this.#seen.get(value);
  }
  of(value) {
    if (!this.#seen.has(value)) this.#seen.set(value, `${this.prefix}${this.#seen.size + 1}`);
    return this.#seen.get(value);
  }
}

export function createProbeServer({ capability, expectedCwd, launches, memoryHooks, codexPromptStop }) {
  if (launches !== undefined && (!Array.isArray(launches) || launches.length === 0)) throw new Error("invalid launch scopes");
  const scopes = (launches ?? [{ capability, workspace: expectedCwd }]).map((launch, index) => {
    if (!identifier(launch.capability) || (launches && (!["codex", "claude"].includes(launch.provider) || !isAbsolute(launch.home ?? "") || !isAbsolute(launch.workspace ?? "")))) throw new Error("invalid launch scope");
    return Object.freeze({ id: `l${index + 1}`, provider: launch.provider, home: launch.home, workspace: launch.workspace && canonical(launch.workspace), expected: digest(`Bearer ${launch.capability}`) });
  });
  if (scopes.some((scope, index) => scopes.slice(index + 1).some((other) => timingSafeEqual(scope.expected, other.expected)))) throw new Error("duplicate launch capability");
  const scopedKey = (scope, key) => scope.provider ? JSON.stringify([scope.id, key]) : key;
  const identities = new Aliases("u");
  const sessions = new Aliases("s");
  const agents = new Aliases("a");
  const connections = new Aliases("c");
  const toolUse = new Map(); // Claude tool_use_id -> { sessionId, agentId }
  const codexThreads = new Map(); // Authenticated start hook -> concrete thread and root lineage.
  const stats = { authRejected: 0, unbound: 0, bound: 0, hookRegistered: 0, hookIgnored: 0, requests: 0, hookCwdMatchesLaunch: 0, turnMetadataHasLaunchWorkspace: 0 };
  const metaKeys = new Set();
  const hookKeys = new Set();
  const turnMetadataKeys = new Set();
  const argumentKeys = new Set();
  const calls = [];
  const byIdentity = new Map();
  const overlap = createOverlapController();
  const memoryNames = new Set(["root-A", "root-B", "resume-A", "child", "concurrent-1", "concurrent-2", "mixed"]);
  const memoryError = (code) => Object.assign(new Error(code), { code });
  if (memoryHooks !== undefined && (!memoryHooks || Object.keys(memoryHooks).some((key) => key !== "flows") ||
      !Array.isArray(memoryHooks.flows) || memoryHooks.flows.length < 1 || memoryHooks.flows.length > 14 ||
      memoryHooks.flows.some((flow, index, all) => !flow || Object.keys(flow).length !== 2 ||
        !memoryNames.has(flow.name) || scopes.filter((scope) => scope.provider === flow.provider).length !== 1 ||
        all.slice(0, index).some((prior) => prior.provider === flow.provider && prior.name === flow.name)))) {
    throw memoryError("MEMORY_FLOW_CONFIGURATION");
  }
  // These records attribute diagnostic invocations; identity remains owned by the existing registries.
  const memoryFlows = (memoryHooks?.flows ?? []).map(({ provider, name }) => ({
    scope: scopes.find((scope) => scope.provider === provider), name, used: false, finished: false, expected: undefined, observations: [],
  }));
  let memoryClosed = false, memoryFailure, memorySummary, memoryReceived = 0;
  if (codexPromptStop && (!memoryHooks || typeof codexPromptStop.read !== "function")) {
    throw memoryError("CODEX_PROMPT_STOP_OPTIONS_INVALID");
  }
  const stopNow = codexPromptStop?.now ?? (() => performance.now());
  let stopPending, stopFailure, stopReads = 0, stopMatches = 0;
  const failStop = (code) => {
    stopFailure ??= code;
    return failMemory(code);
  };
  const failMemory = (code) => {
    memoryFailure ??= code;
    for (const flow of memoryFlows) flow.observations.length = 0;
    memorySummary = undefined;
    return memoryError(code);
  };
  const findMemoryFlow = (cap) => {
    const expected = digest(`Bearer ${cap}`);
    return memoryFlows.find((flow) => flow.expected && timingSafeEqual(flow.expected, expected));
  };
  function beginMemoryFlow(cap, name) {
    if (!memoryHooks) throw memoryError("MEMORY_DIAGNOSTICS_DISABLED");
    if (memoryClosed) throw memoryError("MEMORY_DIAGNOSTICS_CLOSED");
    const expected = digest(`Bearer ${cap}`);
    const scope = scopes.find((candidate) => timingSafeEqual(candidate.expected, expected));
    const flow = memoryFlows.find((candidate) => candidate.scope === scope && candidate.name === name);
    if (!flow || flow.used) throw memoryError("MEMORY_FLOW_INVALID");
    if (memoryFlows.filter((candidate) => candidate.expected).length >= 2) throw memoryError("MEMORY_FLOW_CAPACITY");
    const grant = randomBytes(24).toString("base64url");
    flow.expected = digest(`Bearer ${grant}`); flow.used = true;
    flow.callStart = calls.length;
    return grant;
  }
  function memoryOwner(flow, hook, root) {
    const scope = flow.scope;
    if (hook.cwd !== scope.workspace) return undefined;
    const base = { provider: scope.provider, home: scope.home, workspace: scope.workspace, launchId: scope.id, sessionId: root };
    if (scope.provider === "codex") {
      const threadId = hook.agentId ?? hook.sessionId;
      const registered = codexThreads.get(scopedKey(scope, threadId));
      if (!registered || registered.sessionId !== root ||
          (hook.sessionId !== root && hook.sessionId !== threadId) ||
          (threadId !== root && hook.agentId !== threadId)) return undefined;
      const alias = identities.peek(scopedKey(scope, `codex:${threadId}`));
      return alias && byIdentity.has(alias) ? { ...base, threadId } : undefined;
    }
    if (hook.sessionId !== root) return undefined;
    // The map contains bounded tool registrations, not an inferred recent owner.
    const registered = [...toolUse].some(([key, value]) => value && JSON.parse(key)[0] === scope.id &&
      value.sessionId === root && value.agentId === hook.agentId);
    const alias = identities.peek(scopedKey(scope, `claude:${hook.agentId ?? root}`));
    return registered && alias && byIdentity.has(alias) ? { ...base, ...(hook.agentId ? { agentId: hook.agentId } : {}) } : undefined;
  }
  function finishMemoryFlow(cap, nativeRootId, succeeded, qualification) {
    if (!memoryHooks) throw memoryError("MEMORY_DIAGNOSTICS_DISABLED");
    if (memoryClosed) throw memoryError("MEMORY_DIAGNOSTICS_CLOSED");
    const flow = findMemoryFlow(cap);
    if (!flow) throw memoryError("MEMORY_FLOW_INVALID");
    flow.expected = undefined; flow.finished = true; // Revoke before every failure path.
    if (codexPromptStop && flow.scope.provider === "codex" && ["root-A", "resume-A"].includes(flow.name)) {
      const target = flow.stopTarget;
      flow.stopTarget = undefined;
      if (!succeeded) { failStop("CODEX_PROMPT_STOP_IDENTITY"); return; }
      if (!succeeded || !target || target.sessionId !== nativeRootId) {
        throw failStop("CODEX_PROMPT_STOP_IDENTITY");
      }
      stopMatches++;
    }
    if (succeeded !== true || !identifier(nativeRootId)) { failMemory("MEMORY_FLOW_FAILED"); return; }
    if (memoryFailure) throw memoryError(memoryFailure);
    if (flow.observations.length === 0) throw failMemory("MEMORY_HOOK_MISSING");
    for (const observation of flow.observations) {
      const identity = memoryOwner(flow, observation.hook, nativeRootId);
      if (!identity) throw failMemory("MEMORY_HOOK_UNBOUND");
      observation.identity = identity;
    }
    let target;
    if (qualification?.codexPromptTarget === true) {
      try { target = promptTarget(flow, nativeRootId); }
      catch { throw failMemory("CODEX_PROMPT_TARGET_INVALID"); }
    }
    try {
      const summary = summarizeMemoryHooks(memoryFlows.filter((item) => item.finished).flatMap((item) => item.observations));
      if (memoryFlows.every((item) => item.finished)) {
        memorySummary = summary;
        for (const item of memoryFlows) item.observations.length = 0;
      }
    } catch { throw failMemory("MEMORY_HOOK_CAPACITY"); }
    // Internal runner return only. report()/HTTP contain fixed summaries, never this target.
    return target;
  }
  function receiveMemory(body, flow) {
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).length !== 1 || !Object.hasOwn(body, "memory")) {
      return 403;
    }
    if (!validMemoryHookProjection(flow.scope.provider, body.memory)) { failMemory("MEMORY_HOOK_INVALID"); return 400; }
    if (memoryFailure) return 409;
    if (memoryReceived >= 512) { failMemory("MEMORY_HOOK_CAPACITY"); return 429; }
    memoryReceived++;
    const scope = flow.scope;
    flow.observations.push({ scope: { provider: scope.provider, home: scope.home, workspace: scope.workspace, launchId: scope.id },
      flow: flow.name, hook: body.memory });
    return 202;
  }
  function promptTarget(flow, root) {
    const prompts = flow.observations.filter(({ hook }) => hook.event === "UserPromptSubmit");
    const stops = flow.observations.filter(({ hook }) => hook.event === "Stop");
    const turnId = prompts[0]?.hook.turnId;
    if (!prompts.length || !stops.length || !turnId || flow.observations.some(({ hook }) => {
      const identity = memoryOwner(flow, hook, root);
      return !identity || identity.provider !== "codex" || identity.threadId !== root || hook.agentId !== undefined ||
        (["UserPromptSubmit", "Stop"].includes(hook.event) && hook.turnId !== turnId);
    })) throw memoryError("CODEX_PROMPT_TARGET_INVALID");
    const target = { ...memoryOwner(flow, prompts[0].hook, root), flow: flow.name, turnId };
    if (!validCodexPromptTarget(target)) throw memoryError("CODEX_PROMPT_TARGET_INVALID");
    return target;
  }
  async function readPromptAtStop(flow, response, arrived) {
    if (stopPending) { failStop("CODEX_PROMPT_STOP_CAPACITY"); return 429; }
    if (flow.stopStarted) { failStop("CODEX_PROMPT_STOP_IDENTITY"); return 409; }
    let target;
    try {
      const current = calls.slice(flow.callStart).filter((call) => call.scope === flow.scope.id);
      if (current.length !== 1 || !current[0].bound || current[0].kind !== "codex" || current[0].lineage !== "root") throw new Error();
      const roots = [...codexThreads].filter(([key, value]) => {
        const [scopeId, threadId] = JSON.parse(key);
        return scopeId === flow.scope.id && threadId === value.sessionId &&
          identities.peek(scopedKey(flow.scope, `codex:${threadId}`)) === current[0].identity;
      });
      if (roots.length !== 1) throw new Error();
      target = promptTarget(flow, roots[0][1].sessionId);
    } catch { failStop("CODEX_PROMPT_STOP_IDENTITY"); return 409; }
    const remaining = 8000 - (stopNow() - arrived);
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 8000) {
      failStop("CODEX_PROMPT_TIMEOUT"); return 503;
    }
    flow.stopStarted = true;
    let disconnected = response.destroyed;
    const onClose = () => { disconnected = true; failStop("CODEX_PROMPT_STOP_IDENTITY"); };
    response.once("close", onClose);
    // The reader owns its deadline and cleanup. Never abandon a live child via a timeout race.
    const pending = Promise.resolve().then(() => codexPromptStop.read(target, { phaseBudgetMs: remaining }));
    stopPending = pending;
    try {
      await pending;
      if (memoryClosed || disconnected || !flow.expected || stopFailure) {
        failStop("CODEX_PROMPT_STOP_IDENTITY"); return 409;
      }
      const elapsed = stopNow() - arrived;
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= 8000) {
        failStop("CODEX_PROMPT_TIMEOUT"); return 503;
      }
      flow.stopTarget = target;
      stopReads++;
      return 202;
    } catch (error) {
      const allowed = ["CODEX_PROMPT_TIMEOUT", "CODEX_PROMPT_LIMIT", "CODEX_PROMPT_TARGET_INVALID", "CODEX_PROMPT_HISTORY_UNSUPPORTED"];
      failStop(allowed.includes(error?.code) ? error.code : "CODEX_PROMPT_EVIDENCE_INVALID");
      return 503;
    } finally {
      response.off("close", onClose);
      if (stopPending === pending) stopPending = undefined;
    }
  }
  function stopReport() {
    if (memoryClosed) return { status: "closed" };
    if (stopFailure) return { status: "failed", failure: stopFailure };
    return stopReads === 2 && stopMatches === 2 ? { status: "complete", reads: 2, nativeMatches: 2 } : { status: "pending" };
  }
  function memoryReport() {
    if (memoryClosed) return { status: "closed" };
    if (memoryFailure) return { status: "failed", failure: memoryFailure };
    if (memorySummary) return { status: "complete", summary: structuredClone(memorySummary) };
    return { status: "pending" };
  }

  const authorized = (request) => {
    const given = digest(String(request.headers.authorization ?? ""));
    return scopes.find((scope) => timingSafeEqual(given, scope.expected));
  };

  const reply = (response, status, body) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    response.end(text);
  };

  const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

  // Identity comes only from trusted client metadata (and, for Claude, a hook-registered tool_use_id); never from arguments.
  function resolve(meta, scope) {
    if (typeof meta?.threadId === "string" && meta.threadId) {
      const sessionId = typeof meta.sessionId === "string" ? meta.sessionId : undefined;
      const registered = codexThreads.get(scopedKey(scope, meta.threadId));
      if (scope.provider && (scope.provider !== "codex" || !registered || registered.sessionId !== sessionId)) return undefined;
      return {
        kind: "codex",
        key: scopedKey(scope, `codex:${meta.threadId}`),
        sessionId,
        lineage: sessionId === undefined ? "unknown" : sessionId === meta.threadId ? "root" : "child",
      };
    }
    const toolUseId = meta?.["claudecode/toolUseId"];
    if (scope.provider && scope.provider !== "claude") return undefined;
    const registered = typeof toolUseId === "string" ? toolUse.get(scopedKey(scope, toolUseId)) : undefined;
    if (registered) {
      return {
        kind: "claude",
        key: scopedKey(scope, `claude:${registered.agentId ?? registered.sessionId}`),
        sessionId: registered.sessionId,
        lineage: registered.agentId ? "child" : "root",
        agentId: registered.agentId,
      };
    }
    return undefined;
  }

  // Key names only; the one value ever compared is the launch directory the orchestrator itself chose.
  function noteTurnMetadata(raw) {
    let parsed = raw;
    if (typeof raw === "string") {
      try { parsed = JSON.parse(raw); } catch { return; }
    }
    if (!parsed || typeof parsed !== "object") return;
    for (const key of Object.keys(parsed)) turnMetadataKeys.add(key);
    if (expectedCwd && JSON.stringify(parsed).includes(JSON.stringify(expectedCwd).slice(1, -1))) stats.turnMetadataHasLaunchWorkspace += 1;
  }

  async function handleToolCall(message, socket, scope, response) {
    const meta = message.params?._meta;
    for (const key of Object.keys(meta ?? {})) metaKeys.add(key);
    for (const key of Object.keys(message.params?.arguments ?? {})) argumentKeys.add(key);
    noteTurnMetadata(meta?.["x-codex-turn-metadata"]);
    const identity = resolve(meta, scope);
    if (!identity) {
      stats.unbound += 1;
      calls.push({ bound: false, connection: connections.of(socket) });
      return rpcError(message.id, -32001, "unbound identity");
    }
    stats.bound += 1;
    const alias = identities.of(identity.key);
    const record = {
      bound: true,
      kind: identity.kind,
      identity: alias,
      session: identity.sessionId === undefined ? null : sessions.of(scopedKey(scope, identity.sessionId)),
      agent: identity.agentId === undefined ? null : agents.of(scopedKey(scope, identity.agentId)),
      lineage: identity.lineage,
      connection: connections.of(socket),
      ...(scope.provider ? { scope: scope.id, workspaceBound: true } : {}),
    };
    calls.push(record);
    const entry = byIdentity.get(alias) ?? { calls: 0, connections: new Set() };
    entry.calls += 1;
    entry.connections.add(record.connection);
    byIdentity.set(alias, entry);
    const overlapError = await overlap.enter(record, response);
    if (overlapError) return rpcError(message.id, -32002, overlapError);
    const { bound: _bound, ...visible } = record;
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: JSON.stringify(visible) }] },
    };
  }

  function handleRpc(message, socket, scope, response) {
    if (!message || typeof message !== "object") return rpcError(null, -32600, "invalid request");
    switch (message.method) {
      case "initialize": {
        const wanted = message.params?.protocolVersion;
        return {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: PROTOCOLS.includes(wanted) ? wanted : PROTOCOLS[0],
            capabilities: { tools: {} },
            serverInfo: { name: "identity-probe", version: "0.0.0" },
          },
        };
      }
      case "ping":
        return { jsonrpc: "2.0", id: message.id, result: {} };
      case "tools/list":
        return { jsonrpc: "2.0", id: message.id, result: { tools: [TOOL] } };
      case "tools/call":
        if (message.params?.name !== TOOL.name) return rpcError(message.id, -32602, "unknown tool");
        return handleToolCall(message, socket, scope, response);
      default:
        return message.id === undefined ? undefined : rpcError(message.id, -32601, "method not found");
    }
  }

  function register(map, key, record) {
    if (map.has(key) && JSON.stringify(map.get(key)) !== JSON.stringify(record)) { map.set(key, null); return 409; }
    if (!map.has(key) && toolUse.size + codexThreads.size >= 512) return 429;
    map.set(key, record);
    stats.hookRegistered += 1;
    return 200;
  }

  function handleHook(input, scope) {
    for (const key of Object.keys(input ?? {})) hookKeys.add(key);
    if (scope.workspace && typeof input?.cwd === "string" && canonical(input.cwd) === scope.workspace) stats.hookCwdMatchesLaunch += 1;
    if (scope.provider && (!identifier(input?.cwd) || !isAbsolute(input.cwd) || canonical(input.cwd) !== scope.workspace)) return 403;
    if (scope.provider === "codex") {
      if (!identifier(input.session_id)) return 403;
      if (input.hook_event_name === "SessionStart") return register(codexThreads, scopedKey(scope, input.session_id), { sessionId: input.session_id });
      if (input.hook_event_name !== "SubagentStart" || !identifier(input.agent_id) || input.agent_id === input.session_id || !codexThreads.get(scopedKey(scope, input.session_id))) return 403;
      return register(codexThreads, scopedKey(scope, input.agent_id), { sessionId: input.session_id, agentId: input.agent_id });
    }
    const registrable =
      input?.hook_event_name === "PreToolUse" &&
      input.tool_name === "mcp__probe__identity_echo" &&
      identifier(input.tool_use_id) && identifier(input.session_id) &&
      (input.agent_id === undefined || identifier(input.agent_id));
    if (!registrable) {
      stats.hookIgnored += 1;
      return scope.provider ? 403 : 200;
    }
    return register(toolUse, scopedKey(scope, input.tool_use_id), {
      sessionId: input.session_id,
      agentId: typeof input.agent_id === "string" ? input.agent_id : undefined,
    });
  }

  const server = http.createServer((request, response) => {
    const arrived = stopNow();
    stats.requests += 1;
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const given = digest(String(request.headers.authorization ?? ""));
    const memoryFlow = !memoryClosed && path === "/hook" && request.method === "POST" ?
      memoryFlows.find((flow) => flow.expected && timingSafeEqual(flow.expected, given)) : undefined;
    const scope = memoryFlow?.scope ?? authorized(request);
    if (!scope) {
      stats.authRejected += 1;
      return reply(response, 401, { error: "unauthorized" });
    }
    if (request.method === "GET" && path === "/report") return reply(response, 200, report());
    if (request.method === "GET" && path === "/mcp") return reply(response, 405, { error: "no stream" });
    if (request.method === "DELETE" && path === "/mcp") return reply(response, 200, {});
    if (request.method !== "POST" || (path !== "/mcp" && path !== "/hook")) return reply(response, 404, {});
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (memoryFlow && size > 65_536) {
        chunks.length = 0;
        failMemory("MEMORY_HOOK_CAPACITY");
        if (!response.writableEnded) reply(response, 413, { error: "memory observation rejected" });
        return;
      }
      if (size > 1_000_000) request.destroy();
      else chunks.push(chunk);
    });
    request.on("aborted", () => {
      if (memoryFlow?.expected && !response.writableEnded) failMemory("MEMORY_HOOK_INVALID");
    });
    request.on("end", async () => {
      if (response.writableEnded) return;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        chunks.length = 0;
      } catch {
        chunks.length = 0;
        if (memoryFlow) failMemory("MEMORY_HOOK_INVALID");
        return reply(response, 400, rpcError(null, -32700, "parse error"));
      }
      if (path === "/hook") {
        if (memoryFlow) {
          if (!memoryFlow.expected || memoryClosed) return reply(response, 401, { error: "unauthorized" });
          // A flow capability never reaches handleHook or either identity registry.
          const status = Object.hasOwn(body ?? {}, "memory") && Object.keys(body).length !== 1 ?
            (failMemory("MEMORY_HOOK_INVALID"), 400) : receiveMemory(body, memoryFlow);
          if (status === 202 && codexPromptStop && memoryFlow.scope.provider === "codex" &&
              ["root-A", "resume-A"].includes(memoryFlow.name) && body.memory.event === "Stop") {
            const stopStatus = await readPromptAtStop(memoryFlow, response, arrived);
            if (response.destroyed) return;
            return reply(response, stopStatus, stopStatus === 202 ? { observed: true } : { error: "memory observation rejected" });
          }
          return reply(response, status, status === 202 ? { observed: true } : { error: "memory observation rejected" });
        }
        if (Object.hasOwn(body ?? {}, "memory")) return reply(response, 403, { error: "memory observation rejected" });
        const status = handleHook(body, scope);
        return reply(response, status, status === 200 ? {} : { error: "hook registration rejected" });
      }
      const answers = (await Promise.all((Array.isArray(body) ? body : [body])
        .map((message) => handleRpc(message, request.socket, scope, response))))
        .filter((answer) => answer !== undefined);
      if (response.destroyed) return;
      if (answers.length === 0) return reply(response, 202);
      return reply(response, 200, Array.isArray(body) ? answers : answers[0]);
    });
  });

  function report() {
    return {
      stats: { ...stats },
      metaKeys: [...metaKeys].sort(),
      hookKeys: [...hookKeys].sort(),
      turnMetadataKeys: [...turnMetadataKeys].sort(),
      argumentKeys: [...argumentKeys].sort(),
      identities: [...byIdentity].map(([alias, entry]) => ({
        alias,
        calls: entry.calls,
        connections: [...entry.connections].sort(),
      })),
      calls: calls.map((call) => ({ ...call })),
      barriers: overlap.report(),
      ...(memoryHooks ? { memory: memoryReport() } : {}),
      ...(codexPromptStop ? { codexPromptStop: stopReport() } : {}),
    };
  }

  return {
    server,
    report,
    beginMemoryFlow,
    finishMemoryFlow,
    armBarrier: overlap.arm,
    // For the orchestrator only: the alias this server gave an identity key it was told out of band.
    aliasForKey: (key, launchCapability) => {
      const scope = launchCapability ? scopes.find((value) => timingSafeEqual(value.expected, digest(`Bearer ${launchCapability}`))) : scopes.find((value) => !value.provider);
      return scope ? identities.peek(scopedKey(scope, key)) : undefined;
    },
    listen: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(server.address().port); });
      }),
    close: async () => {
        memoryClosed = true;
        memorySummary = undefined;
        for (const flow of memoryFlows) { flow.expected = undefined; flow.stopTarget = undefined; flow.observations.length = 0; }
        overlap.close();
        server.closeAllConnections?.();
        await Promise.all([new Promise((resolve) => server.close(() => resolve())), stopPending?.catch(() => {})]);
      },
  };
}
