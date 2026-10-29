import { sanitizeMemoryJSON, redactText } from "./memory-sanitization.js";
import type { SharedToolContext } from "./runtime-context.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { resolveExplicitSessionContext } from "../session/attribution-context.js";
import { createEventExtractionState, extractEvents, extractSessionSettings, extractUserEvents,
  type EventExtractionState, type SessionEvent } from "../session/extract.js";
import { buildResumeSnapshot } from "../session/snapshot.js";

/** Supplied only after native identity resolution and owner admission. */
export type SharedMemoryContext = Pick<SharedToolContext,
  "identity" | "ownerId" | "attribution" | "store" | "now">;

/** Native adapters project into this shape; raw hook envelopes are not accepted. */
export type SharedMemoryDelivery = { v: 1; id: string } & (
  | { kind: "prompt"; prompt: string }
  | { kind: "tool"; tool_name: string; tool_input: Record<string, unknown>;
      tool_response?: string; is_error?: boolean; capture?: { sha256: string; originalBytes: number } }
  | { kind: "settings"; model?: string; permission_mode?: string; mcp_servers?: string[] }
  | { kind: "compact" | "session-start" | "session-end" }
);

export interface SharedMemoryResult {
  duplicate: boolean;
  events: number;
  snapshot: string;
}

export interface SharedMemoryIngestor {
  ingest(delivery: unknown): SharedMemoryResult;
  recover(): string;
}

const MAX_STATE_BYTES = 32 * 1024;
const MAX_ERROR_CHARS = 200;
const extractionStateSchema = z.object({
  lastError: z.object({ tool: z.string().min(1).max(256).regex(/^[\w:.-]+$/),
    error: z.string().max(MAX_ERROR_CHARS), callsSince: z.number().int().min(0).max(10) }).strict().nullable(),
  callHistory: z.array(z.object({ tool: z.string().min(1).max(256).regex(/^[\w:.-]+$/),
    inputHash: z.string().max(24).regex(/^\d{1,3}:[\s\S]{0,20}$/) }).strict()).max(50),
}).strict();
const base = { v: z.literal(1), id: z.string().min(1).max(256).regex(/^[^\s\x00-\x1f\x7f]+$/) };
const deliverySchema = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("prompt"), prompt: z.string().min(1) }).strict(),
  z.object({ ...base, kind: z.literal("tool"), tool_name: z.string().min(1).max(256).regex(/^[\w:.-]+$/),
    tool_input: z.record(z.string(), z.unknown()), tool_response: z.string().optional(),
    is_error: z.boolean().optional(), capture: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/),
      originalBytes: z.number().int().min(1).max(16 * 1024 * 1024) }).strict().optional() }).strict(),
  z.object({ ...base, kind: z.literal("settings"), model: z.string().max(256).optional(),
    permission_mode: z.string().max(128).optional(),
    mcp_servers: z.array(z.string().min(1).max(256)).max(64).optional() }).strict(),
  z.object({ ...base, kind: z.literal("compact") }).strict(),
  z.object({ ...base, kind: z.literal("session-start") }).strict(),
  z.object({ ...base, kind: z.literal("session-end") }).strict(),
]);

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function restoreExtractionState(serialized: string | null): EventExtractionState {
  if (serialized === null) return createEventExtractionState();
  try {
    if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) throw new Error();
    const state = extractionStateSchema.parse(JSON.parse(serialized));
    if (state.lastError && redactText(state.lastError.error) !== state.lastError.error) throw new Error();
    return state;
  } catch {
    throw new Error("Invalid persisted shared memory state");
  }
}

/** Truncation can split a safe marker; keep a useful prefix without accepting it partially. */
function boundedErrorSummary(error: string): string {
  // At most 201 bounded redactions. If completing a marker exceeds the state
  // limit, trim the suffix until the existing redactor produces a fitting value.
  for (let end = Math.min(error.length, MAX_ERROR_CHARS); end >= 0; end--) {
    const sanitized = redactText(error.slice(0, end));
    if (sanitized.length <= MAX_ERROR_CHARS) return sanitized;
  }
  throw new Error("Invalid shared memory error summary");
}

/** Validate the canonical, bounded sanitized delivery before storage admission. */
export function sanitizedDelivery(input: unknown): SharedMemoryDelivery {
  const result = deliverySchema.safeParse(sanitizeMemoryJSON(input));
  if (!result.success) throw new Error("Invalid shared memory delivery");
  return result.data;
}

function extractDelivery(delivery: SharedMemoryDelivery, state: EventExtractionState): SessionEvent[] {
  switch (delivery.kind) {
    case "prompt":
      // Reuse the native UserPromptSubmit schema, with admitted text only.
      return [{ type: "user_prompt", category: "user-prompt", priority: 1, data: delivery.prompt },
        ...extractUserEvents(delivery.prompt)];
    case "tool":
      return extractEvents({ tool_name: delivery.tool_name, tool_input: delivery.tool_input,
        tool_response: delivery.tool_response, tool_output: { isError: delivery.is_error } }, state);
    case "settings":
      return extractSessionSettings({ ...delivery,
        mcp_servers: delivery.mcp_servers && Object.fromEntries(delivery.mcp_servers.map((name) => [name, {}])) });
    default:
      return [];
  }
}

function explicitOwner(context: Readonly<SharedMemoryContext>) {
  const attribution = resolveExplicitSessionContext(context.attribution);
  const identity = context.identity;
  const project = digest([identity.provider, identity.home, identity.workspace]);
  const ownerId = digest([project, identity.sessionId, identity.threadId ?? identity.agentId ?? identity.sessionId]);
  if (!attribution || attribution.sessionId !== context.ownerId || context.ownerId !== ownerId ||
      attribution.workspaceDir !== identity.workspace || typeof context.now !== "function") {
    throw new Error("Invalid shared memory owner");
  }
  return attribution;
}

/** Borrowed storage remains owned by the shared runtime throughout this lifetime. */
export function createSharedMemoryIngestor(
  context: Readonly<SharedMemoryContext>,
  options: { maxDeliveries: number },
): SharedMemoryIngestor {
  const { maxDeliveries } = options;
  if (!Number.isSafeInteger(maxDeliveries) || maxDeliveries < 1 || maxDeliveries > 100_000) {
    throw new Error("Invalid shared memory delivery capacity");
  }
  const owner = explicitOwner(context), { db, sessionId, workspaceDir } = owner;
  const { store, now } = context;

  function recover(): string {
    if (db.getSessionStats(sessionId)?.project_dir !== workspaceDir) throw new Error("Invalid shared memory owner");
    const events = db.getEvents(sessionId, { limit: 1000 });
    if (events.length) {
      store.index({ source: "session-events", attribution: { sessionId },
        content: events.map((event) => `## ${event.category}: ${event.type}\n\n${event.data}`).join("\n\n") });
    }
    const snapshot = buildResumeSnapshot(events, { now: () => new Date(now()), maxChars: 10_000 });
    db.upsertResume(sessionId, snapshot, events.length);
    return snapshot;
  }

  return {
    ingest(input) {
      const delivery = sanitizedDelivery(input);
      const previousExtractionState = db.getSharedMemoryExtractionState(sessionId);
      const candidateState = restoreExtractionState(previousExtractionState);
      const events = extractDelivery(delivery, candidateState);
      if (candidateState.lastError) candidateState.lastError.error = boundedErrorSummary(candidateState.lastError.error);
      const extractionState = JSON.stringify(candidateState);
      // Apply the same bounds to newly generated state before it reaches SQLite.
      restoreExtractionState(extractionState);
      const result = db.applySharedMemoryDelivery({ sessionId, workspaceDir,
        deliveryId: digest(delivery.id), fingerprint: digest(delivery), maxDeliveries, events,
        previousExtractionState, extractionState, sourceHook: `shared:${delivery.kind}` });
      return { ...result, snapshot: recover() };
    },
    recover,
  };
}
