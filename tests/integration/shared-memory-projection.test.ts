import { describe, expect, test } from "vitest";
import { prepareToolMemory, projectLargeToolContent } from "../../src/shared/memory-projection.js";
import { sanitizedDelivery } from "../../src/shared/memory-ingestion.js";
import { redactText } from "../../src/shared/memory-sanitization.js";

describe("large native completion projection", () => {
  test.each([
    String.raw`level=info body={\"password\":\"orchard secret, meadow tail\"} status=ok`,
    String.raw`level=info body={\\\"password\\\":\\\"orchard secret, meadow tail\\\"} status=ok`,
    String.raw`level=info body={\"password\":\"orchard \\\"quoted\\\" secret, meadow tail\"} status=ok`,
    "body={'password' => 'orchard secret, meadow tail'} status=ok",
    String.raw`level=info message=public\npassword="orchard secret, meadow tail" status=ok`,
    String.raw`level=info \password="orchard secret, meadow tail" status=ok`,
  ])("redacts complete escaped and arrow assignment values: %s", (input) => {
    const output = redactText(input);
    for (const fragment of ["orchard", "secret", "meadow", "tail"]) expect(output).not.toContain(fragment);
    expect(output).toContain("[REDACTED]");
    expect(output).toContain("status=ok");
  });

  test("unterminated private key blocks redact through EOF, including repeated headers", () => {
    const input = "public prefix\n" + "-----BEGIN RSA PRIVATE KEY-----\nsynthetic-private-body\n".repeat(128);
    expect(redactText(input)).toBe("public prefix\n[REDACTED]");
    expect(redactText("before -----BEGIN PRIVATE KEY-----secret-----END PRIVATE KEY----- after"))
      .toBe("before [REDACTED] after");
  });

  test("a long backslash run preserves ordinary text and still redacts the next assignment", () => {
    const prefix = "\\".repeat(64 * 1024) + " public ";
    expect(redactText(prefix + 'password="synthetic-private-value" status=ok'))
      .toBe(prefix + 'password="[REDACTED]" status=ok');
  });

  test("an unterminated quoted secret redacts through EOF and stays redacted on retry", () => {
    const output = redactText('public password="synthetic-private-value status=ok');
    expect(output).toBe('public password="[REDACTED]"');
    expect(redactText(output)).toBe(output);
  });

  test("dense JSON strings below the smallest excerpt cap retain delivery and full digest", () => {
    const make = (last: number) => ({ hook_event_name: "PostToolUse", tool_name: "Bash",
      tool_input: Object.fromEntries(Array.from({ length: 12 }, (_, n) =>
        [`list${n}`, JSON.stringify([...Array.from({ length: 480 }, () => 0), n === 11 ? last : 0])])),
      tool_response: "ok" });
    const output = prepareToolMemory(make(1)), retry = prepareToolMemory(make(1)), changed = prepareToolMemory(make(2));
    expect(output).toEqual(retry);
    expect(output.capture).not.toEqual(changed.capture);
    const { tool_input, tool_response, capture } = output;
    expect(sanitizedDelivery({ v: 1, id: "dense", kind: "tool", tool_name: "Bash", tool_input,
      tool_response, capture }).kind).toBe("tool");
    expect(JSON.stringify(tool_input)).toContain("shortened");
  });

  test.each(["{u'password': u'hunter2'}", "{b'access_token': b'hunter2'}", 'x"token": "hunter2"',
    'message="password=hunter2"', `${"long".repeat(100)}api_key=hunter2`])("redacts quoted and nested assignments: %s", (input) => {
    expect(redactText(input)).not.toContain("hunter2");
    expect(redactText(input)).toContain("[REDACTED]");
  });

  test("long identifiers with repeated sensitive words retain their non-secret content", () => {
    const text = "token".repeat(40_000) + " end";
    expect(redactText(text)).toBe(text);
  });

  test("numeric containers are bounded while the complete sanitized digest detects omitted changes", () => {
    const vector = Array.from({ length: 3072 }, (_, n) => 1.2345678901234567 + n / 7);
    const a = projectLargeToolContent({ tool_input: { vector }, tool_response: "ok" });
    const b = projectLargeToolContent({ tool_input: { vector: [...vector.slice(0, -1), 999] }, tool_response: "ok" });
    expect(Buffer.byteLength(JSON.stringify(a))).toBeLessThan(48 * 1024);
    expect(JSON.stringify(a)).toContain("shortened");
    expect(a.capture.sha256).not.toBe(b.capture.sha256);
    expect(sanitizedDelivery({ v: 1, id: "numeric", kind: "tool", tool_name: "Bash", ...a }).kind).toBe("tool");
  });

  test("encoded JSON counts decoded content once within native admission", () => {
    const tool_response = JSON.stringify({ content: "x".repeat(9 * 1024 * 1024), password: "synthetic-secret" });
    const output = projectLargeToolContent({ tool_input: {}, tool_response });
    expect(output.capture.originalBytes).toBeGreaterThan(9 * 1024 * 1024);
    expect(JSON.stringify(output)).not.toContain("synthetic-secret");
    expect(output.tool_response).toContain("content shortened");
  });

  test("many individually small JSON strings still fit the service decoded-node limit", () => {
    const tool_input = Object.fromEntries(Array.from({ length: 12 }, (_, n) =>
      [`list${n}`, JSON.stringify(Array.from({ length: 1000 }, () => 0))]));
    const output = prepareToolMemory({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input,
      tool_response: "ok" });
    const { tool_input: projected, tool_response, capture } = output;
    expect(sanitizedDelivery({ v: 1, id: "decoded", kind: "tool", tool_name: "Bash",
      tool_input: projected, tool_response, capture }).kind).toBe("tool");
    expect(JSON.stringify(projected)).toContain("shortened");
  });

  test("key-heavy objects retain a marker and a complete sanitized digest", () => {
    const make = (last: number) => ({ tool_input: Object.fromEntries(Array.from({ length: 5500 }, (_, n) =>
      [`property_${n}`, n === 5499 ? last : n])), tool_response: "ok" });
    const a = projectLargeToolContent(make(1)), b = projectLargeToolContent(make(2));
    expect(Buffer.byteLength(JSON.stringify(a))).toBeLessThan(48 * 1024);
    expect(JSON.stringify(a.tool_input)).toContain("shortened");
    expect(a.capture.sha256).not.toBe(b.capture.sha256);
    expect(sanitizedDelivery({ v: 1, id: "keys", kind: "tool", tool_name: "Bash", ...a }).kind).toBe("tool");
  });

  test("redacts encoded JSON and long private values before retaining excerpts", () => {
    const input = { tool_input: { file_path: "/workspace/orchard.ts", content: "prefix ".repeat(20_000) },
      tool_response: JSON.stringify({ token: "synthetic-private-value", content: "orchard response ".repeat(20_000) }) };
    const output = projectLargeToolContent(input);
    const delivery = sanitizedDelivery({ v: 1, id: "native-id", kind: "tool", tool_name: "Write", ...output });
    expect(delivery.kind).toBe("tool");
    expect(JSON.stringify(output)).not.toContain("synthetic-private-value");
    expect(JSON.stringify(output)).toContain("content shortened");
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThan(64 * 1024);
    expect((output.tool_input as Record<string, unknown>).file_path).toBe(input.tool_input.file_path);
  });

  test("identical retries have stable digests and changed omitted tails differ", () => {
    const content = "same visible prefix ".repeat(10_000);
    const a = projectLargeToolContent({ tool_input: {}, tool_response: content + "original tail" });
    const retry = projectLargeToolContent({ tool_response: content + "original tail", tool_input: {} });
    const b = projectLargeToolContent({ tool_input: {}, tool_response: content + "changed tail" });
    expect(retry).toEqual(a);
    expect(a.tool_response).toBe(b.tool_response);
    expect(a.capture.sha256).not.toBe(b.capture.sha256);
  });

  test("JSON escaping and astral characters stay bounded without splitting a character", () => {
    const output = projectLargeToolContent({ tool_input: {}, tool_response: '\u0001😀'.repeat(100_000) });
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThan(64 * 1024);
    const text = output.tool_response as string;
    expect(text).toContain("content shortened");
    expect(text.isWellFormed()).toBe(true);
  });

  test("file observations retain long paths verbatim rather than inventing clipped paths", () => {
    const file_path = "/workspace/" + "a".repeat(10_000);
    const output = projectLargeToolContent({ tool_input: { content: "x".repeat(100_000), file_path }, tool_response: "ok" });
    expect((output.tool_input as Record<string, unknown>).file_path).toBe(file_path);
    expect(() => projectLargeToolContent({ tool_input: { file_path: "x".repeat(40_000) } })).toThrow(/path budget/);
  });

  test("native admission refuses excessive depth and bytes before projection", () => {
    let nested: unknown = "value";
    for (let n = 0; n < 20; n++) nested = { nested };
    expect(() => projectLargeToolContent({ tool_input: { nested } })).toThrow(/limit/);
    expect(() => projectLargeToolContent({ tool_input: {}, tool_response: "x".repeat(16 * 1024 * 1024) })).toThrow(/limit/);
  });
});
