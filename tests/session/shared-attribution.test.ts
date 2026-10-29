import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDatabase } from "../../src/db-base.js";
import { SessionDB } from "../../src/session/db.js";
import { persistToolCallCounter, restoreSessionStats } from "../../src/session/persist-tool-calls.js";
import { emitCacheHitEvent, emitIndexWriteEvent, emitSandboxExecuteEvent } from "../../src/session/event-emit.js";
import { appendRetrievalBytes, consumeRetrievalBytes, retrievalMarkerPath } from "../../src/session/retrieval-marker.js";

// Proposed additive context. The service supplies this after identity resolution;
// callers own the borrowed DB. No helper may infer a shared request's session.
type ExplicitContext = { sessionId: string; db: SessionDB; workspaceDir: string };

let root: string;
let databases: SessionDB[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "shared-attribution-"));
  databases = [];
});

afterEach(() => {
  try {
    for (const db of databases) db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(scope = "home-a/worktree-a") {
  // Equal basenames intentionally reproduce the legacy marker collision.
  const path = join(root, scope, "session.db");
  const workspaceDir = join(root, "workspaces", scope);
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  const db = new SessionDB({ dbPath: path });
  databases.push(db);
  db.ensureSession("session-a", workspaceDir);
  db.ensureSession("session-b", workspaceDir);
  const Database = loadDatabase();
  const raw = new Database(path);
  try {
    // Deterministic ordering, with no sleeps or wall-clock-dependent assertions.
    const setStart = raw.prepare("UPDATE session_meta SET started_at = ? WHERE session_id = ?");
    setStart.run("2000-01-01 00:00:00", "session-a");
    setStart.run("2000-01-02 00:00:00", "session-b");
  } finally {
    raw.close();
  }
  expect(db.getLatestSessionId()).toBe("session-b");
  const context: ExplicitContext = { sessionId: "session-a", db, workspaceDir };
  return { path, db, context };
}

const eventCases = [
  {
    type: "sandbox-execute", data: "ctx_execute", bytesReturned: 31, bytesAvoided: 0,
    emit: (sessionDbPath: string, context: ExplicitContext) =>
      emitSandboxExecuteEvent({ sessionDbPath, toolName: "ctx_execute", bytesReturned: 31, context }),
  },
  {
    type: "index-write", data: "indexed-source", bytesReturned: 0, bytesAvoided: 41,
    emit: (sessionDbPath: string, context: ExplicitContext) =>
      emitIndexWriteEvent({ sessionDbPath, source: "indexed-source", bytesAvoided: 41, context }),
  },
  {
    type: "cache-hit", data: "cached-source", bytesReturned: 0, bytesAvoided: 51,
    emit: (sessionDbPath: string, context: ExplicitContext) =>
      emitCacheHitEvent({ sessionDbPath, source: "cached-source", bytesAvoided: 51, context }),
  },
];

describe("explicit shared session attribution", () => {
  it("persists and restores A's counters while B is the latest session", () => {
    const { path, db, context } = fixture();
    db.incrementToolCall("session-b", "ctx_search", 900);
    persistToolCallCounter(path, "ctx_search", 100, context);
    persistToolCallCounter(path, "ctx_search", 200, context);
    expect(db.getToolCallStats("session-a")).toMatchObject({ totalCalls: 2, totalBytesReturned: 300 });
    expect(db.getToolCallStats("session-b")).toMatchObject({ totalCalls: 1, totalBytesReturned: 900 });
    expect(restoreSessionStats(path, context)).toEqual({
      calls: { ctx_search: 2 }, bytesReturned: { ctx_search: 300 },
      sessionStart: Date.UTC(2000, 0, 1),
    });
  });

  it("restores an explicitly empty session without borrowing the latest session's totals", () => {
    const { path, db, context } = fixture();
    db.incrementToolCall("session-b", "ctx_search", 900);
    expect(restoreSessionStats(path, context)).toEqual({
      calls: {}, bytesReturned: {}, sessionStart: Date.UTC(2000, 0, 1),
    });
  });

  it.each(eventCases)("attributes $type bytes and the exact workspace to A", (event) => {
    const { path, db, context } = fixture();
    event.emit(path, context);
    expect(db.getEvents("session-a", { type: event.type })).toMatchObject([{
      session_id: "session-a", project_dir: context.workspaceDir,
      type: event.type, data: event.data,
      bytes_returned: event.bytesReturned, bytes_avoided: event.bytesAvoided,
    }]);
    expect(db.getEvents("session-b")).toEqual([]);
  });

  it("lets only A consume A's retrieval marker when B shares the same session DB", () => {
    const { path, context } = fixture();
    const contextB = { ...context, sessionId: "session-b" };
    appendRetrievalBytes(path, 123, root, context);
    expect(consumeRetrievalBytes(path, root, contextB)).toBe(0);
    expect(consumeRetrievalBytes(path, root, context)).toBe(123);
    expect(consumeRetrievalBytes(path, root, context)).toBe(0);
  });

  it.each(["home-b/worktree-a", "home-a/worktree-b"])(
    "isolates identical session IDs and DB basenames in %s", (otherScope) => {
      const first = fixture();
      const second = fixture(otherScope);
      persistToolCallCounter(first.path, "ctx_search", 111, first.context);
      persistToolCallCounter(second.path, "ctx_search", 222, second.context);
      emitIndexWriteEvent({ sessionDbPath: first.path, source: "source", bytesAvoided: 333, context: first.context });
      emitIndexWriteEvent({ sessionDbPath: second.path, source: "source", bytesAvoided: 444, context: second.context });
      appendRetrievalBytes(first.path, 555, root, first.context);
      appendRetrievalBytes(second.path, 666, root, second.context);
      expect(first.db.getToolCallStats("session-a").totalBytesReturned).toBe(111);
      expect(second.db.getToolCallStats("session-a").totalBytesReturned).toBe(222);
      expect(first.db.getEvents("session-a")).toMatchObject([{ bytes_avoided: 333, project_dir: first.context.workspaceDir }]);
      expect(second.db.getEvents("session-a")).toMatchObject([{ bytes_avoided: 444, project_dir: second.context.workspaceDir }]);
      expect(consumeRetrievalBytes(first.path, root, first.context)).toBe(555);
      expect(consumeRetrievalBytes(second.path, root, second.context)).toBe(666);
    },
  );

  it("keeps a legacy marker separate from an explicit shared marker", () => {
    const { path, context } = fixture();
    appendRetrievalBytes(path, 700, root);
    appendRetrievalBytes(path, 123, root, context);
    expect(consumeRetrievalBytes(path, root, context)).toBe(123);
    expect(consumeRetrievalBytes(path, root)).toBe(700);
  });

  it.each(["", "unknown-session"])(
    "never falls back to latest for explicit missing or unknown identity '%s'", (sessionId) => {
      const { path, db, context } = fixture();
      const invalid = { ...context, sessionId };
      db.incrementToolCall("session-b", "ctx_search", 900);
      appendRetrievalBytes(path, 700, root);
      persistToolCallCounter(path, "ctx_search", 100, invalid);
      for (const event of eventCases) event.emit(path, invalid);
      appendRetrievalBytes(path, 123, root, invalid);
      expect(restoreSessionStats(path, invalid)).toBeNull();
      expect(consumeRetrievalBytes(path, root, invalid)).toBe(0);
      expect(consumeRetrievalBytes(path, root)).toBe(700);
      expect(db.getToolCallStats("session-b")).toMatchObject({ totalCalls: 1, totalBytesReturned: 900 });
      expect(db.getToolCallStats("session-a").totalCalls).toBe(0);
      expect(db.getEvents("session-a")).toEqual([]);
      expect(db.getEvents("session-b")).toEqual([]);
      expect(db.getToolCallStats(sessionId).totalCalls).toBe(0);
      expect(db.getEvents(sessionId)).toEqual([]);
      expect(db.getSessionStats(sessionId)).toBeNull();
    },
  );

  it("uses a borrowed SQLite handle and leaves it open for the caller", () => {
    const db = new SessionDB({ dbPath: ":memory:" });
    databases.push(db);
    const context: ExplicitContext = { sessionId: "session-a", db, workspaceDir: join(root, "worktree") };
    db.ensureSession(context.sessionId, context.workspaceDir);
    // Reopening :memory: would create an unrelated DB; existsSync also fails.
    persistToolCallCounter(":memory:", "ctx_search", 123, context);
    emitSandboxExecuteEvent({ sessionDbPath: ":memory:", toolName: "ctx_execute", bytesReturned: 31, context });
    expect(restoreSessionStats(":memory:", context)).toMatchObject({
      calls: { ctx_search: 1 }, bytesReturned: { ctx_search: 123 },
    });
    expect(db.getEvents("session-a")).toMatchObject([{ bytes_returned: 31 }]);
    db.ensureSession("still-open", context.workspaceDir);
    expect(db.getSessionStats("still-open")?.session_id).toBe("still-open");
  });

  it("refuses a context whose workspace does not belong to its DB session", () => {
    const { path, db, context } = fixture();
    const mismatched = { ...context, workspaceDir: join(root, "another-worktree") };
    persistToolCallCounter(path, "ctx_search", 123, mismatched);
    for (const event of eventCases) event.emit(path, mismatched);
    appendRetrievalBytes(path, 456, root, mismatched);
    expect(restoreSessionStats(path, mismatched)).toBeNull();
    expect(consumeRetrievalBytes(path, root, mismatched)).toBe(0);
    expect(consumeRetrievalBytes(path, root, context)).toBe(0);
    for (const sessionId of ["session-a", "session-b"]) {
      expect(db.getToolCallStats(sessionId).totalCalls).toBe(0);
      expect(db.getEvents(sessionId)).toEqual([]);
    }
    expect(db.getSessionStats("session-a")?.project_dir).toBe(context.workspaceDir);
  });

  it("preserves stdio latest-session and basename-marker behavior when context is omitted", () => {
    const { path, db } = fixture();
    persistToolCallCounter(path, "ctx_search", 123);
    emitSandboxExecuteEvent({ sessionDbPath: path, toolName: "ctx_execute", bytesReturned: 31 });
    expect(db.getToolCallStats("session-b").totalBytesReturned).toBe(123);
    expect(db.getEvents("session-b")).toMatchObject([{ bytes_returned: 31, project_dir: "" }]);
    expect(db.getToolCallStats("session-a").totalCalls).toBe(0);
    expect(db.getEvents("session-a")).toEqual([]);
    expect(restoreSessionStats(path)).toMatchObject({ calls: { ctx_search: 1 }, sessionStart: Date.UTC(2000, 0, 2) });
    const sameBasename = join(root, "other", "session.db");
    expect(retrievalMarkerPath(path, root)).toBe(retrievalMarkerPath(sameBasename, root));
    appendRetrievalBytes(path, 700, root);
    expect(consumeRetrievalBytes(sameBasename, root)).toBe(700);
  });
});
