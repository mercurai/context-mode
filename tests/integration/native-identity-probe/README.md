# Native-client identity probe

The default diagnostic backend uses a synthetic loopback Streamable-HTTP MCP server (`server.mjs`) to record
native identity metadata. `run.mjs --backend production` instead uses the actual built `SharedService` through
`production.mjs`, with no diagnostic tools, proxy or production observation API.

- `node --test --test-concurrency=1 server.selftest.mjs barrier.selftest.mjs` — pure-node server and receipt checks. The
  command-exit check substitutes Node for Codex; it invokes no authenticated client or model.
- `node --test --test-concurrency=1 codex-hook-trust.selftest.mjs` — synthetic app-server protocol checks;
  only the admitted remote executor runs these tests.
- `node run.mjs --client codex --preflight-only` — qualifies only the two hook declarations through native
  app-server listings, with no model calls. This does not prove native hook execution.
- `node run.mjs --dry-run` — prints the planned client commands; starts nothing.
- `node run.mjs [--client claude|codex|all] [--hook-type http|command]` — runs the clients in the foreground, one
  after another. Each call is a real model turn with a one-line synthetic prompt.

## What it does and does not keep

Optional memory-hook diagnostics use `node run.mjs --memory-hooks --hook-type command` with the diagnostic
backend only. They reuse the existing prompts and client invocations. Codex preflight verifies six exact
hook declarations; Claude additionally observes `PostToolUseFailure` when emitted. These diagnostics never
write to the production memory store. Memory-hook collection alone does not read native history.

Add `--codex-prompt-ids` to qualify native prompt occurrence IDs using the existing Codex `root-A` and
`resume-A` invocations, for example `node run.mjs --client codex --memory-hooks --hook-type command
--codex-prompt-ids --codex-bin <pinned-reviewed-codex>`. This option requires the diagnostic backend,
command hooks, memory collection and Codex (`--client codex` or `all`). It adds no model turns and reads only
the two synthetic turns resolved by the existing trusted registry. The reader uses the same binary,
provider home, workspace and reviewed hook configuration as those invocations.

The root phase reads metadata once and the root turn twice. After resume, the reader checks metadata again,
rereads the old turn once and reads the new turn twice. Reads require paginated history; legacy history fails
qualification. Each phase has a 30-second monotonic deadline including child cleanup, at most four pages per
snapshot and 256 KiB per RPC. At most one reader child runs at a time (seven children for one-page snapshots,
twenty-two maximum). IDs and content stay transient; the `codexPromptIds` receipt contains fixed booleans,
counts or a failure code. Failed or missing qualification makes `passed` false and exits nonzero. Child
prompts, same-turn steering, retries, rollback, compaction and recovery consumption remain unqualified.
`--dry-run` still prints only the existing plan; `--preflight-only` still performs only hook preflight and
makes no prompt qualification claim. This diagnostic does not authorize production history ingestion.

Add `--codex-prompt-stop` alongside `--codex-prompt-ids` to also read those turns while servicing their
native Stop hooks. Before reading, the server requires a bound root MCP call from the current invocation
and matching hook scope, workspace and turn. One Stop reader may run at a time. Its eight-second budget
starts at HTTP request arrival and includes body delivery, RPCs and owned-child cleanup; it fits inside
the existing ten-second collector timeout. Shutdown waits for admitted reader cleanup. Disconnect,
revocation, deadline failure or a different final native root prevents qualification.

This mode adds the same bounded history snapshots during Stop, with no additional model turns. The
`codexPromptStop` receipt contains fixed status/counts and a qualification boolean; it must qualify for
the overall receipt to pass. This tests history visibility during Stop, not client consumption of recovered
memory. Default, dry-run and preflight behavior remain unchanged.

The existing `/hook` endpoint accepts a separate projected observation envelope under a per-invocation
capability. That capability cannot register an identity or call MCP. Original start/tool registrations retain
their existing authority. The runner allows at most fourteen configured flows and two active capabilities,
revokes each in `finally`, and resolves observations against existing registrations and bound MCP calls using
the root ID already returned by that native invocation. Unknown owners fail collection.

Raw hook input is limited to 64 KiB and discarded after projection; no prompt/tool content or transcript paths
are forwarded. At most 512 observations and 512 correlation identities remain in process memory. Final summary,
failure and shutdown discard observations. The optional `memory` receipt contains only fixed fields, counts,
booleans and failure codes. `passed` still describes identity checks; failed or incomplete memory collection
also causes a nonzero exit. A complete collection is not proof that every memory capability is supported:
Codex hook turn IDs do not qualify as prompt occurrence IDs, and zero observations never qualify a capability.
Fixture tests establish wiring behavior; installed native hook execution requires a separate admitted run.

The capability is generated in memory and reaches only the clients' environment (`PROBE_CAP`); the config files in
the temporary directory hold `${PROBE_CAP}` references, never the value. Real session/thread/tool-use ids stay in
memory. The receipt has versions, metadata key names, aliased identities (`u1`, `s1`, `c1`), booleans and counts.
It is not evidence about Windows-native clients.

The runner exits with status 1 when any required flow is missing, fails, times out, lacks current-call identity
evidence, or produces the wrong call count. A single selected client must provide six flows and seven bound calls.
All-client mode additionally requires a mixed Claude/Codex pair: seven flows and eight bound calls per client.
Unselected clients do not affect the result. Client output is limited to 1 MiB and never included in the
receipt. Timeout and output-limit cleanup target the owned Unix process group, or the live owned Windows child
tree; Windows containment still requires native qualification.

The concurrency barrier holds the first authenticated tool response until a distinct client request arrives while
the first remains open. Both calls receive the same barrier alias and verified-overlap flag. Duplicate identities,
the wrong provider, a disconnect, cancellation or expiry cannot produce overlap proof. The receipt checks both
same-provider pairs and the mixed pair in all-client mode. Version commands have a five-second deadline and 4 KiB
output limit; failures produce a classified result rather than hanging receipt creation.

## Identity rules qualified on Linux

- The launcher gives each provider a distinct in-memory capability bound to its existing canonical home and the
  exact workspace. It explicitly supplies that same home through `CODEX_HOME` or `CLAUDE_CONFIG_DIR`. Hook bodies
  and tool arguments cannot select or change the authenticated scope.
- Codex: synchronous `SessionStart` and `SubagentStart` command hooks register concrete thread, root lineage and
  cwd before calls are accepted. `_meta.threadId` and `_meta.sessionId` must match that registration. Conflicting
  registrations become unusable; an unknown thread or mismatched workspace is rejected.
- Claude: `_meta["claudecode/toolUseId"]` is resolved only through a `PreToolUse` hook that registered
  `tool_use_id -> session_id[, agent_id]` first in that authenticated scope and exact workspace.
- Anything else, including identity placed in tool arguments, is rejected before the tool runs.
- The Node command collector `hook.mjs` forwards only native identity and cwd fields to the authenticated loopback
  endpoint. It omits prompt, transcript and tool-input fields. The legacy capability-only server mode is retained
  for synthetic observation tests; `run.mjs` always enables mandatory binding and checks every call's proof.

## Qualified Linux rerun, 2026-10-26

The root executor's fresh `/tmp/shared-mcp-native-trusted-live.json` receipt passed with Claude Code 2.1.311,
Codex 0.164.0 and Node 24.13. All 16 calls were bound, none were unbound, and all 16 hook registrations matched
the exact launch cwd. Both providers passed distinct roots, resume identity on a new connection, concrete child
lineage and binding to each flow's own native identity. Both same-provider barriers and the mixed-provider
barrier proved overlapping requests. Missing-auth and unregistered-call negative checks passed.

Codex's two reviewed start hooks passed the native trust preflight before model calls. This qualifies the Linux
diagnostic launch/hook/MCP correlation path; it does not establish production authority, native-origin protection
against code that can read hook credentials, or Windows behavior. The production launch authority and lifecycle
integration remain separate work.

## Historical Linux observation, 2026-10-26 — superseded by qualified rerun

Clients: Claude Code 2.1.310; codex-cli 0.164.0 from a task-owned npm prefix (the host's own `codex` is 0.162.1 and
was not used or upgraded). The original run reported distinct sessions, stable resumed identities and child
lineage. Its receipt gate did not reject incomplete evidence, and its concurrent check accepted previously seen
aliases. Those historical observations do not establish acceptance; rerun with the corrected gate before making
native-client proof claims.

Reported metadata observations (capability observation only):
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

At the time of that historical run, unverified: binding the exact workspace and the home for Codex (its tool-call metadata carries
none; a Codex hook and the launch scope are needed), Codex hook inputs, the Windows-native clients, and a client
that omits `_meta`. The original command supplied no Codex hooks. `--ignore-user-config` does not suppress explicit
CLI hook overrides: the pinned [Codex config loader](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/config/src/loader/mod.rs)
adds the SessionFlags layer separately from the suppressed user layer.

## Codex hook trust preflight — Linux native qualification passed

Codex 0.164.0 also requires approval of unmanaged hook declarations. Before any model call, the preflight uses native
`hooks/list` to obtain the exact reviewed `SessionStart` and `SubagentStart` collector keys and hashes, supplies
only those two entries through an in-memory `hooks.state` CLI table, and requires a second unchanged listing
with both hooks `Trusted` before any model run. It never approves unrelated hooks, computes its own native hash,
writes trust into the user's home, or enables a trust bypass. Keys, hashes and listing output stay in memory;
the receipt exposes only status and counts. Protocol/output/deadline failures prevent qualification.
Both listing subprocesses have a 15-second deadline and a combined stdout/stderr limit of 1 MiB; cleanup waits
for the owned process to close, with a separate five-second cleanup deadline that fails qualification
if closure remains unconfirmed. The same qualified CLI config is supplied to fresh, resumed and concurrent
Codex calls. Preflight failures do not start model calls.

The listing subprocess uses the same explicit `-c` declarations, cwd and existing home as the intended model
launch. Pinned standalone `app-server` uses default loader layers and does **not** support exec's
`--ignore-user-config` or `--ignore-rules`; this is not identical effective configuration. Exact SessionFlags
source/command validation and the subsequent native bound-call probe remain required. A successful listing
alone does not establish hook execution or identity binding.

Pinned protocol sources: [hook metadata](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server-protocol/schema/typescript/v2/HookMetadata.ts),
[listing parameters](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server-protocol/schema/typescript/v2/HooksListParams.ts),
[trust-state loading](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/hooks/src/config_rules.rs),
and [CLI app-server startup](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/cli/src/main.rs#L1243).

## Production native runner: offline corrections verified

### Production recovery consumption — qualified on Linux

`production-recovery.mjs --client claude|codex|all --codex-bin <pinned-reviewed-codex>
--claude-bin <pinned-reviewed-claude>` uses the actual built shared service and
[`hooks/shared-service.mjs`](../../../hooks/shared-service.mjs). Run only after host admission,
source review and the offline tests; it makes five sequential native invocations per selected provider.
It reuses the selected authenticated provider home without modifying its global configuration.

For each provider, two initial conversations call the real `ctx_stats` tool to establish native identity.
The test then seeds a unique synthetic file observation into each exact memory owner through the production
hook client. No file is created, and the random basename is absent from the native prompt and conversation.
After restarting the service and issuing fresh capabilities, the test resumes each exact conversation.
The model must return only its recovered basename without tool activity. A fresh conversation must return
`none`. Wrong answers, tool activity, foreign clues, incomplete native output and unconfirmed cleanup fail
qualification. Native output and identifiers stay transient; the receipt exposes fixed fields and counts.

On 2026-10-28, the qualifier passed all ten flows with Claude Code 2.1.311 and Codex 0.164.0
against the built production service. Both providers passed fresh-conversation exclusion and two
exact-conversation resumptions after restart, without tool activity during recovery answers.
The fixed receipt reported both Codex hook trust checks successful and cleanup confirmed
(`/tmp/shared-mcp-native-recovery-live.json` on the verification host).
The selected provider homes retain their normal native conversation records and task-scoped
context-mode databases. Removing the temporary workspace does not remove those stores; this
qualifier does not claim profile cleanup or zero disk residue.

This qualifies recovery consumption only. Synthetic seed events do not prove native prompt or tool capture.
Child recovery, compaction, concurrent recovery and Windows behavior require their own acceptance evidence.
The test configuration suppresses ambient configuration for isolation; it is not a managed launcher and
does not prove preservation of the user's policy hooks. The real launcher must preserve those hooks while
replacing only the legacy context-mode capture path.

The built-service adapter and runner passed the first 121 offline cases on Linux. Independent review
then identified four corrections: require exact broad-search arguments, bound cleanup when descendants
keep pipes open, select the completed `ctx_stats` id for the restart negative check, and require a
successful terminal Agent/Task result. Focused remote RED ran 61 cases: 47 passed and 14 failed.
After the fixes, the full remote offline regression passed 137 cases with no failures or skips
(`/tmp/shared-mcp-native-corrections-green.log`).

Cleanup has a separate five-second deadline and reports unconfirmed ownership rather than accepting a
retained response when inherited pipes remain open. No production native qualification has run. The
historical diagnostic barrier result does not establish production execution overlap or Windows behavior.

The new offline tests require real native tool-result envelopes for `ctx_index`, `ctx_search` and `ctx_stats`.
Final assistant prose and supplied success booleans cannot satisfy marker visibility checks. Production hooks
must use `/hooks` and their separate `PROBE_HOOK_CAP`; MCP configuration references `PROBE_MCP_CAP` through
the environment. Config files and argv never contain either capability value.

Claude's [documented streaming output](https://code.claude.com/docs/en/headless#stream-subagent-output)
forwards subagent tool events with `parent_tool_use_id`. Codex's pinned
[exec notification filter](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/exec/src/lib.rs#L1645)
only forwards primary-thread items. Its child proof therefore requires a bounded read-only
[`thread/read`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server-protocol/schema/typescript/v2/ThreadReadParams.ts)
for the exact child id returned by this run's completed spawn event, using the same operational home,
explicit config and cwd. The response must identify that child, its native parent and exact workspace,
with complete turn items. No latest-session fallback or final-message substitution is allowed.
Native ids, histories, tool arguments and content remain in memory; receipts retain only aliases,
allowlisted counts and observed visibility checks.

Production mode creates two temporary canonical workspace directories per provider, while retaining the
existing authenticated provider home and the actual OS user home. Each provider performs eight native CLI
invocations: two root conversations, exact-session resume, a second workspace, one parent/child check,
an isolation recheck after both providers have indexed content, restart/resume, and a fresh conversation.
The parent/child check launches exactly one real subagent. The receipt counts native invocations separately;
internal model request counts are unknown once native execution begins.

Each successful storage flow requires actual completed index/search/stats results (search/stats only for
resume). A common search with limit 20 checks the expected marker and excludes other synthetic markers in
the returned content. Both providers' markers exist before the cross-provider recheck. New process aliases
establish separate native launches for resume; the service does not expose transport ids to this runner.
The second-workspace check uses temporary directories, not managed Git worktrees.

Service-object restart in the same Node process rejects both old capability purposes, rejects cross-purpose credentials, and rejects an actual SDK
tool call under a fresh but unregistered launch. Native resume must then register again and retrieve the
old marker without indexing it. This is not a process-crash test or active-client credential refresh.
The runner never synthesizes a successful hook registration. Synthetic
context-mode stores persist under the actual provider home for these unique workspaces; operational data,
authentication and global configuration are not edited or deleted. Only owned temporary configuration and
workspace directories are removed.

`passed` applies only to the stated `native-index-search-stats` qualification. Deterministic production
execution overlap remains explicitly pending, along with native managed-worktree and Windows qualification.
`--preflight-only` checks native hook trust without model calls or storage flows; it cannot qualify identity.

Remote offline command after the normal package build and fleet admission (no native model clients):

```bash
node --test --test-concurrency=1 tests/integration/native-identity-probe/*.selftest.mjs
```

Native commands require a separate admitted remote run and explicit live GO:

```bash
node tests/integration/native-identity-probe/run.mjs --backend production --dry-run
node tests/integration/native-identity-probe/run.mjs --backend production --client codex --preflight-only
node tests/integration/native-identity-probe/run.mjs --backend production --client all --hook-type command
```
