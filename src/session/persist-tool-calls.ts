/**
 * persist-tool-calls — runtime glue between MCP server's in-memory
 * `sessionStats` and the on-disk `tool_calls` SessionDB table.
 *
 * Why this module exists
 * ──────────────────────
 * Commit 4742160 (May 2 16:58) added the SessionDB write path so the
 * statusline counters survived `npm update -g context-mode` and
 * `claude --continue`. Commit b392c2f (May 2 21:43) — the concurrency
 * refactor — silently dropped that wiring as collateral. Same-session
 * `/ctx-upgrade` flips the statusline back to `0 calls / $0.00`
 * because the new PID starts with an empty `sessionStats` and never
 * looks at the table the old PID was writing to.
 *
 * This module re-introduces the write path AND adds the read-side
 * restore that 4742160 never shipped — both pure helpers so the
 * server.ts wiring is a one-liner and the unit tests don't need to
 * boot the MCP server.
 */

import { withSessionAttribution, type SessionAttributionContext } from "./attribution-context.js";

/**
 * Shape returned by {@link restoreSessionStats}. Subset of the in-memory
 * `sessionStats` object the MCP server keeps — only the fields that can
 * be recovered from SessionDB.
 */
export interface RestoredSessionStats {
  /** Per-tool call counts. */
  calls: Record<string, number>;
  /** Per-tool returned bytes. */
  bytesReturned: Record<string, number>;
  /**
   * Epoch-ms for `session_meta.started_at` of the latest session, so the
   * statusline `uptime_ms` reflects the original session start instead of
   * resetting to `Date.now()` on every PID change.
   */
  sessionStart: number;
}

/**
 * Increment the persistent tool-call counter for `toolName` under whatever
 * session_id `session_meta` currently treats as the most recent, or the explicit
 * shared context's session when supplied. The context's DB remains caller-owned. This is
 * called from {@link trackResponse} on every tool response and must be
 * cheap, non-throwing, and best-effort — a stats failure must never break
 * the MCP tool call.
 */
export function persistToolCallCounter(
  sessionDbPath: string,
  toolName: string,
  bytes: number,
  context?: SessionAttributionContext,
): void {
  withSessionAttribution(sessionDbPath, context, (sdb, sid) => {
    sdb.incrementToolCall(sid, toolName, bytes);
  });
}

/**
 * Read the explicit session's totals, or the latest session for legacy callers, so the
 * MCP server can hydrate its in-memory `sessionStats` on startup. Returns
 * `null` when the DB is missing or empty so the caller can keep the
 * default zero-state without branching twice.
 *
 * Used during MCP server boot (BEFORE the heartbeat fires) so the
 * statusline doesn't briefly flash `0 calls / $0.00` after upgrade.
 */
export function restoreSessionStats(
  sessionDbPath: string,
  context?: SessionAttributionContext,
): RestoredSessionStats | null {
  return withSessionAttribution(sessionDbPath, context, (sdb, sid) => {
    const stats = sdb.getToolCallStats(sid);
    const calls: Record<string, number> = {};
    const bytesReturned: Record<string, number> = {};
    for (const [tool, row] of Object.entries(stats.byTool)) {
      calls[tool] = row.calls;
      bytesReturned[tool] = row.bytesReturned;
    }

    // SQLite's default timestamp is UTC, without a zone suffix.
    let sessionStart = Date.now();
    try {
      const meta = sdb.getSessionStats(sid);
      if (meta?.started_at) {
        const parsed = Date.parse(`${meta.started_at}Z`);
        if (Number.isFinite(parsed) && parsed > 0) sessionStart = parsed;
      }
    } catch {
      // Best-effort: retain the legacy current-time fallback.
    }

    // An empty explicit session still has its own original start time.
    return { calls, bytesReturned, sessionStart };
  });
}
