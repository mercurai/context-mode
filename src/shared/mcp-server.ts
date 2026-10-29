import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolResultSchema, CancelledNotificationSchema, isJSONRPCErrorResponse,
  isJSONRPCResultResponse, type RequestId } from "@modelcontextprotocol/sdk/types.js";
import type { AuthenticatedScope } from "./identity.js";
import type { SharedRuntime } from "./runtime.js";
import { z } from "zod";

export interface AdmittedRequest {
  controller: AbortController;
  method: string;
  running?: boolean;
}

export interface SharedMcpSession {
  scope: Readonly<AuthenticatedScope>;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  requests: Map<RequestId, AdmittedRequest>;
  closed: boolean;
}

/** SDK protocol state is per transport; storage and tools remain process-wide. */
export async function createSharedMcpSession(options: {
  runtime: SharedRuntime;
  scope: AuthenticatedScope;
  initialized: (session: SharedMcpSession, id: string) => void;
  closed: (session: SharedMcpSession) => void;
}): Promise<SharedMcpSession> {
  const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };
  const server = new McpServer({ name: "context-mode", version });
  const requests = new Map<RequestId, AdmittedRequest>();
  const scope = Object.freeze({ ...options.scope });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    // JSON response completion cleans SDK request mappings even after the
    // caller disconnects. Disconnect itself never cancels the runtime job.
    enableJsonResponse: true,
    onsessioninitialized: (id) => options.initialized(session, id),
  });
  const session: SharedMcpSession = { scope, server, transport, requests, closed: false };
  transport.onclose = () => {
    session.closed = true;
    for (const [id, request] of requests) {
      request.controller.abort();
      // Executing jobs still consume capacity until their actual completion.
      if (!request.running) requests.delete(id);
    }
    options.closed(session);
  };
  const send = transport.send.bind(transport);
  transport.send = async (message, sendOptions) => {
    if (!isJSONRPCResultResponse(message) && !isJSONRPCErrorResponse(message)) {
      return send(message, sendOptions);
    }
    const id = message.id;
    const admitted = id === undefined ? undefined : requests.get(id);
    try {
      // Never expose completed job content after cancellation. Sending a
      // bounded error also lets the SDK finish its own response bookkeeping.
      await send(admitted?.controller.signal.aborted ? {
        jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "Request cancelled" },
      } : message, sendOptions);
    } finally {
      if (id !== undefined) requests.delete(id);
    }
  };
  // SDK 1.26's default cancellation handler ignores request ID 0. Use the
  // public notification API and our admission-owned controllers for all IDs.
  server.server.setNotificationHandler(CancelledNotificationSchema, async (notification) => {
    const admitted = requests.get(notification.params.requestId!);
    if (admitted && admitted.method !== "initialize") admitted.controller.abort();
  });
  for (const tool of options.runtime.listTools()) {
    const inputSchema = tool.config.inputSchema;
    if (!(inputSchema instanceof z.ZodType)) throw new Error("Shared tool schema is unavailable");
    server.registerTool(tool.name, { ...tool.config, inputSchema }, async (args, extra) => {
      const admitted = requests.get(extra.requestId);
      if (!admitted || !transport.sessionId || session.closed) throw new Error("Request was not admitted");
      admitted.running = true;
      try {
        const result = await options.runtime.call(scope, {
          name: tool.name, arguments: args, _meta: extra._meta,
        }, {
          signal: AbortSignal.any([extra.signal, admitted.controller.signal]),
          requestId: extra.requestId, transportSessionId: transport.sessionId,
        });
        return CallToolResultSchema.parse(result);
      } finally {
        // Closed SDK protocols suppress their response; the send wrapper will
        // never run, so release that request only after its handler settles.
        if (session.closed) {
          requests.delete(extra.requestId);
          options.closed(session);
        }
      }
    });
  }
  try {
    await server.connect(transport);
    return session;
  } catch (error) {
    await server.close();
    throw error;
  }
}
