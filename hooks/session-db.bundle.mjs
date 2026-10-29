import{createRequire as ne}from"node:module";import{existsSync as se,unlinkSync as P,renameSync as oe}from"node:fs";import{tmpdir as ie}from"node:os";import{join as ae}from"node:path";var w=class{#e;constructor(e){this.#e=e}pragma(e){let n=this.#e.prepare(`PRAGMA ${e}`).all();if(!n||n.length===0)return;if(n.length>1)return n;let s=Object.values(n[0]);return s.length===1?s[0]:n[0]}exec(e){let t="",n=null;for(let i=0;i<e.length;i++){let a=e[i];if(n)t+=a,a===n&&(n=null);else if(a==="'"||a==='"')t+=a,n=a;else if(a===";"){let c=t.trim();c&&this.#e.prepare(c).run(),t=""}else t+=a}let s=t.trim();return s&&this.#e.prepare(s).run(),this}prepare(e){let t=this.#e.prepare(e);return{run:(...n)=>t.run(...n),get:(...n)=>{let s=t.get(...n);return s===null?void 0:s},all:(...n)=>t.all(...n),iterate:(...n)=>t.iterate(...n)}}transaction(e){return this.#e.transaction(e)}close(){this.#e.close()}},x=class{#e;constructor(e){this.#e=e}pragma(e){let n=this.#e.prepare(`PRAGMA ${e}`).all();if(!n||n.length===0)return;if(n.length>1)return n;let s=Object.values(n[0]);return s.length===1?s[0]:n[0]}exec(e){return this.#e.exec(e),this}prepare(e){let t=this.#e.prepare(e);return{run:(...n)=>t.run(...n),get:(...n)=>t.get(...n),all:(...n)=>t.all(...n),iterate:(...n)=>typeof t.iterate=="function"?t.iterate(...n):t.all(...n)[Symbol.iterator]()}}transaction(e){return(...t)=>{this.#e.exec("BEGIN");try{let n=e(...t);return this.#e.exec("COMMIT"),n}catch(n){throw this.#e.exec("ROLLBACK"),n}}}close(){this.#e.close()}},y=null;function ce(r){let e=null;try{return e=new r(":memory:"),e.exec("CREATE VIRTUAL TABLE __fts5_probe USING fts5(x)"),!0}catch{return!1}finally{try{e?.close()}catch{}}}function ue(r,e){let t=e!==void 0?e:globalThis.Bun;if(typeof t<"u"&&t!==null)return!0;let n=r??process.versions,[s,i]=(n.node??"0.0.0").split("."),a=Number(s),c=Number(i);return!Number.isFinite(a)||!Number.isFinite(c)?!1:a>22||a===22&&c>=5}function de(){if(!y){let r=ne(import.meta.url);if(globalThis.Bun){let e=r(["bun","sqlite"].join(":")).Database;y=function(n,s){let i=new e(n,{readonly:s?.readonly,create:!0}),a=new w(i);return s?.timeout&&a.pragma(`busy_timeout = ${s.timeout}`),a}}else if(ue()){let e=null;try{({DatabaseSync:e}=r(["node","sqlite"].join(":")))}catch{e=null}e&&ce(e)?y=function(n,s){let i=new e(n,{readOnly:s?.readonly??!1}),a=new x(i);return s?.timeout&&a.pragma(`busy_timeout = ${s.timeout}`),a}:y=r("better-sqlite3")}else y=r("better-sqlite3")}return y}function M(r){r.pragma("journal_mode = WAL"),r.pragma("synchronous = NORMAL");try{r.pragma("mmap_size = 268435456")}catch{}}function F(r){if(!se(r))for(let e of["-wal","-shm"])try{P(r+e)}catch{}}function le(r){for(let e of["","-wal","-shm"])try{P(r+e)}catch{}}function I(r){try{r.pragma("wal_checkpoint(TRUNCATE)")}catch{}try{r.close()}catch{}}function k(r="context-mode"){return ae(ie(),`${r}-${process.pid}.db`)}function Ee(r,e=[100,500,2e3]){let t;for(let n=0;n<=e.length;n++)try{return r()}catch(s){let i=s instanceof Error?s.message:String(s);if(!i.includes("SQLITE_BUSY")&&!i.includes("database is locked"))throw s;if(t=s instanceof Error?s:new Error(i),n<e.length){let a=e[n],c=Date.now();for(;Date.now()-c<a;);}}throw new Error(`SQLITE_BUSY: database is locked after ${e.length} retries. Original error: ${t?.message}`)}function ge(r){return r.includes("SQLITE_CORRUPT")||r.includes("SQLITE_NOTADB")||r.includes("database disk image is malformed")||r.includes("file is not a database")}function me(r){let e=Date.now();for(let t of["","-wal","-shm"])try{oe(r+t,`${r}${t}.corrupt-${e}`)}catch{}}var v=Symbol.for("__context_mode_live_dbs_v3__"),A=(()=>{let r=globalThis;return r[v]||(r[v]=new Set,process.on("exit",()=>{for(let e of r[v])I(e);r[v].clear()})),r[v]})(),N=class{#e;#t;constructor(e){let t=de();this.#e=e,F(e);let n;try{n=new t(e,{timeout:3e4}),M(n)}catch(s){let i=s instanceof Error?s.message:String(s);if(ge(i)){me(e),F(e);try{n=new t(e,{timeout:3e4}),M(n)}catch(a){throw new Error(`Failed to create fresh DB after renaming corrupt file: ${a instanceof Error?a.message:String(a)}`)}}else throw s}this.#t=n,A.add(this.#t),this.initSchema(),this.prepareStatements()}get db(){return this.#t}get dbPath(){return this.#e}close(){A.delete(this.#t),I(this.#t)}withRetry(e){return Ee(e)}cleanup(){A.delete(this.#t),I(this.#t),le(this.#e)}};import{createHash as R}from"node:crypto";import{execFileSync as _e}from"node:child_process";import{accessSync as pe,constants as ye,existsSync as O,mkdirSync as Se,realpathSync as he,renameSync as U}from"node:fs";import{homedir as $}from"node:os";import{dirname as fe,isAbsolute as q,join as E,resolve as h}from"node:path";var d="CONTEXT_MODE_DIR",G="sessions",j="content",b=class extends Error{kind;path;overrideEnvVar;ignoredEnvVar;ignoredReason;constructor(e,t,n=d,s,i,a={}){super(i??Le(e,t,a),{cause:s}),this.name="StorageDirectoryError",this.kind=e,this.path=t,this.overrideEnvVar=n,this.ignoredEnvVar=a.ignoredEnvVar,this.ignoredReason=a.ignoredReason}},C=new Map;function Xe(r){let e=r.env??process.env,t=r.legacySessionDirEnv,n=t?e[t]?.trim():void 0;return n&&t?(r.onLegacySessionDir?.(t,n),n):E(Te(r.configDir,r.configDirEnv,e),"context-mode","sessions")}function Te(r,e,t){let n=e?t[e]:void 0;return n&&n.trim()!==""?B(n.trim()):B(r,$())}function B(r,e){return r.startsWith("~")?h($(),r.replace(/^~[/\\]?/,"")):q(r)?h(r):e?h(e,r):h(r)}function ve(r,e,t){return new b(r,e,d,void 0,[`Invalid ${d} for context-mode ${r} directory: ${t}`,Q()].join(`
`))}function Y(r){let e=process.env[d];if(e===void 0)return{kind:"unset"};let t=e.trim();if(!t)return{kind:"ignored-empty",ignoredEnvVar:d,ignoredReason:"empty"};if(!q(t))throw ve(r,t,`${d} must be an absolute path.`);return{kind:"override",root:h(t)}}function Re(r){return r.kind==="ignored-empty"?{ignoredEnvVar:r.ignoredEnvVar,ignoredReason:r.ignoredReason}:{}}function K(r,e){let t=Y(r);return t.kind!=="override"?null:{kind:r,path:E(t.root,e),envVar:d,source:"override"}}function be(r,e,t){return{kind:r,path:h(e()),envVar:null,source:"default",...t}}function z(r){let e=Y("session");return e.kind==="override"?{kind:"session",path:E(e.root,G),envVar:d,source:"override"}:be("session",r,Re(e))}function $e(r){let e=K("content",j);if(e)return e;let t=z(r);return{kind:"content",path:E(fe(t.path),j),envVar:t.envVar,source:t.source,ignoredEnvVar:t.ignoredEnvVar,ignoredReason:t.ignoredReason}}function qe(r){let e=K("stats",G);if(e)return e;let t=z(r);return{kind:"stats",path:t.path,envVar:t.envVar,source:t.source,ignoredEnvVar:t.ignoredEnvVar,ignoredReason:t.ignoredReason}}function Ge(r){return r.message}function Ye(r){return r.source==="override"&&r.envVar?`via ${r.envVar}`:r.ignoredEnvVar&&r.ignoredReason==="empty"?`default; ignored empty ${r.ignoredEnvVar}`:"default"}function Ke(){C.clear()}function ze(r){let e=[r.kind,r.path,r.source,r.envVar??"",r.ignoredEnvVar??"",r.ignoredReason??""].join("\0"),t=C.get(e);if(t instanceof b)throw t;if(t===r.path)return t;try{return Se(r.path,{recursive:!0}),pe(r.path,ye.W_OK),C.set(e,r.path),r.path}catch(n){let s=new b(r.kind,De(n)??r.path,d,n,void 0,{ignoredEnvVar:r.ignoredEnvVar,ignoredReason:r.ignoredReason});throw C.set(e,s),s}}function Le(r,e,t={}){return[`context-mode ${r} directory is not writable: ${e}`,Ne(t),Q()].filter(Boolean).join(`
`)}function Ne(r){return r.ignoredEnvVar&&r.ignoredReason==="empty"?`Ignored empty ${r.ignoredEnvVar}; using adapter default.`:null}function Q(){return`Set ${d} to a writable absolute path.`}function De(r){if(!r||typeof r!="object")return null;let e=r.path;return typeof e=="string"&&e.length>0?e:null}var S;function _(r){let e=r.replace(/\\/g,"/");return/^\/+$/.test(e)?"/":/^[A-Za-z]:\/+$/.test(e)?`${e.slice(0,2)}/`:e.replace(/\/+$/,"")}function H(r){let e=r;try{e=he.native(r)}catch{}let t=_(e);return process.platform==="win32"||process.platform==="darwin"?t.toLowerCase():t}function J(r,e){return _e("git",["-C",r,...e],{encoding:"utf-8",timeout:2e3,stdio:["ignore","pipe","ignore"]}).trim()}function Ce(r){let e=J(r,["rev-parse","--show-toplevel"]);return e.length>0?_(e):null}function Oe(r){let e=J(r,["worktree","list","--porcelain"]).split(/\r?\n/).find(t=>t.startsWith("worktree "))?.replace("worktree ","")?.trim();return e?_(e):null}function Ae(r=process.cwd()){let e=process.env.CONTEXT_MODE_SESSION_SUFFIX;if(S&&S.projectDir===r&&S.envSuffix===e)return S.suffix;let t="";if(e!==void 0)t=e?`__${e}`:"";else try{let n=Ce(r),s=Oe(r);if(n&&s){let i=H(n),a=H(s);i!==a&&(t=`__${R("sha256").update(i).digest("hex").slice(0,8)}`)}}catch{}return S={projectDir:r,envSuffix:e,suffix:t},t}function Qe(){S=void 0}function Z(r){return R("sha256").update(_(r)).digest("hex").slice(0,16)}function ee(r){let e=_(r),t=process.platform==="darwin"||process.platform==="win32"?e.toLowerCase():e;return R("sha256").update(t).digest("hex").slice(0,16)}function Je(r){let{projectDir:e,contentDir:t}=r,n=ee(e),s=E(t,`${n}.db`);if(O(s))return s;let i=Z(e);if(i===n)return s;let a=E(t,`${i}.db`);if(O(a))try{U(a,s);for(let c of["-wal","-shm"])try{U(a+c,s+c)}catch{}}catch{}return s}function Ze(r){return we({...r,ext:".db"})}function we(r){let{projectDir:e,sessionsDir:t,ext:n}=r,s=r.suffix??Ae(e),i=ee(e),a=E(t,`${i}${s}${n}`);if(O(a))return a;let c=Z(e);if(c===i)return a;let u=E(t,`${c}${s}${n}`);if(O(u))try{U(u,a)}catch{}return a}var V=1e3,W=5;function D(r){let e=Number(r);return!Number.isFinite(e)||e<=0?0:Math.floor(e)}var o={insertEvent:"insertEvent",getEvents:"getEvents",getEventsByType:"getEventsByType",getEventsByPriority:"getEventsByPriority",getEventsByTypeAndPriority:"getEventsByTypeAndPriority",getEventCount:"getEventCount",getLatestAttributedProject:"getLatestAttributedProject",checkDuplicate:"checkDuplicate",evictLowestPriority:"evictLowestPriority",updateMetaLastEvent:"updateMetaLastEvent",ensureSession:"ensureSession",getSessionStats:"getSessionStats",getSessionRollup:"getSessionRollup",getMaxFileEdits:"getMaxFileEdits",getLatestCommitMessage:"getLatestCommitMessage",incrementCompactCount:"incrementCompactCount",getUsageCursor:"getUsageCursor",setUsageCursor:"setUsageCursor",upsertResume:"upsertResume",getResume:"getResume",markResumeConsumed:"markResumeConsumed",claimLatestUnconsumedResume:"claimLatestUnconsumedResume",deleteEvents:"deleteEvents",deleteMeta:"deleteMeta",deleteResume:"deleteResume",getOldSessions:"getOldSessions",searchEvents:"searchEvents",incrementToolCall:"incrementToolCall",getToolCallTotals:"getToolCallTotals",getToolCallByTool:"getToolCallByTool",getEventBytesSummary:"getEventBytesSummary"},xe=[["project_dir","TEXT NOT NULL DEFAULT ''"],["attribution_source","TEXT NOT NULL DEFAULT 'unknown'"],["attribution_confidence","REAL NOT NULL DEFAULT 0"],["bytes_avoided","INTEGER NOT NULL DEFAULT 0"],["bytes_returned","INTEGER NOT NULL DEFAULT 0"]];function te(r){let e=r.pragma("table_xinfo(session_events)"),t=new Set(e.map(s=>s.name)),n=!1;for(let[s,i]of xe)t.has(s)||(r.exec(`ALTER TABLE session_events ADD COLUMN ${s} ${i}`),n=!0);return n&&r.exec("CREATE INDEX IF NOT EXISTS idx_session_events_project ON session_events(session_id, project_dir)"),n}function et(r,e){let t=null;try{t=new e(r),te(t)}catch{}finally{try{t?.close()}catch{}}}var X=class extends N{constructor(e){super(e?.dbPath??k("session"))}stmt(e){return this.stmts.get(e)}initSchema(){try{let t=this.db.pragma("table_xinfo(session_events)").find(n=>n.name==="data_hash");t&&t.hidden!==0&&this.db.exec("DROP TABLE session_events")}catch{}this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        category TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 2,
        data TEXT NOT NULL,
        project_dir TEXT NOT NULL DEFAULT '',
        attribution_source TEXT NOT NULL DEFAULT 'unknown',
        attribution_confidence REAL NOT NULL DEFAULT 0,
        bytes_avoided INTEGER NOT NULL DEFAULT 0,
        bytes_returned INTEGER NOT NULL DEFAULT 0,
        source_hook TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        data_hash TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_events(session_id, type);
      CREATE INDEX IF NOT EXISTS idx_session_events_priority ON session_events(session_id, priority);

      CREATE TABLE IF NOT EXISTS session_meta (
        session_id TEXT PRIMARY KEY,
        project_dir TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_event_at TEXT,
        event_count INTEGER NOT NULL DEFAULT 0,
        compact_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS session_resume (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL UNIQUE,
        snapshot TEXT NOT NULL,
        event_count INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        consumed INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS tool_calls (
        session_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        calls INTEGER NOT NULL DEFAULT 0,
        bytes_returned INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (session_id, tool)
      );

      CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);

      CREATE TABLE IF NOT EXISTS shared_memory_deliveries (
        session_id TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        event_count INTEGER NOT NULL,
        PRIMARY KEY (session_id, delivery_id)
      );

      CREATE TABLE IF NOT EXISTS shared_memory_extraction (
        session_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL
      );
    `);try{te(this.db)}catch{}try{this.db.pragma("table_xinfo(session_meta)").some(t=>t.name==="usage_cursor")||this.db.exec("ALTER TABLE session_meta ADD COLUMN usage_cursor TEXT")}catch{}}prepareStatements(){this.stmts=new Map;let e=(t,n)=>{this.stmts.set(t,this.db.prepare(n))};e(o.insertEvent,`INSERT INTO session_events (
         session_id, type, category, priority, data,
         project_dir, attribution_source, attribution_confidence,
         bytes_avoided, bytes_returned,
         source_hook, data_hash
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),e(o.getEvents,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              bytes_avoided, bytes_returned,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? ORDER BY id ASC LIMIT ?`),e(o.getEventsByType,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              bytes_avoided, bytes_returned,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND type = ? ORDER BY id ASC LIMIT ?`),e(o.getEventsByPriority,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              bytes_avoided, bytes_returned,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND priority >= ? ORDER BY id ASC LIMIT ?`),e(o.getEventsByTypeAndPriority,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              bytes_avoided, bytes_returned,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND type = ? AND priority >= ? ORDER BY id ASC LIMIT ?`),e(o.getEventCount,"SELECT COUNT(*) AS cnt FROM session_events WHERE session_id = ?"),e(o.getLatestAttributedProject,`SELECT project_dir
       FROM session_events
       WHERE session_id = ? AND project_dir != ''
       ORDER BY id DESC
       LIMIT 1`),e(o.checkDuplicate,`SELECT 1 FROM (
         SELECT type, data_hash FROM session_events
         WHERE session_id = ? ORDER BY id DESC LIMIT ?
       ) AS recent
       WHERE recent.type = ? AND recent.data_hash = ?
       LIMIT 1`),e(o.evictLowestPriority,`DELETE FROM session_events WHERE id = (
         SELECT id FROM session_events WHERE session_id = ?
         ORDER BY priority ASC, id ASC LIMIT 1
       )`),e(o.updateMetaLastEvent,`UPDATE session_meta
       SET last_event_at = datetime('now'), event_count = event_count + 1
       WHERE session_id = ?`),e(o.ensureSession,"INSERT OR IGNORE INTO session_meta (session_id, project_dir) VALUES (?, ?)"),e(o.getSessionStats,`SELECT session_id, project_dir, started_at, last_event_at, event_count, compact_count
       FROM session_meta WHERE session_id = ?`),e(o.getSessionRollup,`SELECT
         COUNT(*) AS tool_calls,
         COALESCE(SUM(CASE WHEN category = 'error' THEN 1 ELSE 0 END), 0) AS errors,
         COUNT(DISTINCT type) AS unique_tools,
         COUNT(DISTINCT CASE WHEN category = 'file' THEN data END) AS unique_files,
         CASE WHEN SUM(CASE WHEN type = 'git_commit' THEN 1 ELSE 0 END) > 0 THEN 1 ELSE 0 END AS has_commit,
         CAST(COALESCE((MAX(strftime('%s', created_at)) - MIN(strftime('%s', created_at))) / 60.0, 0) AS INTEGER) AS duration_min,
         COALESCE(SUM(CASE WHEN type = 'external_ref' THEN 1 ELSE 0 END), 0) AS sources_indexed,
         CAST(COALESCE(SUM(bytes_avoided) / 1024.0, 0) AS INTEGER) AS total_chunks,
         COALESCE(SUM(CASE WHEN type IN ('file_search', 'file_glob') THEN 1 ELSE 0 END), 0) AS search_queries
       FROM session_events
       WHERE session_id = ?`),e(o.getMaxFileEdits,`SELECT COALESCE(MAX(c), 0) AS max_file_edits
       FROM (
         SELECT COUNT(*) AS c
         FROM session_events
         WHERE session_id = ? AND category = 'file' AND type IN ('file_edit', 'file_write')
         GROUP BY data
       )`),e(o.getLatestCommitMessage,`SELECT data
       FROM session_events
       WHERE session_id = ? AND type = 'git_commit'
       ORDER BY id DESC
       LIMIT 1`),e(o.incrementCompactCount,"UPDATE session_meta SET compact_count = compact_count + 1 WHERE session_id = ?"),e(o.getUsageCursor,"SELECT usage_cursor FROM session_meta WHERE session_id = ?"),e(o.setUsageCursor,"UPDATE session_meta SET usage_cursor = ? WHERE session_id = ?"),e(o.upsertResume,`INSERT INTO session_resume (session_id, snapshot, event_count)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         snapshot = excluded.snapshot,
         event_count = excluded.event_count,
         created_at = datetime('now'),
         consumed = 0`),e(o.getResume,"SELECT snapshot, event_count, consumed FROM session_resume WHERE session_id = ?"),e(o.markResumeConsumed,"UPDATE session_resume SET consumed = 1 WHERE session_id = ?"),e(o.claimLatestUnconsumedResume,`UPDATE session_resume
       SET consumed = 1
       WHERE id = (
         SELECT id FROM session_resume
         WHERE consumed = 0
           AND session_id != ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       )
       RETURNING session_id, snapshot`),e(o.deleteEvents,"DELETE FROM session_events WHERE session_id = ?"),e(o.deleteMeta,"DELETE FROM session_meta WHERE session_id = ?"),e(o.deleteResume,"DELETE FROM session_resume WHERE session_id = ?"),e(o.searchEvents,`SELECT id, session_id, category, type, data, created_at
       FROM session_events
       WHERE (project_dir = ? OR project_dir = '')
         AND (data LIKE '%' || ? || '%' ESCAPE '\\' OR category LIKE '%' || ? || '%' ESCAPE '\\')
         AND (? IS NULL OR category = ?)
       ORDER BY id ASC
       LIMIT ?`),e(o.getOldSessions,"SELECT session_id FROM session_meta WHERE started_at < datetime('now', ? || ' days')"),e(o.incrementToolCall,`INSERT INTO tool_calls (session_id, tool, calls, bytes_returned)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(session_id, tool) DO UPDATE SET
         calls = calls + 1,
         bytes_returned = bytes_returned + excluded.bytes_returned,
         updated_at = datetime('now')`),e(o.getToolCallTotals,`SELECT COALESCE(SUM(calls), 0) AS calls,
              COALESCE(SUM(bytes_returned), 0) AS bytes_returned
       FROM tool_calls WHERE session_id = ?`),e(o.getToolCallByTool,`SELECT tool, calls, bytes_returned
       FROM tool_calls WHERE session_id = ? ORDER BY calls DESC`),e(o.getEventBytesSummary,`SELECT COALESCE(SUM(bytes_avoided), 0) AS bytes_avoided,
              COALESCE(SUM(bytes_returned), 0) AS bytes_returned
       FROM session_events WHERE session_id = ?`)}insertEvent(e,t,n="PostToolUse",s,i){let a=R("sha256").update(t.data).digest("hex").slice(0,16).toUpperCase(),c=String(s?.projectDir??t.project_dir??this._getSessionProjectDir(e)).trim(),u=String(s?.source??t.attribution_source??"unknown"),g=Number(s?.confidence??t.attribution_confidence??0),m=Number.isFinite(g)?Math.max(0,Math.min(1,g)):0,f=D(i?.bytesAvoided),p=D(i?.bytesReturned),l=this.db.transaction(()=>{if(this.stmt(o.checkDuplicate).get(e,W,t.type,a))return;this.stmt(o.getEventCount).get(e).cnt>=V&&this.stmt(o.evictLowestPriority).run(e),this.stmt(o.insertEvent).run(e,t.type,t.category,t.priority,t.data,c,u,m,f,p,n,a),this.stmt(o.updateMetaLastEvent).run(e)});this.withRetry(()=>l())}bulkInsertEvents(e,t,n="PostToolUse",s,i){if(!t||t.length===0)return;if(t.length===1){this.insertEvent(e,t[0],n,s?.[0],i?.[0]);return}let a=this.prepareEventRows(e,t,s,i),c=this.db.transaction(()=>this.insertPreparedEvents(e,a,n));this.withRetry(()=>c())}prepareEventRows(e,t,n,s){return t.map((i,a)=>{let c=R("sha256").update(i.data).digest("hex").slice(0,16).toUpperCase(),u=n?.[a],g=String(u?.projectDir??i.project_dir??this._getSessionProjectDir(e)??"").trim(),m=g===""?"":_(g),f=String(u?.source??i.attribution_source??"unknown"),p=Number(u?.confidence??i.attribution_confidence??0),l=Number.isFinite(p)?Math.max(0,Math.min(1,p)):0,L=s?.[a],T=D(L?.bytesAvoided),re=D(L?.bytesReturned);return{event:i,dataHash:c,projectDir:m,attributionSource:f,attributionConfidence:l,bytesAvoided:T,bytesReturned:re}})}insertPreparedEvents(e,t,n,s=!0){if(t.length===0)return 0;let i=0,a=this.stmt(o.getEventCount).get(e).cnt;for(let c of t)s&&this.stmt(o.checkDuplicate).get(e,W,c.event.type,c.dataHash)||(a>=V?this.stmt(o.evictLowestPriority).run(e):a++,i+=this.stmt(o.insertEvent).run(e,c.event.type,c.event.category,c.event.priority,c.event.data,c.projectDir,c.attributionSource,c.attributionConfidence,c.bytesAvoided,c.bytesReturned,n,c.dataHash).changes);return this.stmt(o.updateMetaLastEvent).run(e),i}getSharedMemoryExtractionState(e){return this.db.prepare("SELECT state_json FROM shared_memory_extraction WHERE session_id = ?").get(e)?.state_json??null}applySharedMemoryDelivery(e){let{sessionId:t,deliveryId:n,fingerprint:s,maxDeliveries:i,events:a,sourceHook:c,workspaceDir:u,previousExtractionState:g,extractionState:m}=e;if(!t||!n||n.length>256||!/^[a-f0-9]{64}$/.test(s)||!Number.isSafeInteger(i)||i<1||i>1e5||typeof m!="string"||Buffer.byteLength(m)>32*1024)throw new Error("Invalid shared memory delivery");let f=this.prepareEventRows(t,a.map(l=>({...l,data_hash:""})),a.map(()=>({projectDir:u,source:"session_origin",confidence:1}))),p=this.db.transaction(()=>{if(this.getSessionStats(t)?.project_dir!==u)throw new Error("Invalid shared memory owner");let l=this.db.prepare("SELECT fingerprint, event_count FROM shared_memory_deliveries WHERE session_id = ? AND delivery_id = ?").get(t,n);if(l){if(l.fingerprint!==s)throw new Error("Conflicting shared memory delivery");return{duplicate:!0,events:l.event_count}}if(this.db.prepare("SELECT COUNT(*) AS count FROM shared_memory_deliveries WHERE session_id = ?").get(t).count>=i)throw new Error("Shared memory delivery capacity exceeded");if(this.getSharedMemoryExtractionState(t)!==g)throw new Error("Shared memory state changed; retry delivery");let T=this.insertPreparedEvents(t,f,c,!1);return this.db.prepare("INSERT INTO shared_memory_extraction (session_id, state_json) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET state_json = excluded.state_json").run(t,m),this.db.prepare("INSERT INTO shared_memory_deliveries (session_id, delivery_id, fingerprint, event_count) VALUES (?, ?, ?, ?)").run(t,n,s,T),{duplicate:!1,events:T}});return this.withRetry(()=>p())}getEvents(e,t){let n=t?.limit??1e3,s=t?.type,i=t?.minPriority;return s&&i!==void 0?this.stmt(o.getEventsByTypeAndPriority).all(e,s,i,n):s?this.stmt(o.getEventsByType).all(e,s,n):i!==void 0?this.stmt(o.getEventsByPriority).all(e,i,n):this.stmt(o.getEvents).all(e,n)}getEventCount(e){return this.stmt(o.getEventCount).get(e).cnt}getEventBytesSummary(e){let t=this.stmt(o.getEventBytesSummary).get(e);return{bytesAvoided:Number(t?.bytes_avoided??0),bytesReturned:Number(t?.bytes_returned??0)}}getLatestAttributedProjectDir(e){return this.stmt(o.getLatestAttributedProject).get(e)?.project_dir||null}_getSessionProjectDir(e){try{return this.db.prepare("SELECT project_dir FROM session_meta WHERE session_id = ?").get(e)?.project_dir||""}catch{return""}}searchEvents(e,t,n,s){try{let i=e.replace(/[%_]/g,c=>"\\"+c),a=s??null;return this.stmt(o.searchEvents).all(n,i,i,a,a,t)}catch{return[]}}getSessionIdsForProject(e){try{let t=_(e);return this.db.prepare(`SELECT DISTINCT session_id
             FROM session_events
            WHERE RTRIM(REPLACE(project_dir, '\\', '/'), '/') = ?`).all(t).map(s=>s.session_id)}catch{return[]}}ensureSession(e,t){this.stmt(o.ensureSession).run(e,t)}getSessionStats(e){return this.stmt(o.getSessionStats).get(e)??null}getSessionRollup(e){let t=this.stmt(o.getSessionRollup).get(e),n=this.stmt(o.getMaxFileEdits).get(e),s=this.stmt(o.getLatestCommitMessage).get(e),i=this.getSessionStats(e),a=(t?.tool_calls??0)>0?t?.unique_files??0:0,c=t?.errors??0,u=Math.min(a,c);return{tool_calls:t?.tool_calls??0,errors:t?.errors??0,unique_tools:t?.unique_tools??0,unique_files:t?.unique_files??0,max_file_edits:n?.max_file_edits??0,has_commit:t?.has_commit??0,commit_message:s?.data??"",edit_test_cycles:u,duration_min:t?.duration_min??0,compact_count:i?.compact_count??0,sources_indexed:t?.sources_indexed??0,total_chunks:t?.total_chunks??0,search_queries:t?.search_queries??0}}incrementCompactCount(e){this.stmt(o.incrementCompactCount).run(e)}getUsageCursor(e){return this.stmt(o.getUsageCursor).get(e)?.usage_cursor??null}setUsageCursor(e,t){this.stmt(o.setUsageCursor).run(t,e)}upsertResume(e,t,n){this.stmt(o.upsertResume).run(e,t,n??0)}getResume(e){return this.stmt(o.getResume).get(e)??null}markResumeConsumed(e){this.stmt(o.markResumeConsumed).run(e)}claimLatestUnconsumedResume(e){let t=this.stmt(o.claimLatestUnconsumedResume).get(e);return t?{sessionId:t.session_id,snapshot:t.snapshot}:null}getLatestSessionId(){try{return this.db.prepare("SELECT session_id FROM session_meta ORDER BY started_at DESC LIMIT 1").get()?.session_id??null}catch{return null}}incrementToolCall(e,t,n=0){let s=Number.isFinite(n)&&n>0?Math.round(n):0;try{this.stmt(o.incrementToolCall).run(e,t,s)}catch{}}getToolCallStats(e){try{let t=this.stmt(o.getToolCallTotals).get(e),n=this.stmt(o.getToolCallByTool).all(e),s={};for(let i of n)s[i.tool]={calls:i.calls,bytesReturned:i.bytes_returned};return{totalCalls:t?.calls??0,totalBytesReturned:t?.bytes_returned??0,byTool:s}}catch{return{totalCalls:0,totalBytesReturned:0,byTool:{}}}}deleteSession(e){this.db.transaction(()=>{this.stmt(o.deleteEvents).run(e),this.stmt(o.deleteResume).run(e),this.db.prepare("DELETE FROM shared_memory_deliveries WHERE session_id = ?").run(e),this.db.prepare("DELETE FROM shared_memory_extraction WHERE session_id = ?").run(e),this.stmt(o.deleteMeta).run(e)})()}cleanupOldSessions(e=7){let t=`-${e}`,n=this.stmt(o.getOldSessions).all(t);for(let{session_id:s}of n)this.deleteSession(s);return n.length}pruneOrphanedEvents(){let e=this.db.prepare("DELETE FROM session_events WHERE session_id NOT IN (SELECT session_id FROM session_meta)").run();return Number(e.changes??0)}};export{X as SessionDB,b as StorageDirectoryError,Qe as _resetWorktreeSuffixCacheForTests,te as applyMissingSessionEventsColumns,Ke as clearStorageDirectoryCheckCacheForTests,Ye as describeStorageDirectorySource,et as ensureSessionEventsSchema,ze as ensureWritableStorageDir,Ge as formatStorageDirectoryError,Ae as getWorktreeSuffix,ee as hashProjectDirCanonical,Z as hashProjectDirLegacy,_ as normalizeWorktreePath,$e as resolveContentStorageDir,Je as resolveContentStorePath,Xe as resolveDefaultSessionDir,Ze as resolveSessionDbPath,we as resolveSessionPath,z as resolveSessionStorageDir,qe as resolveStatsStorageDir};
