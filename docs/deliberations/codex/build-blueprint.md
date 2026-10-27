# Proposed implementation blueprint

Research only. Every change described here is a proposal, not applied code.

## Ownership

Samaritan owns delegated tasks, domain approvals, execution receipts, cross-service artifacts and delivery preferences. A chosen agent runtime owns its internal conversation/tool loop and exposes session/run identifiers. Thornhill owns physical device jobs and locks. Nutgraf owns newsletter ingestion, ranking and audio. Source apps remain authoritative for their own records.

Exactly one component owns each timer. With the initial SDK approach, Samaritan owns schedules; if OpenClaw/Hermes becomes the adopted scheduler, import the schedules there and stop corresponding legacy triggers. Do not let Claude desktop tasks, launchd cron wrappers and a new runtime all trigger the same meeting flow.

## Proposed records

Extend SQLite with forward-only migrations. Do not rebuild the existing Action Item tables.

| Record | Minimal fields and purpose |
|---|---|
| delegated_tasks | ID, goal, domain/account scope, origin, state, current revision, parent task, created/updated timestamps. |
| task_messages | Task ID, role, content/artifact references, client request ID; supports user follow-ups and clarifications. |
| runs | Task/capability ID, attempt, runner and remote session/run ID, lease owner/expiry, fencing generation, status, budget, actual usage, start/heartbeat/end. |
| run_events | Monotonic cursor, run/task IDs, event type, timestamp and small redacted payload. Include failure, no-op and cancellation events. |
| artifacts | Stable ID, task/run IDs, kind, relative path or source URL, media type, content hash/version, sensitivity and retention. |
| questions | Task/run IDs, prompt/options, revision, open/answered/expired status and authenticated responder. |
| approvals | Action ID, exact payload hash/revision, provider/account/operation, expiry and authenticated approver. |
| schedule_receipts | Trigger ID, scheduled occurrence, source event/version and admitted run ID; a unique key prevents duplicate admission. |
| source_events / cursors | Provider/account/resource identity, provider version, observed time, processing status and resumable sync cursor. |
| outbox | Notification destination, logical delivery ID, visibility class, retry policy and delivery receipt. |

Task states could be queued, running, needs_input, awaiting_review, succeeded, failed, cancelled and interrupted. `cancel_requested` is a command/transition before cancellation is verified. A run that produced a review item can succeed while the task waits for review. Preserve that distinction.

## Worker boundary

One small interface: `start(task, context)`, `events(cursor)`, `answer(question, revision)`, `cancel(run)`, `status(run)`. Persist remote IDs before relying on callbacks. Fetch runner capabilities at startup; unsupported resume/cancel must be visible rather than emulated with a success badge.

The initial SDK worker should receive scoped read tools, approved source material, a per-run working directory inside the eventual runtime artifact root, and tools to propose actions. It should not receive unrestricted mail/calendar write credentials. Deterministic capability functions can continue using the current RunContext, extended with cancellation and run IDs.

For OpenClaw/Hermes, map their native sessions, progress, approvals and terminal states into the same records. Do not assume an OpenAI-compatible text endpoint exposes the full task lifecycle. Hermes documents a separate run API and richer JSON-RPC requests; OpenClaw's generic tools endpoint is trusted operator access, so its broad token should not be handed to untrusted workers. Sources: [Hermes integration protocols](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration), [Hermes API server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server), [OpenClaw tools API](https://docs.openclaw.ai/gateway/tools-invoke-http-api).

## Recovery and execution

- Admit work durably before acknowledging submission. Use stable source/event or client idempotency keys.
- Claim runs with leases and a fencing generation. A restarted or cancelled worker must lose permission to emit accepted results or invoke writes, even if its process continues.
- Use child processes for potentially stuck capabilities; cooperative AbortSignal alone cannot stop arbitrary code. Record whether termination was verified. Cancellation cannot undo an already completed provider action.
- Approvals bind to exact action versions, recipient/account and payload. Changed drafts, rescheduled meetings and expired reviews need revalidation.
- Claim an approved execution once. Use provider idempotency IDs/check-or-create when available. If a write times out after possible commit, enter an unknown outcome and reconcile with the provider before retrying.
- On boot, reconcile old running/approved/staged attempts, parked questions, overdue triggers and unsent outbox items. A missed morning brief should be skipped or refreshed according to a time window, not sent days late.
- Drain Telegram's existing delivery queue. Keep delivery retry separate from rerunning the agent that generated the notification.

A local append-only SQLite table is useful audit protection against accidental application mutations. It is not tamper-proof against code with filesystem/database access. A capability imported into the same Node process can bypass a registry and make its own HTTP call. Security therefore depends on scoped credentials and process/tool boundaries as well as policy code.

## Memory and artifacts

| Data | Authority | How assistants access it |
|---|---|---|
| Delegated tasks, approvals, run/activity history | Samaritan SQLite | MCP/API, scoped by domain/account. |
| Personal notes and journal | Existing Obsidian vault/project journals | Indexed search with path and source citations. |
| Existing formal decisions, projects, people | Their current Notion records where already used | Structured adapter; avoid creating a rival canonical vault copy. |
| Calendar, mail, personal to-dos | Existing provider | Provider IDs, selected metadata and retrieval; no fictional completed writes. |
| Generated briefs, PRDs, meeting drafts, audio references | Stable artifact store plus ledger | Artifact ID resolving to current version/path or source URL. |
| Embeddings, summaries, retrieved snippets | Derived cache | Rebuildable, access-filtered, with provenance, timestamps and deletion handling. |

For the eventual implementation, choose an artifact root outside the Git source tree, for example `~/.samaritan/artifacts/<task-id>/`, and export curated summaries into the vault. This is a proposed path only; nothing there is created by this research. Keep raw work transcripts, bills and health data out of public Git history. Preserve source deletion and scope changes when indexing.

Do not start with a knowledge graph or a replacement vector database. Finish the existing Recall indexer/query path and expose structured lookups plus FTS; add semantic fusion where it improves actual retrieval. Apply access/domain filters before retrieval and synthesis.

## Make the assistants aware

Publish a short canonical context document describing Samaritan's role, tool names, artifact resolution and domain boundaries. Keep it about routing and capabilities, not the contents of your entire life. Expose a small MCP facade, initially about six tools: get_context, search, read_artifact, submit_task, task_status and propose_action. Continued conversation can be an operation on the task interface or a later explicit tool.

Add client-specific pointers during implementation:

- Codex: user-level `~/.codex/AGENTS.md` for cross-project discovery, plus project-scoped guidance as needed; register the MCP server in supported config.
- Claude Code: user-level `~/.claude/CLAUDE.md` referencing the canonical document; register the same MCP service. Existing project rules continue to govern each repository.
- Gemini CLI: `~/.gemini/GEMINI.md` and its MCP settings. Verify with a fresh session.
- ChatGPT desktop/local Work: supported local MCP configuration can expose a local service. ChatGPT web requires an installed reachable MCP plugin/tunnel with appropriate authentication. A path in local instructions is not automatically available to a hosted chat.
- Gemini native/web app and Claude Cowork: verify the exact client's connection and file/tool behavior separately. CLI support does not establish native-app support; the Thornhill Cowork failure is a concrete reason to test.

Do not automatically grant assistant clients the human approval capability. An assistant can submit a proposal; final authorization should come from a separately authenticated user action. Derive the actor from that authenticated session, never a model-supplied `actor: sandip` field.

Official client sources: [OpenAI instruction discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md), [OpenAI MCP configuration and cloud/local distinctions](https://learn.chatgpt.com/docs/extend/mcp), [custom MCP plugin](https://developers.openai.com/api/docs/guides/custom-mcp-server), [Claude context](https://code.claude.com/docs/en/memory), [Gemini context](https://geminicli.com/docs/cli/gemini-md/), [Gemini MCP](https://geminicli.com/docs/tools/mcp-server/).

## Hosting and daily operation

Start on the existing Mac with one launchd-supervised service, restart backoff, explicit environment, local database backups and a restoration check. FileVault, reboot login and Keychain availability must be tested: a process configured to restart is not proof it can access secrets before login. Separate rig health from model-provider health.

Use authenticated HTTPS web access on the tailnet. Tailscale can carry private traffic, but an exposed approval API still needs application authority checks and browser protections. Cloud chat clients cannot simply resolve your private tailnet address; later use a supported MCP tunnel or authenticated public front door. Do not expose raw WDA/mobile-mcp.

Show last source sync, next scheduled run, current run state and disconnected-device state. An outside availability check can detect the home Mac disappearing once that matters. Keep personal and employer data in separate account scopes, with appropriate workspace policy; a unified UI need not imply unrestricted retrieval across both.

## Verification worth doing during implementation

Use end-to-end failure scenarios, not tests that only echo schemas: duplicate meeting events; reschedule after draft; notes absent; approval from two surfaces; stale approval; provider timeout after commit; worker timeout followed by late emit; Mac restart during a run; revoked source access; expired sync token; and quiet-hour delivery across restart. The user should see an honest state and recovery path for each.
