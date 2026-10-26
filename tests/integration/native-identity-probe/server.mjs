// Synthetic loopback MCP Streamable-HTTP server used to observe which trusted identity metadata each installed
// native client sends. Diagnostic only: one synthetic tool, no shell/file tools. Real identifiers stay in memory and
// leave only as ordinal aliases (u1, s1, c1 ...); the capability is never logged or returned.
import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const TOOL = {
  name: "identity_echo",
  description: "Synthetic diagnostic: returns the aliased identity the server resolved for this call.",
  inputSchema: { type: "object", properties: { note: { type: "string" } }, additionalProperties: false },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

const digest = (text) => createHash("sha256").update(text).digest();

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

export function createProbeServer({ capability, expectedCwd }) {
  const expected = digest(`Bearer ${capability}`);
  const identities = new Aliases("u");
  const sessions = new Aliases("s");
  const agents = new Aliases("a");
  const connections = new Aliases("c");
  const toolUse = new Map(); // Claude tool_use_id -> { sessionId, agentId }
  const stats = { authRejected: 0, unbound: 0, bound: 0, hookRegistered: 0, hookIgnored: 0, requests: 0, hookCwdMatchesLaunch: 0, turnMetadataHasLaunchWorkspace: 0 };
  const metaKeys = new Set();
  const hookKeys = new Set();
  const turnMetadataKeys = new Set();
  const argumentKeys = new Set();
  const calls = [];
  const byIdentity = new Map();

  const authorized = (request) => {
    const given = digest(String(request.headers.authorization ?? ""));
    return timingSafeEqual(given, expected);
  };

  const reply = (response, status, body) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    response.end(text);
  };

  const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

  // Identity comes only from trusted client metadata (and, for Claude, a hook-registered tool_use_id); never from arguments.
  function resolve(meta) {
    if (typeof meta?.threadId === "string" && meta.threadId) {
      const sessionId = typeof meta.sessionId === "string" ? meta.sessionId : undefined;
      return {
        kind: "codex",
        key: `codex:${meta.threadId}`,
        sessionId,
        lineage: sessionId === undefined ? "unknown" : sessionId === meta.threadId ? "root" : "child",
      };
    }
    const toolUseId = meta?.["claudecode/toolUseId"];
    const registered = typeof toolUseId === "string" ? toolUse.get(toolUseId) : undefined;
    if (registered) {
      return {
        kind: "claude",
        key: `claude:${registered.agentId ?? registered.sessionId}`,
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

  function handleToolCall(message, socket) {
    const meta = message.params?._meta;
    for (const key of Object.keys(meta ?? {})) metaKeys.add(key);
    for (const key of Object.keys(message.params?.arguments ?? {})) argumentKeys.add(key);
    noteTurnMetadata(meta?.["x-codex-turn-metadata"]);
    const identity = resolve(meta);
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
      session: identity.sessionId === undefined ? null : sessions.of(identity.sessionId),
      agent: identity.agentId === undefined ? null : agents.of(identity.agentId),
      lineage: identity.lineage,
      connection: connections.of(socket),
    };
    calls.push(record);
    const entry = byIdentity.get(alias) ?? { calls: 0, connections: new Set() };
    entry.calls += 1;
    entry.connections.add(record.connection);
    byIdentity.set(alias, entry);
    const { bound: _bound, ...visible } = record;
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: JSON.stringify(visible) }] },
    };
  }

  function handleRpc(message, socket) {
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
        return handleToolCall(message, socket);
      default:
        return message.id === undefined ? undefined : rpcError(message.id, -32601, "method not found");
    }
  }

  function handleHook(input) {
    for (const key of Object.keys(input ?? {})) hookKeys.add(key);
    if (expectedCwd && input?.cwd === expectedCwd) stats.hookCwdMatchesLaunch += 1;
    const registrable =
      input?.hook_event_name === "PreToolUse" &&
      String(input.tool_name ?? "").startsWith("mcp__probe__") &&
      typeof input.tool_use_id === "string" &&
      typeof input.session_id === "string";
    if (!registrable) {
      stats.hookIgnored += 1;
      return;
    }
    toolUse.set(input.tool_use_id, {
      sessionId: input.session_id,
      agentId: typeof input.agent_id === "string" ? input.agent_id : undefined,
    });
    stats.hookRegistered += 1;
  }

  const server = http.createServer((request, response) => {
    stats.requests += 1;
    if (!authorized(request)) {
      stats.authRejected += 1;
      return reply(response, 401, { error: "unauthorized" });
    }
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method === "GET" && path === "/report") return reply(response, 200, report());
    if (request.method === "GET" && path === "/mcp") return reply(response, 405, { error: "no stream" });
    if (request.method === "DELETE" && path === "/mcp") return reply(response, 200, {});
    if (request.method !== "POST" || (path !== "/mcp" && path !== "/hook")) return reply(response, 404, {});
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) request.destroy();
      else chunks.push(chunk);
    });
    request.on("end", () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return reply(response, 400, rpcError(null, -32700, "parse error"));
      }
      if (path === "/hook") {
        handleHook(body);
        return reply(response, 200, {});
      }
      const answers = (Array.isArray(body) ? body : [body])
        .map((message) => handleRpc(message, request.socket))
        .filter((answer) => answer !== undefined);
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
    };
  }

  return {
    server,
    report,
    // For the orchestrator only: the alias this server gave an identity key it was told out of band.
    aliasForKey: (key) => identities.peek(key),
    listen: () =>
      new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port))),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
