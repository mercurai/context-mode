import { createHash } from "node:crypto";
import { sanitizeMemoryJSON } from "./memory-sanitization.js";

const MAX_NATIVE_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_BYTES = 8 * 1024;
const TOTAL_CONTENT_BYTES = 32 * 1024;
const EXCERPT = "\n[context-mode: excerpt; content shortened]";
const OMIT = Symbol("omitted");
const encodedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** Bound encoded bytes, preserving whole Unicode characters and an explicit marker. */
function excerpt(text: string, limit: number, force = false): string {
  if (!force && Buffer.byteLength(JSON.stringify(text)) <= limit) return text;
  if (limit < Buffer.byteLength(JSON.stringify(EXCERPT))) return "";
  let low = 0, high = force ? Math.max(0, text.length - 1) : text.length;
  while (low < high) {
    const end = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(text.slice(0, end) + EXCERPT)) <= limit) low = end;
    else high = end - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(text[low - 1])) low--;
  return text.slice(0, low) + EXCERPT;
}

/** Pure content projection; no database, filesystem, identity lookup or fallback. */
export function projectLargeToolContent(input: Record<string, unknown>, scale = 1) {
  const content = Object.fromEntries(["tool_input", "tool_response", "error"]
    .filter((key) => Object.hasOwn(input, key)).map((key) => [key, input[key]]));
  // Redact the complete value, including encoded JSON, before any shortening.
  // The full sanitized digest distinguishes retries that differ outside excerpts.
  const sanitized = sanitizeMemoryJSON(content, MAX_NATIVE_BYTES, 1024 * 1024);
  const full = JSON.stringify(sanitized);
  const projected = projectContent(sanitized as Record<string, unknown>, scale);
  return { ...projected, capture: { sha256: createHash("sha256").update(full).digest("hex"),
    originalBytes: Buffer.byteLength(full) } };
}

/** Charge keys, scalars, containers and markers, not only string values. */
function projectContent(input: Record<string, unknown>, scale: number): Record<string, unknown> {
  // Every root content field survives, even when a previous field exhausted nodes.
  let remaining = TOTAL_CONTENT_BYTES - 512, nodes = 0;
  function charge(bytes: number): boolean {
    if (bytes > remaining) return false;
    remaining -= bytes;
    return true;
  }
  function project(value: unknown, key?: string): unknown | typeof OMIT {
    if (++nodes > 1024 / scale) return OMIT;
    if (typeof value === "string") {
      if (key === "file_path" || key === "path") {
        if (!charge(encodedBytes(value))) throw new Error("Shared memory path budget exceeded");
        return value;
      }
      if (remaining < encodedBytes(EXCERPT)) return OMIT;
      // On the final pass, mark even small encoded JSON as an excerpt. The
      // service then consumes text instead of expanding thousands of hidden
      // nodes. Full sanitized content still contributes to the capture digest.
      let encodedJSON = false;
      if (scale >= 8) {
        try {
          const parsed: unknown = JSON.parse(value);
          encodedJSON = typeof parsed === "string" || (parsed !== null && typeof parsed === "object");
        } catch { /* Ordinary text. */ }
      }
      const result = excerpt(value, Math.min(MAX_TEXT_BYTES / scale, remaining), encodedJSON);
      charge(encodedBytes(result));
      return result;
    }
    if (value && typeof value === "object") {
      const array = Array.isArray(value);
      // Reserve a complete marker even if the next child consumes the budget.
      const marker = array ? EXCERPT : { __context_mode_excerpt: EXCERPT };
      if (!charge(2 + encodedBytes(marker) + 1)) return OMIT;
      const result: Record<string, unknown> = Object.create(null), items: unknown[] = [];
      // Preserve routing-relevant file observations before bulk content fields.
      const entries = Object.entries(value);
      if (!array) entries.sort(([a], [b]) => Number(!["file_path", "path", "command"].includes(a)) -
        Number(!["file_path", "path", "command"].includes(b)));
      for (const [childKey, item] of entries) {
        const child = charge(array ? 1 : encodedBytes(childKey) + 2) ? project(item, childKey) : OMIT;
        if (child === OMIT) {
          if (array) items.push(EXCERPT);
          else result.__context_mode_excerpt = EXCERPT;
          break;
        }
        if (array) items.push(child);
        else result[childKey] = child;
      }
      return array ? items : result;
    }
    return charge(encodedBytes(value)) ? value : OMIT;
  }
  return Object.fromEntries(Object.entries(input).map(([key, value]) => {
    const result = project(value, key);
    return [key, result === OMIT ? key === "tool_input" ? { __context_mode_excerpt: EXCERPT } : EXCERPT : result];
  }));
}

/** Assess the same delivery shape/budgets as the service, including response encoding. */
function fitsService(input: Record<string, unknown>): boolean {
  try {
    sanitizeMemoryJSON({ v: 1, kind: "tool", id: "0".repeat(64), tool_name: input.tool_name,
      tool_input: input.tool_input, is_error: input.hook_event_name === "PostToolUseFailure",
      ...(input.capture === undefined ? {} : { capture: input.capture }),
      ...(input.tool_response !== undefined ? { tool_response: input.tool_response } :
        input.hook_event_name === "PostToolUseFailure" && input.error !== undefined ? { tool_response: input.error } : {}) });
    return encodedBytes({ memory: input }) <= 64 * 1024;
  } catch { return false; }
}

export function prepareToolMemory(input: Record<string, unknown>): Record<string, unknown> {
  if (fitsService(input)) return input;
  // Retained JSON strings can decode to more nodes at service admission. Reduce
  // excerpts deterministically while retaining the digest of the full content.
  for (const scale of [1, 2, 4, 8]) {
    const result = { ...input, ...projectLargeToolContent(input, scale) };
    if (fitsService(result)) return result;
  }
  throw new Error("Shared memory delivery limit exceeded");
}
