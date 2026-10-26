# Native-client identity probe

Diagnostic, not production. A synthetic loopback Streamable-HTTP MCP server (`server.mjs`) records which trusted
identity metadata the installed native Claude Code and Codex clients send on `tools/call`, and `run.mjs` drives
the clients against it.

- `node --test server.selftest.mjs` — pure-node checks of the server (no client, no dependency).
- `node run.mjs --dry-run` — prints the planned client commands; starts nothing.
- `node run.mjs [--client claude|codex|all] [--hook-type http|command]` — runs the clients in the foreground, one
  after another. Each call is a real model turn with a one-line synthetic prompt.

## What it does and does not keep

The capability is generated in memory and reaches only the clients' environment (`PROBE_CAP`); the config files in
the temporary directory hold `${PROBE_CAP}` references, never the value. Real session/thread/tool-use ids stay in
memory. The receipt has versions, metadata key names, aliased identities (`u1`, `s1`, `c1`), booleans and counts.
It is not evidence about Windows-native clients.

## Identity rules the server applies (proposed, being qualified)

- Codex: `_meta.threadId` is the isolation key; `_meta.sessionId` is the lineage. `threadId == sessionId` reads as
  root, otherwise child.
- Claude: `_meta["claudecode/toolUseId"]` is resolved only through a `PreToolUse` hook that registered
  `tool_use_id -> session_id[, agent_id]` first. Present `agent_id` reads as child.
- Anything else, including identity placed in tool arguments, is rejected before the tool runs.

## Qualified on Linux (ServerOne), 2026-10-26 — Windows-native not covered

Clients: Claude Code 2.1.310; codex-cli 0.164.0 from a task-owned npm prefix (the host's own `codex` is 0.162.1 and
was not used or upgraded). Both legs: 2 sessions distinct, resume keeps the identity on a new connection, 2
concurrent roots distinct, every call bound to the id the client itself reported, root/child lineage correct,
tool-argument identity ignored, unauthenticated and unbound calls rejected before the tool.

Verified:
- Claude sends `_meta["claudecode/toolUseId"]` (plus `progressToken`) and nothing session-shaped. A `PreToolUse`
  HTTP hook registered `tool_use_id -> session_id[, agent_id]` before the call; hook input keys: `agent_id`
  (child only), `agent_type`, `cwd` (equal to the launch directory on 7 of 7), `session_id`, `tool_use_id`,
  `tool_name`, `mcp_server`, `transcript_path`, `permission_mode`, `prompt_id`, `effort`, `tool_input`,
  `hook_event_name`. `${PROBE_CAP}` expands in `--mcp-config` headers and `$PROBE_CAP` in the hook headers
  (`allowedEnvVars`); `--resume` keeps the session id.
- Codex 0.164.0 sends `_meta.threadId` and `_meta.sessionId` (plus `callId`, `itemId`, `windowId`,
  `progressToken`, `x-codex-turn-metadata`); a child thread has its own `threadId` and the root's `sessionId`.
  Turn metadata keys: `thread_id`, `session_id`, `parent_thread_id`, `forked_from_thread_id`, `thread_source`,
  `subagent_kind`, `turn_id`, `sandbox`, `sandbox_mode`, `model`, `codex_version`, and others. No workspace or
  cwd value was present in the tool-call metadata (0 of 7).

Not verified, so proposed only: binding the exact workspace and the home for Codex (its tool-call metadata carries
none; a Codex hook or the launch scope is needed), Codex hook inputs (`--ignore-user-config` disabled them here),
the Windows-native clients, and a client that omits `_meta`.
