import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { SharedLaunchAuthority } from "./launch-authority.js";
import type { SharedMemoryRuntime } from "./runtime.js";
import type { AuthenticatedScope, ResolvedIdentity } from "./identity.js";
import { sanitizedDelivery, type SharedMemoryDelivery } from "./memory-ingestion.js";

export type MemoryHookCode = "unauthorized" | "invalid" | "unsupported" | "conflict" | "capacity" | "draining" | "storage";
const STATUS: Record<MemoryHookCode, number> = {
  unauthorized: 401, invalid: 400, unsupported: 422, conflict: 409, capacity: 429, draining: 503, storage: 503,
};

/** Fixed public diagnostics only; never retain native payloads or storage errors. */
export class MemoryHookFailure extends Error {
  readonly status: number;
  constructor(readonly code: MemoryHookCode) {
    super(`Memory hook ${code}`);
    this.status = STATUS[code];
  }
}

export type MemoryHookResult = { status: "registered" | "applied" | "duplicate" } |
  { status: "recovered"; recovery: string };
export type MemoryHookProcessor = (request: IncomingMessage, payload: unknown) => Promise<MemoryHookResult>;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new MemoryHookFailure("invalid");
  return value as Record<string, unknown>;
}

function own(input: Record<string, unknown>, key: string): unknown {
  const property = Object.getOwnPropertyDescriptor(input, key);
  if (property && !("value" in property)) throw new MemoryHookFailure("invalid");
  return property?.value;
}

function identifier(input: Record<string, unknown>, key: string): string {
  const value = own(input, key);
  if (typeof value !== "string" || !value || value.length > 256 || /[\s\x00-\x1f\x7f]/.test(value)) {
    throw new MemoryHookFailure("invalid");
  }
  return value;
}

function deliveryId(family: string, nativeId: string): string {
  return createHash("sha256").update(JSON.stringify([family, nativeId])).digest("hex");
}

function projectDelivery(input: Record<string, unknown>, event: string): SharedMemoryDelivery {
  const raw = event === "UserPromptSubmit"
    ? { v: 1, kind: "prompt", id: deliveryId("prompt", identifier(input, "prompt_id")), prompt: own(input, "prompt") }
    : { v: 1, kind: "tool", id: deliveryId("tool-completion", identifier(input, "tool_use_id")),
      tool_name: identifier(input, "tool_name"), tool_input: record(own(input, "tool_input")),
      is_error: event === "PostToolUseFailure",
      ...(own(input, "capture") === undefined ? {} : { capture: own(input, "capture") }),
      ...(own(input, "tool_response") !== undefined ? { tool_response: own(input, "tool_response") }
        : event === "PostToolUseFailure" && own(input, "error") !== undefined ? { tool_response: own(input, "error") } : {}) };
  try { return sanitizedDelivery(raw); }
  catch { throw new MemoryHookFailure("invalid"); }
}

function registrationFailure(error: unknown): never {
  if (error instanceof Error && error.message === "Identity registry capacity exhausted") throw new MemoryHookFailure("capacity");
  if (error instanceof Error && error.message === "Ambiguous identity registration") throw new MemoryHookFailure("conflict");
  throw new MemoryHookFailure("invalid");
}

function runtimeFailure(error: unknown): never {
  // Existing internal APIs expose these fixed errors. Do not classify arbitrary
  // storage text by regex or return its message to the hook client.
  const message = error instanceof Error ? error.message : "";
  if (message === "Conflicting shared memory delivery") throw new MemoryHookFailure("conflict");
  if (["Shared session capacity exceeded", "Shared project capacity exceeded", "Shared memory delivery capacity exceeded"].includes(message)) {
    throw new MemoryHookFailure("capacity");
  }
  if (message === "Shared runtime is closed") throw new MemoryHookFailure("draining");
  if (message === "Shared launch is inactive") throw new MemoryHookFailure("unauthorized");
  throw new MemoryHookFailure("storage");
}

/** Composition only: identity, storage, admission and receipts retain their existing owners. */
export function createMemoryHookProcessor(authority: SharedLaunchAuthority, runtime: SharedMemoryRuntime): MemoryHookProcessor {
  return async (request, payload) => {
    // HTTP schedules this processor after admission. Reauthenticate at that last
    // asynchronous boundary; resolution and runtime admission below are synchronous.
    let scope: Readonly<AuthenticatedScope>;
    try { scope = authority.authenticateHook(request); }
    catch { throw new MemoryHookFailure("unauthorized"); }
    const input = record(payload), event = identifier(input, "hook_event_name");
    const registration = ["SessionStart", "SubagentStart", "PreToolUse"].includes(event);
    if (!registration && !["UserPromptSubmit", "PostToolUse", "PostToolUseFailure"].includes(event)) {
      throw new MemoryHookFailure("unsupported");
    }
    let identity: Readonly<ResolvedIdentity>;
    try {
      if (registration) authority.registerMemoryHook(request, input);
      identity = authority.resolveMemoryHook(request, input);
    } catch (error) {
      try { authority.authenticateHook(request); }
      catch { throw new MemoryHookFailure("unauthorized"); }
      registrationFailure(error);
    }
    if (event === "PreToolUse") return { status: "registered" };
    if (scope.provider === "codex" && ["UserPromptSubmit", "PostToolUseFailure"].includes(event)) {
      throw new MemoryHookFailure("unsupported");
    }
    const delivery = registration ? undefined : projectDelivery(input, event);
    try {
      if (!delivery) return { status: "recovered", recovery: await runtime.recoverMemory(identity) };
      const result = await runtime.ingestMemory(identity, delivery);
      return { status: result.duplicate ? "duplicate" : "applied" };
    } catch (error) { runtimeFailure(error); }
  };
}
