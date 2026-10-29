import { AsyncLocalStorage } from "node:async_hooks";
import type { ContentStore } from "../store.js";
import type { SessionAttributionContext } from "../session/attribution-context.js";
import type { ResolvedIdentity } from "./identity.js";
import type { FloodGuard } from "../search/flood-guard.js";
import type { PolyglotExecutor } from "../executor.js";

/** Structural seam for a trusted, policy-bound job adapter. */
export type SharedExecutor = Pick<PolyglotExecutor, "execute" | "executeFile" | "close">;

export interface SharedExecutionContext {
  /** Launch/policy identity; distinct from the durable statistics owner. */
  readonly authorityId: string;
  readonly executor: SharedExecutor;
  readonly cwd: string;
  readonly signal: AbortSignal;
}

export interface SharedSessionStats {
  calls: Record<string, number>;
  bytesReturned: Record<string, number>;
  bytesIndexed: number;
  bytesSandboxed: number;
  cacheHits: number;
  cacheMisses: number;
  cacheBytesSaved: number;
  sessionStart: number;
}

export interface SharedToolContext {
  readonly identity: Readonly<ResolvedIdentity>;
  readonly ownerId: string;
  readonly store: ContentStore;
  readonly storePath: string;
  readonly sessionDbPath: string;
  readonly sessionsDir: string;
  readonly statsPath: string;
  readonly attribution: Readonly<SessionAttributionContext>;
  readonly stats: SharedSessionStats;
  readonly persistence: { lastWrite: number };
  readonly floodGuard: FloodGuard;
  readonly now: () => number;
  readonly denyFile: (filePath: string) => boolean;
  /** Supplied only by trusted execution integration, never tool arguments. */
  readonly execution?: Readonly<SharedExecutionContext>;
}

const sharedContext = new AsyncLocalStorage<Readonly<SharedToolContext>>();

export function getSharedToolContext(): Readonly<SharedToolContext> | undefined {
  return sharedContext.getStore();
}

export function withSharedToolContext<T>(context: Readonly<SharedToolContext>, fn: () => T): T {
  return sharedContext.run(context, fn);
}
