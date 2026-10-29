---
owner: svere
last-reviewed: 2026-10-27
stability: draft
---

# Shared service integration

This document describes the local shared service for adapter and lifecycle maintainers.
It records implemented interfaces; it does not establish an installed or released configuration.

## Ownership and transport

[The service composition](../src/shared/service.ts) shares the existing runtime, identity registry,
database handles and indexes. A launch capability binds provider, provider home and workspace.
Native root and child enrollment resolves a concrete memory owner within that scope. Child ownership
requires an enrolled root; tool completion requires the exact previously enrolled tool invocation.
Revocation, ambiguity and expiry invalidate dependent lookups. Memory registration does not grant MCP tools.

The loopback HTTP boundary checks Host/Origin, purpose-specific credentials, JSON content type,
body size and admission limits. Hook credentials are distinct from MCP credentials. Authentication is
rechecked after body delivery and immediately before memory processing. Callers cannot select a database
or supply an arbitrary resolved identity.

## Memory hook requests

POST ordinary native identity payloads to `/hooks` to retain the existing `202 {"registered":true}` contract.
An explicit `{"memory": nativePayload}` envelope selects memory processing. A successful memory request
returns HTTP 202 with one of these bodies:

| Event | Result |
| --- | --- |
| `SessionStart`, `SubagentStart` | `{"memory":{"status":"recovered","recovery":"..."}}` |
| `PreToolUse` | `{"memory":{"status":"registered"}}` |
| Qualified prompt or tool completion | `{"memory":{"status":"applied"}}` |
| Identical delivery replay | `{"memory":{"status":"duplicate"}}` |

Claude prompt delivery uses native `prompt_id`. Tool success and failure share a completion namespace
keyed by native `tool_use_id`; contradictory payloads conflict rather than write a second completion.
The service hashes delivery identifiers and uses the existing SQLite transaction for receipts, events
and extraction state. A retry after an indexing failure repairs search without duplicating events.

Codex `UserPromptSubmit` and `PostToolUseFailure` currently return `unsupported`. A body-supplied prompt ID
does not establish native occurrence identity. The bounded native diagnostics qualify root/resume history
IDs and visibility during Stop, but a production lifecycle adapter remains required.

Public errors expose fixed `code` values: `unauthorized` (401), `invalid` (400), `unsupported` (422),
`conflict` (409), `capacity` (429), `draining` (503), or `storage` (503). Oversized HTTP bodies retain 413.
Errors do not expose native payloads or storage messages.

## Managed command hook

[`hooks/shared-service.mjs`](../hooks/shared-service.mjs) is the command entry point for managed launches.
It is a short-lived HTTP client; it imports no database or legacy hook runtime. The launch owner supplies
these environment values in memory:

| Variable | Required value |
| --- | --- |
| `CONTEXT_MODE_SHARED_HOOK_URL` | `http://127.0.0.1:<port>/hooks` or IPv6 loopback equivalent |
| `CONTEXT_MODE_SHARED_HOOK_CAP` | The purpose-specific hook capability from launch issuance |
| `CONTEXT_MODE_SHARED_PROVIDER` | `claude-code` or `codex` |
| `CONTEXT_MODE_SHARED_MCP_SERVER` | The native MCP configuration key used by the service |

Do not persist capabilities in hook configuration or command arguments. The command reads one native
JSON envelope from stdin. It projects identity fields and only the content needed for that event; it never
opens transcript paths. Codex start events register callable identity before memory enrollment. Claude
PreToolUse events for this MCP server register callable identity before recording the tool observation.
Other tool observations cannot grant callable MCP authority.

The client admits native envelopes up to 16 MiB, then projects the event fields before enforcing the
64 KiB limit on each serialized request and response. Large PreToolUse inputs therefore do not consume
the registration budget. Every completion is checked against the service's canonical delivery budget,
including structured-response serialization and decoded JSON nodes, as well as the wire limit.
Oversized completion content uses the same recursive sanitizer as the service before retaining marked
excerpts (at most 8 KiB per text value, 32 KiB total encoded content, and 1024 projected nodes).
Keys, scalar values, containers and omission markers all consume that budget. File paths stay intact;
paths that cannot fit are refused. The full sanitized content digest distinguishes a changed omitted tail
from an identical retry. The digest describes content, not session authority; native identity resolution
still belongs to the service. Omitted completion text is not stored or recoverable from these excerpts.
The native sanitizer limits decoded depth to 16, nodes to 1,048,576, and decoded text and encoded output
to 16 MiB. Encoded JSON text is counted at its decoded leaves rather than at every enclosing string.
The service retains its 4096-node and 64 KiB limits. If retained JSON strings exceed those limits,
projection reduces text and node budgets deterministically. Its final pass marks even small encoded
JSON values as shortened text, preventing decoded-node expansion while preserving the full sanitized
digest. Quoted log assignments, including escaped quotes and `=>` separators, redact the entire value.
Unterminated private-key blocks and quoted secret values redact through EOF. This intentionally
discards trailing non-secret text when the secret's closing delimiter is missing or malformed.
Structurally excessive envelopes or projected requests still over 64 KiB fail before dispatch.
The projection module is built pure JavaScript and does not load an engine or database in the hook process.
A single ten-second deadline
covers input and both HTTP exchanges. Redirects are refused. Only exact successful receipts are accepted;
network failures and unsupported events return a fixed diagnostic and exit 1 without legacy fallback.
Recovery returns `hookSpecificOutput` with `hookEventName` and `additionalContext`. The shared service
budgets snapshots to 10,000 characters, retains complete XML sections where they fit, and replaces
oversized sections with search references. Details omitted from the inline snapshot remain in its
indexed session-events source. The client rejects an over-budget service response. This envelope follows the
[Claude hook contract](https://code.claude.com/docs/en/hooks#add-context-for-claude) and the pinned
[Codex 0.164.0 hook schema](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/hooks/src/schema.rs).
Native model consumption passed the Linux recovery qualifier with Claude Code 2.1.311 and Codex 0.164.0.

## Storage, privacy and shutdown

Prompt text, tool inputs and structured responses pass through the existing bounded sanitizer before
extraction. It recursively decodes JSON text, including nested string encodings and escaped keys, and
redacts values before serialization. Depth, node and byte limits apply to decoded values too. Delivery IDs
remain opaque. Error summaries remain within 200 characters and pass strict state validation after truncation.

Recovery resolves only the exact enrolled owner. Search includes stored MCP result events; the inline
resume snapshot intentionally selects a smaller set of event categories. Neither path uses a recent-session
fallback or consumes another owner's resume file.

Admitted memory work consumes the shared work limit. Disconnecting a client does not release its slot or
undo a committed transaction. Shutdown rejects new work, waits for admitted operations to settle, and then
closes storage. Clients retry using the same native occurrence identity after a lost response.

## Verification and remaining integration

[Real-service tests](../tests/integration/shared-memory-hooks.test.ts) exercise SQLite persistence, retries,
ownership, privacy, response loss, capacity and drain. [Native diagnostic instructions](
../tests/integration/native-identity-probe/README.md) describe the separate identity and timing probes.

The managed launcher still needs to select this command and replace legacy capture hooks without
duplicating them. The Linux native recovery qualifier passed ten flows, including separate conversation
resumptions and fresh-conversation exclusion after restart. It used synthetic seed events and does not
qualify native capture or installed lifecycle behavior. Codex child prompts,
same-turn steering, delivery retry, rollback and compaction need
additional native qualification. Service installation, supervision and platform resource gates remain
separate from these component tests.
