import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { loadDatabase } from "../../src/db-base.js";
import { SessionDB } from "../../src/session/db.js";
import { ContentStore } from "../../src/store.js";
import { createSharedMemoryIngestor, type SharedMemoryContext,
  type SharedMemoryDelivery } from "../../src/shared/memory-ingestion.js";
import type { ResolvedIdentity } from "../../src/shared/identity.js";

const NOW = Date.UTC(2030, 0, 2, 3, 4, 5);
const hash = (parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

describe("shared local memory ingestion", () => {
  let root: string;
  let db: SessionDB;
  let store: ContentStore;
  let dbPath: string;
  let storePath: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "shared-memory-")));
    dbPath = join(root, "sessions.db"); storePath = join(root, "content.db");
    db = new SessionDB({ dbPath }); store = new ContentStore(storePath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { store.close(); } finally {
      try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); }
    }
  });

  function context(overrides: Partial<ResolvedIdentity> = {}): SharedMemoryContext {
    const identity: ResolvedIdentity = {
      provider: "codex", home: join(root, "provider-home"), workspace: join(root, "worktree"),
      launchId: "launch-a", sessionId: "native-session", threadId: "native-thread", ...overrides,
    };
    mkdirSync(identity.home, { recursive: true }); mkdirSync(identity.workspace, { recursive: true });
    const project = hash([identity.provider, identity.home, identity.workspace]);
    const ownerId = hash([project, identity.sessionId, identity.threadId ?? identity.agentId ?? identity.sessionId]);
    db.ensureSession(ownerId, identity.workspace);
    return { identity, ownerId, store, now: () => NOW,
      attribution: { db, sessionId: ownerId, workspaceDir: identity.workspace } };
  }

  function memory(owner: SharedMemoryContext, maxDeliveries = 100) {
    return createSharedMemoryIngestor(owner, { maxDeliveries });
  }

  function prompt(id: string, marker: string): Extract<SharedMemoryDelivery, { kind: "prompt" }> {
    return { v: 1, id, kind: "prompt", prompt: `Implement ${marker} for the current workspace.` };
  }

  function tool(id: string, command: string, response = "ok", is_error = false): SharedMemoryDelivery {
    return { v: 1, id, kind: "tool", tool_name: "Bash", tool_input: { command },
      tool_response: response, is_error };
  }

  function events(owner: SharedMemoryContext) { return db.getEvents(owner.ownerId, { limit: 1000 }); }
  function reopen() {
    store.close(); db.close();
    db = new SessionDB({ dbPath }); store = new ContentStore(storePath);
  }
  function search(owner: SharedMemoryContext, query: string) {
    return store.searchWithFallback(query, 20, undefined, undefined, "like",
      new Set([owner.ownerId]), { includeUnattributed: false });
  }

  test("persists local prompt events, searchable owner content and a fixed-clock resume", () => {
    const owner = context(), ingest = memory(owner);
    const result = ingest.ingest(prompt("delivery-a", "orchardalpha"));
    expect(result.duplicate).toBe(false);
    expect(result.events).toBeGreaterThan(0);
    expect(events(owner).some((event) => event.data.includes("orchardalpha"))).toBe(true);
    expect(events(owner).every((event) => event.session_id === owner.ownerId &&
      event.project_dir === owner.identity.workspace)).toBe(true);
    expect(search(owner, "orchardalpha").length).toBeGreaterThan(0);
    expect(result.snapshot).toContain(new Date(NOW).toISOString());
    expect(db.getResume(owner.ownerId)?.snapshot).toBe(result.snapshot);
  });

  test("long sessions recover a bounded complete document while omitted details remain searchable", () => {
    const owner = context(), ingest = memory(owner);
    ingest.ingest({ v: 1, id: "recent-file", kind: "tool", tool_name: "Read",
      tool_input: { file_path: "/workspace/orchardalpha.ts" } });
    for (let n = 0; n < 55; n++) {
      ingest.ingest(tool(`error-${n}`, `compile-${n}`, `Error: failure${n} ${"detail ".repeat(50)}`, true));
    }
    const snapshot = ingest.recover();
    expect(snapshot.length).toBeLessThanOrEqual(10_000);
    expect(snapshot).toMatch(/^<session_resume[\s\S]*<\/session_resume>$/);
    expect(snapshot).toContain("orchardalpha.ts");
    expect(snapshot).toContain("section_summary");
    expect(snapshot).toContain('source: "session-events"');
    expect(search(owner, "failure54").length).toBeGreaterThan(0);
    expect(search(owner, "failure0").length).toBeGreaterThan(0);
    expect(db.getResume(owner.ownerId)?.snapshot).toBe(snapshot);
  });

  test.each([
    ["provider", { provider: "claude-code", threadId: undefined }],
    ["home", { home: "other-home" }],
    ["workspace", { workspace: "other-worktree" }],
    ["session", { sessionId: "other-session" }],
    ["child thread", { threadId: "child-thread" }],
  ] as const)("same native delivery ID remains isolated by %s", (_name, values) => {
    const overrides: Partial<ResolvedIdentity> = { ...values };
    if (overrides.home) overrides.home = join(root, overrides.home);
    if (overrides.workspace) overrides.workspace = join(root, overrides.workspace);
    const a = context(), b = context(overrides);
    const first = memory(a), second = memory(b);
    first.ingest(prompt("native-id", "orchardalpha"));
    second.ingest(prompt("native-id", "meadowbeta"));
    expect(a.ownerId).not.toBe(b.ownerId);
    expect(events(a).map((event) => event.data).join(" ")).not.toContain("meadowbeta");
    expect(events(b).map((event) => event.data).join(" ")).not.toContain("orchardalpha");
    expect(search(a, "orchardalpha").length).toBeGreaterThan(0);
    expect(search(a, "meadowbeta")).toEqual([]);
    expect(search(b, "orchardalpha")).toEqual([]);
    expect(search(b, "meadowbeta").length).toBeGreaterThan(0);
    expect(db.getResume(a.ownerId)?.snapshot).not.toContain("meadowbeta");
  });

  test("Claude sibling agents with the same session retain separate memory", () => {
    const a = context({ provider: "claude-code", threadId: undefined, agentId: "agent-a" });
    const b = context({ provider: "claude-code", threadId: undefined, agentId: "agent-b" });
    memory(a).ingest(prompt("same-native-id", "orchardalpha"));
    memory(b).ingest(prompt("same-native-id", "meadowbeta"));
    expect(events(a).map((event) => event.data).join(" ")).not.toContain("meadowbeta");
    expect(search(b, "orchardalpha")).toEqual([]);
  });

  test("retry survives more than five later deliveries, DB reopen and a new launch", () => {
    const owner = context(), ingest = memory(owner), delivery = prompt("first", "orchardalpha");
    ingest.ingest(delivery);
    for (let n = 0; n < 8; n++) ingest.ingest(prompt(`later-${n}`, `intervening${n}`));
    const before = events(owner).map((event) => ({ id: event.id, data: event.data }));
    store.close(); db.close();
    db = new SessionDB({ dbPath }); store = new ContentStore(storePath);
    const resumed = context({ launchId: "replacement-launch" });
    expect(resumed.ownerId).toBe(owner.ownerId);
    expect(memory(resumed).ingest(delivery).duplicate).toBe(true);
    expect(events(resumed).map((event) => ({ id: event.id, data: event.data }))).toEqual(before);
    expect(search(resumed, "orchardalpha").length).toBeGreaterThan(0);
  });

  test("reusing a delivery ID with changed content is refused without replacing prior memory", () => {
    const owner = context(), ingest = memory(owner);
    ingest.ingest(prompt("same", "orchardalpha"));
    expect(() => ingest.ingest(prompt("same", "meadowbeta"))).toThrow(/conflict|reused|delivery/i);
    expect(search(owner, "orchardalpha").length).toBeGreaterThan(0);
    expect(search(owner, "meadowbeta")).toEqual([]);
  });

  test("distinct native deliveries preserve repeated prompt occurrences", () => {
    const owner = context(), ingest = memory(owner);
    const first = prompt("native-occurrence-1", "orchardalpha");
    const second = { ...first, id: "native-occurrence-2" };
    ingest.ingest(first); ingest.ingest(second);
    const prompts = events(owner).filter((event) => event.type === "user_prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts.map((event) => event.data)).toEqual([first.prompt, first.prompt]);
    expect(ingest.ingest(second).duplicate).toBe(true);
    expect(events(owner).filter((event) => event.type === "user_prompt")).toHaveLength(2);
  });

  test("delivery count reports events actually persisted and remains accurate on retry", () => {
    const owner = context(), ingest = memory(owner);
    const first = prompt("first-count", "orchardalpha"), second = { ...first, id: "second-count" };
    ingest.ingest(first);
    const before = new Set(events(owner).map((event) => event.id));
    const result = ingest.ingest(second);
    const inserted = events(owner).filter((event) => !before.has(event.id));
    expect(result.events).toBe(inserted.length);
    expect(result.events).toBeGreaterThan(0);
    expect(ingest.ingest(second).events).toBe(inserted.length);
  });

  test("bounded receipt capacity rejects new IDs while preserving old retry tombstones", () => {
    const owner = context(), ingest = memory(owner, 2), first = prompt("first", "orchardalpha");
    ingest.ingest(first); ingest.ingest(prompt("second", "meadowbeta"));
    expect(() => ingest.ingest(prompt("third", "rivergamma"))).toThrow(/capacity|limit/i);
    expect(ingest.ingest(first).duplicate).toBe(true);
    expect(search(owner, "rivergamma")).toEqual([]);
    expect(memory(context({ sessionId: "another-owner" }), 2)
      .ingest(prompt("third", "rivergamma")).duplicate).toBe(false);
  });

  test("failed event insert rolls back its delivery receipt and allows a corrected retry", () => {
    const owner = context(), ingest = memory(owner), delivery = prompt("atomic", "orchardalpha");
    const Database = loadDatabase(), raw = new Database(dbPath);
    try {
      raw.exec("CREATE TRIGGER reject_memory_event BEFORE INSERT ON session_events BEGIN SELECT RAISE(ABORT, 'synthetic insert refusal'); END");
      expect(() => ingest.ingest(delivery)).toThrow();
      expect(events(owner)).toEqual([]);
      raw.exec("DROP TRIGGER reject_memory_event");
      expect(ingest.ingest(delivery).duplicate).toBe(false);
      expect(events(owner).some((event) => event.data.includes("orchardalpha"))).toBe(true);
    } finally { raw.close(); }
  });

  test("same-ID retry repairs a failed index projection without duplicating committed events", () => {
    const owner = context(), ingest = memory(owner), delivery = prompt("repair", "orchardalpha");
    const fail = vi.spyOn(store, "index").mockImplementationOnce(() => { throw new Error("synthetic index refusal"); });
    expect(() => ingest.ingest(delivery)).toThrow();
    const before = events(owner).map((event) => event.id);
    expect(before.length).toBeGreaterThan(0);
    fail.mockRestore();
    expect(ingest.ingest(delivery).duplicate).toBe(true);
    expect(events(owner).map((event) => event.id)).toEqual(before);
    expect(search(owner, "orchardalpha").length).toBeGreaterThan(0);
  });

  test("error-resolution history belongs to its owner, including interleaved calls", () => {
    const a = context(), b = context({ sessionId: "other-session" });
    const first = memory(a), second = memory(b);
    first.ingest(tool("a-error", "inspect orchardalpha", "Error: orchardalpha failed", true));
    second.ingest(tool("b-success", "inspect meadowbeta"));
    expect(events(b).filter((event) => event.category === "error-resolution")).toEqual([]);
    first.ingest(tool("a-fixed", "inspect orchardalpha"));
    expect(events(a).filter((event) => event.category === "error-resolution")).toHaveLength(1);
  });

  test("iteration history counts distinct deliveries per owner and does not count retries", () => {
    const a = context(), b = context({ sessionId: "other-session" });
    const first = memory(a), second = memory(b), call = tool("a-1", "inspect repeatedinput");
    first.ingest(call); first.ingest(call);
    second.ingest(tool("b-1", "inspect repeatedinput"));
    first.ingest(tool("a-2", "inspect repeatedinput"));
    expect(events(a).filter((event) => event.category === "iteration-loop")).toEqual([]);
    expect(events(b).filter((event) => event.category === "iteration-loop")).toEqual([]);
    first.ingest(tool("a-3", "inspect repeatedinput"));
    expect(events(a).filter((event) => event.category === "iteration-loop")).toHaveLength(1);
  });

  test("restart restores each owner's pending error independently of interleaved successes", () => {
    const a = context(), b = context({ sessionId: "other-session" });
    memory(a).ingest(tool("a-error", "inspect orchardalpha", "Error: orchardalpha failed", true));
    memory(b).ingest(tool("b-error", "inspect meadowbeta", "Error: meadowbeta failed", true));
    reopen();
    const resumedA = context({ launchId: "replacement-a" });
    const resumedB = context({ sessionId: "other-session", launchId: "replacement-b" });
    memory(resumedB).ingest(tool("b-fixed", "inspect meadowbeta"));
    expect(events(resumedA).filter((event) => event.category === "error-resolution")).toEqual([]);
    memory(resumedA).ingest(tool("a-fixed", "inspect orchardalpha"));
    expect(events(resumedA).filter((event) => event.category === "error-resolution"))
      .toMatchObject([{ data: expect.stringContaining("orchardalpha") }]);
    expect(events(resumedB).filter((event) => event.category === "error-resolution"))
      .toMatchObject([{ data: expect.stringContaining("meadowbeta") }]);
    expect(events(resumedA).map((event) => event.data).join(" ")).not.toContain("meadowbeta");
  });

  test("restart restores iteration history while duplicate delivery and sibling work do not advance it", () => {
    const a = context(), b = context({ sessionId: "other-session" });
    const first = memory(a), second = memory(b), repeated = tool("a-2", "inspect repeatedinput");
    first.ingest(tool("a-1", "inspect repeatedinput")); first.ingest(repeated);
    second.ingest(tool("b-1", "inspect repeatedinput"));
    reopen();
    const resumedA = context(), resumedB = context({ sessionId: "other-session" });
    const freshA = memory(resumedA), freshB = memory(resumedB);
    expect(freshA.ingest(repeated).duplicate).toBe(true);
    freshB.ingest(tool("b-2", "inspect repeatedinput"));
    expect(events(resumedB).filter((event) => event.category === "iteration-loop")).toEqual([]);
    freshA.ingest(tool("a-3", "inspect repeatedinput"));
    expect(events(resumedA).filter((event) => event.category === "iteration-loop")).toHaveLength(1);
    freshB.ingest(tool("b-3", "inspect repeatedinput"));
    expect(events(resumedB).filter((event) => event.category === "iteration-loop")).toHaveLength(1);
  });

  test("receipt insertion failure rolls back extractor state before restart and retry", () => {
    const owner = context(), ingest = memory(owner), fixed = tool("fixed", "inspect orchardalpha");
    ingest.ingest(tool("error", "inspect orchardalpha", "Error: orchardalpha failed", true));
    const before = events(owner).map((event) => event.id);
    const Database = loadDatabase(), raw = new Database(dbPath);
    try {
      raw.exec("CREATE TRIGGER reject_memory_receipt BEFORE INSERT ON shared_memory_deliveries BEGIN SELECT RAISE(ABORT, 'synthetic receipt refusal'); END");
      expect(() => ingest.ingest(fixed)).toThrow();
      expect(events(owner).map((event) => event.id)).toEqual(before);
      raw.exec("DROP TRIGGER reject_memory_receipt");
    } finally { raw.close(); }
    reopen();
    const resumed = context(), fresh = memory(resumed);
    expect(fresh.ingest(fixed).duplicate).toBe(false);
    expect(events(resumed).filter((event) => event.category === "error-resolution")).toHaveLength(1);
    expect(fresh.ingest(fixed).duplicate).toBe(true);
    expect(events(resumed).filter((event) => event.category === "error-resolution")).toHaveLength(1);
  });

  test("index projection failure retains committed extractor state across restart and retry", () => {
    const owner = context(), ingest = memory(owner), second = tool("second", "inspect repeatedinput");
    // Seed visible memory so every projection indexes even when this tool call
    // emits no derived events until the third repeated occurrence.
    ingest.ingest(prompt("seed", "orchardalpha"));
    ingest.ingest(tool("first", "inspect repeatedinput"));
    const fail = vi.spyOn(store, "index").mockImplementationOnce(() => { throw new Error("synthetic index refusal"); });
    expect(() => ingest.ingest(second)).toThrow();
    fail.mockRestore();
    reopen();
    const resumed = context(), fresh = memory(resumed);
    expect(fresh.ingest(second).duplicate).toBe(true);
    fresh.ingest(tool("third", "inspect repeatedinput"));
    expect(events(resumed).filter((event) => event.category === "iteration-loop")).toHaveLength(1);
  });

  test.each([
    "not-json",
    JSON.stringify({ lastError: null, callHistory: [], unexpected: true }),
    JSON.stringify({ lastError: null, callHistory: Array.from({ length: 51 }, () => ({ tool: "Bash", inputHash: "2:{}" })) }),
  ])("malformed persisted extractor state is refused before new events or receipts", (state) => {
    const owner = context();
    memory(owner).ingest(prompt("seed", "orchardalpha"));
    const before = events(owner).map((event) => event.id);
    const Database = loadDatabase(), raw = new Database(dbPath);
    let receipts: number;
    try {
      raw.prepare("UPDATE shared_memory_extraction SET state_json = ? WHERE session_id = ?").run(state, owner.ownerId);
      receipts = (raw.prepare("SELECT COUNT(*) AS n FROM shared_memory_deliveries WHERE session_id = ?")
        .get(owner.ownerId) as { n: number }).n;
    } finally { raw.close(); }
    reopen();
    const resumed = context();
    expect(() => memory(resumed).ingest(prompt("new", "meadowbeta"))).toThrow(/persisted.*state/i);
    expect(events(resumed).map((event) => event.id)).toEqual(before);
    const check = new Database(dbPath);
    try {
      expect((check.prepare("SELECT COUNT(*) AS n FROM shared_memory_deliveries WHERE session_id = ?")
        .get(owner.ownerId) as { n: number }).n).toBe(receipts);
    } finally { check.close(); }
  });

  test("extractor state stays bounded in one row per owner as deliveries accumulate", () => {
    const owner = context(), ingest = memory(owner);
    for (let n = 0; n < 60; n++) ingest.ingest(tool(`call-${n}`, `${n}:command`));
    const Database = loadDatabase(), raw = new Database(dbPath);
    try {
      const rows = raw.prepare("SELECT state_json FROM shared_memory_extraction WHERE session_id = ?")
        .all(owner.ownerId) as Array<{ state_json: string }>;
      expect(rows).toHaveLength(1);
      expect(Buffer.byteLength(rows[0].state_json)).toBeLessThanOrEqual(32 * 1024);
      expect(JSON.parse(rows[0].state_json).callHistory).toHaveLength(50);
      expect((raw.prepare("SELECT COUNT(*) AS n FROM shared_memory_deliveries WHERE session_id = ?")
        .get(owner.ownerId) as { n: number }).n).toBe(60);
    } finally { raw.close(); }
  });

  test("credential-shaped fields and inline values never reach events, search or resume", () => {
    const owner = context(), ingest = memory(owner);
    const markers = ["syntheticpasswordalpha", "syntheticbearerbeta", "syntheticcookiegamma"];
    ingest.ingest({ v: 1, id: "secret-tool", kind: "tool", tool_name: "mcp__example__inspect",
      tool_input: { query: "orchardalpha", nested: { password: markers[0] } },
      tool_response: `Authorization: Bearer ${markers[1]}\nCookie: session=${markers[2]}` });
    ingest.ingest({ v: 1, id: "secret-prompt", kind: "prompt",
      prompt: `Implement orchardalpha. Authorization: Bearer ${markers[1]}` });
    const stored = JSON.stringify(events(owner)) + db.getResume(owner.ownerId)?.snapshot;
    for (const marker of markers) {
      expect(stored).not.toContain(marker);
      expect(search(owner, marker)).toEqual([]);
    }
    expect(search(owner, "orchardalpha").length).toBeGreaterThan(0);
  });

  test.each(["pwd", "private_key", "cookie", "signature", "authorization", "set-cookie", "x-api-key"])(
    "redacts inline %s assignments consistently with structural credential fields", (key) => {
      const owner = context(), ingest = memory(owner), marker = "syntheticassignmentsecret";
      ingest.ingest({ v: 1, id: "assignment-prompt", kind: "prompt",
        prompt: `Remember orchardalpha ${key}=${marker}` });
      ingest.ingest(tool("assignment-error", "inspect orchardalpha", `Error: ${key}=${marker}`, true));
      const text = JSON.stringify(events(owner));
      expect(text).not.toContain(marker);
      expect(db.getResume(owner.ownerId)?.snapshot).not.toContain(marker);
      expect(search(owner, marker)).toEqual([]);
      expect(search(owner, "orchardalpha").length).toBeGreaterThan(0);
      // Covers any persisted extractor state, not only the visible event rows.
      for (const path of [dbPath, `${dbPath}-wal`]) {
        if (existsSync(path)) expect(readFileSync(path).includes(Buffer.from(marker))).toBe(false);
      }
    },
  );

  test.each([
    { v: 1, kind: "prompt", prompt: "Implement orchardalpha." },
    { v: 1, id: "", kind: "prompt", prompt: "Implement orchardalpha." },
    { v: 1, id: "x", kind: "prompt", prompt: "Implement orchardalpha.", session_id: "victim" },
    { v: 1, id: "x", kind: "prompt", prompt: "Implement orchardalpha.", transcript_path: "/do/not/read" },
    { v: 1, id: "x", kind: "settings", mcp_servers: { endpoint: { token: "syntheticvalue" } } },
  ])("rejects missing identity or raw envelope fields without storing anything: %j", (delivery) => {
    const owner = context(), ingest = memory(owner);
    expect(() => ingest.ingest(delivery)).toThrow();
    expect(events(owner)).toEqual([]);
    expect(search(owner, "orchardalpha")).toEqual([]);
  });

  test("invalid explicit owner never falls back to the newest session", () => {
    const a = context(), b = context({ sessionId: "newest-session" });
    const invalid = { ...a, attribution: { ...a.attribution, sessionId: "missing-owner" } };
    expect(() => memory(invalid).ingest(prompt("delivery", "orchardalpha"))).toThrow();
    expect(events(a)).toEqual([]); expect(events(b)).toEqual([]);
  });

  test("recovery rebuilds only the caller's local memory and borrows open storage", () => {
    const a = context(), b = context({ sessionId: "other-session" });
    memory(a).ingest(prompt("a", "orchardalpha"));
    memory(b).ingest(prompt("b", "meadowbeta"));
    const snapshot = memory(a).recover();
    expect(snapshot).toContain("orchardalpha"); expect(snapshot).not.toContain("meadowbeta");
    expect(snapshot).toContain(new Date(NOW).toISOString());
    expect(db.getResume(a.ownerId)?.snapshot).toBe(snapshot);
    // The helper does not close shared resources after ingest/recover.
    expect(memory(b).ingest(prompt("b-next", "rivergamma")).events).toBeGreaterThan(0);
  });

  test("normalized settings preserve names without requiring endpoint configuration", () => {
    const owner = context(), ingest = memory(owner);
    ingest.ingest({ v: 1, id: "settings", kind: "settings", model: "synthetic-model",
      permission_mode: "default", mcp_servers: ["context-mode", "codegraph"] });
    expect(events(owner).filter((event) => event.type === "session_settings_snapshot"))
      .toMatchObject([{ data: expect.stringContaining("mcp_count:2") }]);
    expect(events(owner).map((event) => event.data).join(" ")).toContain("synthetic-model");
  });

  test.each(["compact", "session-start", "session-end"] as const)(
    "%s returns only the caller's recovery snapshot and tolerates native retry", (kind) => {
      const owner = context(), ingest = memory(owner);
      ingest.ingest(prompt("prompt", "orchardalpha"));
      const before = events(owner).map((event) => event.id);
      const delivery = { v: 1, id: `native-${kind}`, kind } as const;
      const first = ingest.ingest(delivery), retry = ingest.ingest(delivery);
      expect(first.snapshot).toContain("orchardalpha");
      expect(first.snapshot).toContain(new Date(NOW).toISOString());
      expect(retry.duplicate).toBe(true);
      expect(retry.snapshot).toBe(first.snapshot);
      expect(events(owner).map((event) => event.id)).toEqual(before);
    },
  );
});
