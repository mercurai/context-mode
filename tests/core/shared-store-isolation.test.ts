import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentStore } from "../../src/store.js";
import { loadDatabase } from "../../src/db-base.js";

describe("shared ContentStore source ownership", () => {
  let directory: string;
  let databasePath: string;
  let store: ContentStore;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "ctx-shared-store-"));
    databasePath = join(directory, "content.db");
    store = new ContentStore(databasePath);
  });

  afterEach(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function reopenStore(): void {
    store.close();
    store = new ContentStore(databasePath);
  }

  function searchPrivate(query: string, sessionIds: string[]) {
    // Seventh argument is additive: existing project-search callers retain
    // legacy visibility, while shared-session callers explicitly exclude it.
    return store.searchWithFallback(
      query,
      20,
      undefined,
      undefined,
      "exact",
      new Set(sessionIds),
      { includeUnattributed: false },
    );
  }

  function expectStoredAttribution(source: string, sessionId: string, eventId: string): void {
    const Database = loadDatabase();
    const database = new Database(databasePath, { readonly: true });
    try {
      const expected = [{ session_id: sessionId, event_id: eventId }];
      expect(database.prepare("SELECT session_id, event_id FROM sources WHERE label = ?").all(source))
        .toEqual(expected);
      for (const table of ["chunks", "chunks_trigram"]) {
        expect(database.prepare(`
          SELECT DISTINCT session_id, event_id FROM ${table}
          WHERE source_id IN (SELECT id FROM sources WHERE label = ?)
        `).all(source)).toEqual(expected);
      }
    } finally {
      database.close();
    }
  }

  test.each(["markdown", "plaintext", "json"] as const)(
    "%s sources with the same label coexist across owners after reopening",
    (format) => {
      const source = "execute:javascript";
      for (const sessionId of ["session-A", "session-B"]) {
        const content = `Authentication results for ${sessionId}.`;
        const attribution = { sessionId };
        if (format === "markdown") {
          store.index({ content, source, attribution });
        } else if (format === "plaintext") {
          store.indexPlainText(content, source, undefined, attribution);
        } else {
          store.indexJSON(JSON.stringify({ result: content }), source, undefined, attribution);
        }
      }

      reopenStore();

      for (const sessionId of ["session-A", "session-B"]) {
        const results = searchPrivate("authentication", [sessionId]);
        expect(results.length).toBeGreaterThan(0);
        expect(new Set(results.map((result) => result.sessionId))).toEqual(new Set([sessionId]));
        expect(results.every((result) => result.source === source)).toBe(true);
        expect(results.map((result) => result.content).join("\n")).toContain(sessionId);
      }
    },
  );

  test("reindexing an owner replaces only that owner's same-label source", () => {
    const source = "build-output";
    store.index({ content: "Obsolete cedar implementation.", source, attribution: { sessionId: "session-A" } });
    store.index({ content: "Retained birch implementation.", source, attribution: { sessionId: "session-B" } });
    store.index({ content: "Legacy willow implementation.", source });
    store.index({ content: "Updated maple implementation.", source, attribution: { sessionId: "session-A" } });

    reopenStore();

    expect(store.searchWithFallback("obsolete", 20)).toEqual([]);
    const updated = searchPrivate("updated", ["session-A"]);
    expect(updated.length).toBeGreaterThan(0);
    expect(updated.every((result) => result.content.includes("maple"))).toBe(true);
    const sibling = searchPrivate("retained", ["session-B"]);
    expect(sibling.length).toBeGreaterThan(0);
    expect(sibling.every((result) => result.content.includes("birch"))).toBe(true);
    const legacy = store.searchWithFallback("legacy", 20);
    expect(legacy.length).toBeGreaterThan(0);
    expect(legacy.every((result) => result.sessionId === "")).toBe(true);
  });

  test.each([
    ["authentication", "rrf"],
    ["authentcation", "rrf-fuzzy"],
  ])("same-label, same-heading owners remain distinct for %s search", (query, matchLayer) => {
    for (const sessionId of ["session-A", "session-B"]) {
      store.index({
        content: `# Shared findings\n\nAuthentication belongs to ${sessionId}.`,
        source: "same-label",
        attribution: { sessionId },
      });
    }
    reopenStore();

    const both = searchPrivate(query, ["session-A", "session-B"]);
    expect(both).toHaveLength(2);
    expect(new Set(both.map((result) => result.sessionId))).toEqual(new Set(["session-A", "session-B"]));
    expect(both.every((result) => result.matchLayer === matchLayer)).toBe(true);

    for (const sessionId of ["session-A", "session-B"]) {
      const own = searchPrivate(query, [sessionId]);
      expect(own).toHaveLength(1);
      expect(own[0].sessionId).toBe(sessionId);
      expect(own[0].content).toContain(sessionId);
    }
  });

  function indexVisibilityFixtures(): void {
    store.index({
      content: "Authentication details for the first conversation.",
      source: "private-A",
      attribution: { sessionId: "session-A", eventId: "event-A" },
    });
    store.index({
      content: "Authentication details for the second conversation.",
      source: "private-B",
      attribution: { sessionId: "session-B", eventId: "event-B" },
    });
    store.index({ content: "Authentication details from legacy research.", source: "legacy" });
  }

  test.each(["authentication", "authentcation"])(
    "private search excludes sibling and legacy content for query %s",
    (query) => {
      indexVisibilityFixtures();

      const results = searchPrivate(query, ["session-A"]);

      expect(results.length).toBeGreaterThan(0);
      expect(new Set(results.map((result) => result.source))).toEqual(new Set(["private-A"]));
      expect(results.every((result) => result.sessionId === "session-A")).toBe(true);
    },
  );

  test("an empty private allow-set exposes no attributed or legacy content", () => {
    indexVisibilityFixtures();

    expect(searchPrivate("authentication", [])).toEqual([]);
  });

  test.each(["authentication", "authentcation"])(
    "foreign matches cannot crowd an owner's matching content out of %s search",
    (query) => {
      store.indexPlainText(
        `Authentication belongs to this conversation. ${"Background detail. ".repeat(100)}`,
        "private-A",
        undefined,
        { sessionId: "session-A" },
      );
      for (let index = 0; index < 50; index++) {
        store.indexPlainText("Authentication.", `private-B-${index}`, undefined, { sessionId: "session-B" });
      }
      reopenStore();

      // The shared store has many shorter, better-ranked foreign matches.
      // Asking for one own result must still find the owner's weaker match.
      const result = store.searchWithFallback(
        query, 1, undefined, undefined, "exact", new Set(["session-A"]),
        { includeUnattributed: false },
      );
      expect(result).toHaveLength(1);
      expect(result[0].source).toBe("private-A");
      expect(result[0].sessionId).toBe("session-A");
      expect(result[0].content).toContain("belongs to this conversation");
    },
  );

  test("newly denied own files cannot crowd allowed content out of private search", () => {
    store.indexPlainText(
      `Authentication remains allowed. ${"Background detail. ".repeat(100)}`,
      "allowed-A",
      undefined,
      { sessionId: "session-A" },
    );
    const deniedPaths = new Set<string>();
    for (let index = 0; index < 50; index++) {
      const filePath = join(directory, `denied-${index}.md`);
      writeFileSync(filePath, "Authentication.");
      store.index({ path: filePath, source: `denied-A-${index}`, attribution: { sessionId: "session-A" } });
      deniedPaths.add(filePath);
    }
    reopenStore();

    const result = store.searchWithFallback(
      "authentication", 1, undefined, undefined, "exact", new Set(["session-A"]),
      { includeUnattributed: false, denyChecker: (path) => deniedPaths.has(path) },
    );
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("allowed-A");
    expect(result[0].content).toContain("remains allowed");
  });

  test("wider visibility includes only explicitly selected sessions and legacy scope", () => {
    indexVisibilityFixtures();

    const selectedSessions = searchPrivate("authentication", ["session-A", "session-B"]);
    expect(new Set(selectedSessions.map((result) => result.source)))
      .toEqual(new Set(["private-A", "private-B"]));

    const withLegacy = store.searchWithFallback(
      "authentication",
      20,
      undefined,
      undefined,
      "exact",
      new Set(["session-A"]),
      { includeUnattributed: true },
    );
    expect(new Set(withLegacy.map((result) => result.source)))
      .toEqual(new Set(["private-A", "legacy"]));
  });

  test("existing six-argument project search keeps its legacy visibility", () => {
    indexVisibilityFixtures();

    const results = store.searchWithFallback(
      "authentication", 20, undefined, undefined, "exact", new Set(["session-A"]),
    );

    expect(new Set(results.map((result) => result.source))).toEqual(new Set(["private-A", "legacy"]));
  });

  test("owner-scoped cache metadata never selects a sibling's same-label source", () => {
    const fileA = join(directory, "a.md");
    const fileB = join(directory, "b.md");
    writeFileSync(fileA, "Authentication research from A.");
    writeFileSync(fileB, "Authentication research from B.");
    store.index({ path: fileA, source: "same-label", attribution: { sessionId: "session-A" } });
    store.index({ path: fileB, source: "same-label", attribution: { sessionId: "session-B" } });
    reopenStore();

    expect(store.getSourceMeta("same-label", { sessionId: "session-A" })?.filePath).toBe(fileA);
    expect(store.getSourceMeta("same-label", { sessionId: "session-B" })?.filePath).toBe(fileB);
    expect(store.getSourceMeta("same-label", { sessionId: "session-C" })).toBeNull();
    expect(store.getSourceMeta("same-label", {})).toBeNull();
    expect(store.getSourceMeta("same-label")).toBeNull();
  });

  test("empty-source replacement retains ownership without deleting another owner's content", () => {
    store.indexPlainText("Authentication details from A.", "same-label", undefined, { sessionId: "session-A" });
    store.indexPlainText("Authentication details from B.", "same-label", undefined, { sessionId: "session-B" });
    store.indexPlainText("", "same-label", undefined, { sessionId: "session-A" });
    reopenStore();

    expect(store.getSourceMeta("same-label", { sessionId: "session-A" })?.chunkCount).toBe(0);
    expect(searchPrivate("authentication", ["session-A"])).toEqual([]);
    expect(searchPrivate("authentication", ["session-B"]).length).toBeGreaterThan(0);
  });

  test("migrates source ownership from existing chunks without losing legacy content", () => {
    indexVisibilityFixtures();
    store.close();
    const Database = loadDatabase();
    const legacy = new Database(databasePath);
    try {
      // Recreate the sources table with the released pre-ownership schema;
      // chunk attribution and identifiers are retained exactly as deployed.
      legacy.exec(`
        CREATE TABLE old_sources (
          id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL,
          chunk_count INTEGER NOT NULL DEFAULT 0, code_chunk_count INTEGER NOT NULL DEFAULT 0,
          indexed_at TEXT NOT NULL DEFAULT (datetime('now')), file_path TEXT, content_hash TEXT
        );
        INSERT INTO old_sources SELECT
          id, label, chunk_count, code_chunk_count, indexed_at, file_path, content_hash FROM sources;
        DROP TABLE sources;
        ALTER TABLE old_sources RENAME TO sources;
      `);
    } finally {
      legacy.close();
    }
    store = new ContentStore(databasePath);

    expect(store.getSourceMeta("private-A", { sessionId: "session-A" })).not.toBeNull();
    expect(store.getSourceMeta("private-B", { sessionId: "session-B" })).not.toBeNull();
    expect(store.getSourceMeta("legacy", {})).not.toBeNull();
    expect(store.searchWithFallback("authentication", 20)).toHaveLength(3);
    expectStoredAttribution("private-A", "session-A", "event-A");
    expectStoredAttribution("private-B", "session-B", "event-B");
    reopenStore();
    expect(store.searchWithFallback("authentication", 20)).toHaveLength(3);
    expectStoredAttribution("private-A", "session-A", "event-A");

    store.index({
      content: "Replacement authorization details.", source: "private-A", attribution: { sessionId: "session-A" },
    });
    expect(searchPrivate("authentication", ["session-A"])).toEqual([]);
    expect(searchPrivate("authorization", ["session-A"])).toHaveLength(1);
    expect(searchPrivate("authentication", ["session-B"])).toHaveLength(1);
  });

  test("request-local refresh policy does not replace or persist beyond the request", () => {
    const filePath = join(directory, "policy.md");
    writeFileSync(filePath, "Authentication originally used passwords.");
    store.index({ path: filePath, source: "file-A", attribution: { sessionId: "session-A" } });
    const metadata = store.getSourceMeta("file-A", { sessionId: "session-A" })!;
    writeFileSync(filePath, "Authentication now uses passkeys.");
    const modifiedAt = new Date(`${metadata.indexedAt}Z`).getTime() + 2_000;
    utimesSync(filePath, modifiedAt / 1_000, modifiedAt / 1_000);

    // The request callback cannot relax a baseline denial.
    store.setDenyChecker(() => true);
    const baselineDenied = store.searchWithFallback(
      "passkeys", 20, undefined, undefined, "exact", new Set(["session-A"]),
      { includeUnattributed: false, denyChecker: () => false },
    );
    expect(baselineDenied).toEqual([]);
    expect(store.lastRefreshCount).toBe(0);
    store.setDenyChecker(undefined);

    const requestDenied = store.searchWithFallback(
      "passkeys", 20, undefined, undefined, "exact", new Set(["session-A"]),
      { includeUnattributed: false, denyChecker: (_path, owner) => owner.sessionId === "session-A" },
    );
    expect(requestDenied).toEqual([]);
    expect(store.lastRefreshCount).toBe(0);

    expect(searchPrivate("passkeys", ["session-A"])).toHaveLength(1);
    expect(store.lastRefreshCount).toBe(1);
  });

  test("request-local denial excludes old cached file content without poisoning the next request", () => {
    const filePath = join(directory, "cached-policy.md");
    writeFileSync(filePath, "Authentication originally used passwords.");
    store.index({ path: filePath, source: "cached-A", attribution: { sessionId: "session-A" } });
    reopenStore();

    const denied = store.searchWithFallback(
      "passwords", 20, undefined, undefined, "exact", new Set(["session-A"]),
      {
        includeUnattributed: false,
        denyChecker: (path, owner) => path === filePath && owner.sessionId === "session-A",
      },
    );
    expect(denied).toEqual([]);

    const allowed = searchPrivate("passwords", ["session-A"]);
    expect(allowed).toHaveLength(1);
    expect(allowed[0].content).toContain("passwords");
  });

  test("a sibling search leaves a foreign file source untouched until its owner searches", () => {
    const filePath = join(directory, "notes.md");
    writeFileSync(filePath, "Authentication originally used passwords.");
    store.index({
      path: filePath, source: "file-A", attribution: { sessionId: "session-A", eventId: "file-event-A" },
    });
    store.index({
      content: "Authentication for the sibling still uses certificates.",
      source: "private-B",
      attribution: { sessionId: "session-B" },
    });
    reopenStore();
    expectStoredAttribution("file-A", "session-A", "file-event-A");

    const metadata = store.getSourceMeta("file-A");
    expect(metadata).not.toBeNull();
    writeFileSync(filePath, "Authentication now uses passkeys.");
    // Advance the file relative to its persisted index timestamp, without
    // waiting for the wall clock or depending on filesystem clock resolution.
    const modifiedAt = new Date(`${metadata!.indexedAt}Z`).getTime() + 2_000;
    utimesSync(filePath, modifiedAt / 1_000, modifiedAt / 1_000);

    const checkedPaths: string[] = [];
    const sibling = store.searchWithFallback(
      "authentication", 20, undefined, undefined, "exact", new Set(["session-B"]),
      { includeUnattributed: false, denyChecker: (path) => { checkedPaths.push(path); return false; } },
    );
    expect(store.lastRefreshCount).toBe(0);
    expect(checkedPaths).not.toContain(filePath);
    expect(store.getSourceMeta("file-A", { sessionId: "session-A" })).toEqual(metadata);
    expect(store.search("passwords", 20, "file-A", "AND", undefined, "exact")).toHaveLength(1);
    expect(store.search("passkeys", 20, "file-A", "AND", undefined, "exact")).toEqual([]);
    expect(new Set(sibling.map((result) => result.source))).toEqual(new Set(["private-B"]));

    reopenStore();
    expectStoredAttribution("file-A", "session-A", "file-event-A");
    const refreshed = searchPrivate("passkeys", ["session-A"]);
    expect(store.lastRefreshCount).toBe(1);
    expect(refreshed.length).toBeGreaterThan(0);
    expect(refreshed.every((result) => result.source === "file-A" && result.sessionId === "session-A"))
      .toBe(true);
    expect(searchPrivate("passwords", ["session-A"])).toEqual([]);
    expect(searchPrivate("passkeys", ["session-B"])).toEqual([]);
  });
});
