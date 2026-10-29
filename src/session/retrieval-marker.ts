/**
 * Server→hook bridge for the retrieval ("With context-mode") byte count.
 *
 * WHY THIS EXISTS — context-mode's OWN MCP retrieval tools (ctx_search /
 * ctx_fetch_and_index) never fire a PostToolUse hook for the plugin's own
 * server, so the hook-side `extractMcpToolCall` path can never observe them
 * (verified empirically: 0 `mcp_tool_call` events locally, bytes_retrieved
 * 0/124454 in production D1). The MCP server, however, measures each
 * retrieval response's byte length directly.
 *
 * The server appends that count to a tmp marker keyed by the session DB
 * *basename* — the one identifier the server process and the hook process
 * both resolve reliably (CLAUDE_SESSION_ID is not guaranteed in the server
 * env; the per-project session DB path is). The next PostToolUse fire — which
 * DOES run for ordinary tools (Bash/Read/Edit) — consumes the marker and
 * emits a forwardable event carrying `bytes_retrieved`. Mirrors the existing
 * redirect / latency / rejected marker handshake in posttooluse.mjs.
 */

import { appendFileSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { resolveExplicitSessionContext, type SessionAttributionContext } from "./attribution-context.js";

/**
 * Tmp marker path for a session DB. Keyed by basename so the server (which
 * holds the DB path via getSessionDbPath) and the hook (getSessionDBPath)
 * derive the SAME file. Session DB filenames embed the worktree hash
 * (`<hash>__<suffix>.db`), so basename collisions across projects are
 * negligible. Explicit shared contexts use the full resolved DB path, session ID
 * and exact workspace instead; this also separates them from legacy markers.
 */
export function retrievalMarkerPath(
  sessionDbPath: string,
  tmpDir: string = tmpdir(),
  context?: SessionAttributionContext,
): string {
  if (context !== undefined) {
    const explicit = resolveExplicitSessionContext(context);
    if (!explicit) throw new Error("Invalid explicit retrieval attribution");
    const key = createHash("sha256")
      .update(JSON.stringify([resolve(sessionDbPath), explicit.sessionId, explicit.workspaceDir]))
      .digest("hex");
    return join(tmpDir, `context-mode-retrieval-shared-${key}.txt`);
  }
  return join(tmpDir, `context-mode-retrieval-${basename(sessionDbPath)}.txt`);
}

/**
 * Record one retrieval's response byte count. Positive-only (a 0-byte or
 * failed retrieval is not a context cost). Append-only so several retrievals
 * between two hook fires accumulate. Best-effort — never throws into the
 * MCP response path.
 */
export function appendRetrievalBytes(
  sessionDbPath: string, bytes: number, tmpDir?: string, context?: SessionAttributionContext,
): void {
  if (!Number.isFinite(bytes) || bytes <= 0) return;
  try {
    appendFileSync(retrievalMarkerPath(sessionDbPath, tmpDir, context), `${Math.floor(bytes)}\n`);
  } catch { /* best-effort — never block the MCP response */ }
}

/**
 * Sum every recorded retrieval and delete the marker (consume-once) so the
 * next PostToolUse fire cannot re-forward the same bytes. Returns 0 when no
 * marker exists (phantom-event guard).
 */
export function consumeRetrievalBytes(
  sessionDbPath: string, tmpDir?: string, context?: SessionAttributionContext,
): number {
  let total = 0;
  try {
    const path = retrievalMarkerPath(sessionDbPath, tmpDir, context);
    const raw = readFileSync(path, "utf8");
    for (const line of raw.split("\n")) {
      const n = Number.parseInt(line, 10);
      if (Number.isFinite(n) && n > 0) total += n;
    }
    rmSync(path, { force: true });
  } catch { /* no marker — phantom-event guard */ }
  return total;
}
