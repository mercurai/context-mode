import { SECRET_KEY_PATTERN } from "../session/secret-key.js";

/** Scan each key once; overlapping greedy secret/key spans make long keys quadratic. */
function redactAssignments(text: string): string {
  // Quoted prefixes start only at the beginning of a backslash run. Bare
  // keys must still be recognized immediately after a literal log escape.
  const keys = /((?<!\\)\\*["']|)(?<![\w.-])([\w.-]+)\1\s*(?:=>|[:=])\s*/g;
  const quoted = /(?:[rubf]{1,2})?(\\*)(["'])/iy;
  const bare = /[^\s,;}]+/y;
  let result = "", copied = 0, key: RegExpExecArray | null;
  while ((key = keys.exec(text))) {
    // Leave non-secret values open to scanning: message="password=...".
    if (!SECRET_KEY_PATTERN.test(key[2])) continue;
    quoted.lastIndex = bare.lastIndex = keys.lastIndex;
    const opening = quoted.exec(text);
    let end: number, quote = "";
    if (opening) {
      quote = opening[1] + opening[2];
      end = text.length; // An unterminated secret consumes the remainder.
      let slashes = 0;
      for (let at = quoted.lastIndex; at < text.length; at++) {
        if (text[at] === "\\") { slashes++; continue; }
        // Match the quoting layer, skipping embedded escaped quotes. This
        // covers plain values and JSON escaped once or multiple times in logs.
        if (text[at] === opening[2] && slashes % (2 * (opening[1].length + 1)) === opening[1].length) {
          end = at + 1;
          break;
        }
        slashes = 0;
      }
    } else {
      if (!bare.exec(text)) continue;
      end = bare.lastIndex;
    }
    result += text.slice(copied, keys.lastIndex) + quote + "[REDACTED]" + quote;
    copied = keys.lastIndex = end;
  }
  return result + text.slice(copied);
}

export function redactText(value: string): string {
  return redactAssignments(value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[REDACTED]")
    .replace(/\b(?:authorization|cookie|set-cookie)\s*[:=][^\r\n]*/gi, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"))
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}

/** Bound and clone JSON before extraction; neither accessors nor raw envelopes are evaluated. */
export function sanitizeMemoryJSON(input: unknown, maxBytes = 64 * 1024, maxNodes = 4096): unknown {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) {
    throw new Error("Invalid memory sanitization budget");
  }
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > 1024 * 1024) {
    throw new Error("Invalid memory sanitization node budget");
  }
  let nodes = 0, bytes = 0;
  function count(value: string): void {
    bytes += Buffer.byteLength(value);
    if (bytes > maxBytes) throw new Error("Shared memory delivery limit exceeded");
  }
  function visit(value: unknown, depth: number): unknown {
    if (++nodes > maxNodes || depth > 16) throw new Error("Shared memory delivery limit exceeded");
    if (typeof value === "string") {
      if (Buffer.byteLength(value) > maxBytes) throw new Error("Shared memory delivery limit exceeded");
      let parsed: unknown;
      try { parsed = JSON.parse(value); } catch { /* Ordinary text. */ }
      // Prompts and tool inputs can carry encoded JSON too. Preserve string
      // types/layers while sharing the same recursion and allocation budgets.
      if (typeof parsed === "string" || (parsed && typeof parsed === "object")) {
        return JSON.stringify(visit(parsed, depth + 1));
      }
      count(value);
      return redactText(value);
    }
    if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
    if (!value || typeof value !== "object") throw new Error("Invalid shared memory delivery");
    if (Array.isArray(value)) return value.map((item) => visit(item, depth + 1));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("Invalid shared memory delivery");
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      count(key);
      const property = Object.getOwnPropertyDescriptor(value, key)!;
      if (!("value" in property) || ["__proto__", "constructor", "prototype"].includes(key)) {
        throw new Error("Invalid shared memory delivery");
      }
      if (depth === 0 && key === "id") {
        if (typeof property.value !== "string") throw new Error("Invalid shared memory delivery");
        count(property.value);
        result[key] = property.value;
      } else {
        const response = depth === 0 && key === "tool_response";
        const sanitized = SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : visit(property.value, depth + 1);
        // Extractors consume response text. Serialize only after recursively
        // sanitizing native objects and decoded JSON-string response keys.
        result[key] = response && typeof sanitized !== "string" ? JSON.stringify(sanitized) : sanitized;
      }
    }
    return result;
  }
  const sanitized = visit(input, 0);
  if (Buffer.byteLength(JSON.stringify(sanitized)) > maxBytes) throw new Error("Shared memory delivery limit exceeded");
  return sanitized;
}
