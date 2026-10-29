import { existsSync } from "node:fs";
import { isAbsolute, win32 } from "node:path";
import { SessionDB } from "./db.js";

/** Resolved by the trusted service adapter; the caller owns the borrowed DB. */
export interface SessionAttributionContext {
  sessionId: string;
  db: SessionDB;
  workspaceDir: string;
}

/** Invalid explicit contexts never fall back to the latest session. */
export function resolveExplicitSessionContext(
  context: SessionAttributionContext,
): SessionAttributionContext | null {
  try {
    const { sessionId, db, workspaceDir } = context;
    if (!(db instanceof SessionDB) || typeof sessionId !== "string" ||
        !sessionId || sessionId !== sessionId.trim() || sessionId.length > 256 ||
        /[\x00-\x1f\x7f]/.test(sessionId) || typeof workspaceDir !== "string" ||
        (!isAbsolute(workspaceDir) && !win32.isAbsolute(workspaceDir))) return null;
    const session = db.getSessionStats(sessionId);
    if (!session || session.project_dir !== workspaceDir) return null;
    return { sessionId, db, workspaceDir };
  } catch {
    return null;
  }
}

/** Best-effort attribution. Only the legacy path opens and closes its own DB. */
export function withSessionAttribution<T>(
  dbPath: string,
  context: SessionAttributionContext | undefined,
  fn: (db: SessionDB, sessionId: string, workspaceDir?: string) => T,
): T | null {
  try {
    if (context !== undefined) {
      const explicit = resolveExplicitSessionContext(context);
      return explicit ? fn(explicit.db, explicit.sessionId, explicit.workspaceDir) : null;
    }
    if (!existsSync(dbPath)) return null;
    const db = new SessionDB({ dbPath });
    try {
      const sessionId = db.getLatestSessionId();
      return sessionId ? fn(db, sessionId) : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}
