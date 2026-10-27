# Samaritan Command Centre: Exhaustive Engineering Specification

**Source Authority:** `docs/deliberations/consensus/PROPOSAL-v1.md`, `docs/deliberations/consensus/PROPOSAL.md`, `docs/deliberations/consensus/deliberation-map.html`, and `docs/deliberations/codex/build-blueprint.md`.
**Target Repository:** `devsandip/samaritan-os` (`/Users/sandipdev/Developer/samaritan`)

---

## 1. Executive Summary and Architectural Direction

Samaritan is the single personal agentic OS, planner, task ledger, approval inbox, and Telegram bot across laptop, phone (Tailscale HTTPS / PWA), and assistant clients (`Claude Code`, `Claude Desktop`, `Cowork`, `Codex`, `Gemini CLI`, and hosted web clients).

We do not adopt OpenClaw or Hermes as the core operating system, and we do not rewrite from scratch. Samaritan v0 already provides the governance foundation that external frameworks lack:
1. Schema-driven `ActionItem` rendering (`card`, `form`, `document`, `diff`).
2. Fail-closed `expr-eval` Policy Engine (`confidence`, `value_threshold`, `reversibility`).
3. Three-place hardcoded money lock (`financial_transaction` is never `automated`).
4. Graceful degradation from `automated` to `assisted` to `guided` when an adapter or credential is missing.
5. Append-only SQLite audit triggers on `action_item_events` paired transactionally with `transition()`.

This specification defines the complete engineering build required to transform Samaritan v0 into the always-on Command Centre described in `PROPOSAL-v1.md`, organized into five phases (Phases 0 through 4) and 25 discrete engineering work items (`P0-1` through `P4-4`).

---

## 2. Codebase Audit and Baseline State

### 2.1 Existing Foundation (Samaritan v0)
- **Database (`src/store/`):** `node:sqlite` (`DatabaseSync`) with WAL mode, `busy_timeout = 5000`, `foreign_keys = ON`, and forward-only migrations (`migrations.ts`). Migrations 1 through 7 define `capabilities`, `triggers`, `action_items`, `action_item_events`, `executions`, `routing_overrides`, `connections`, `sync_cursors`, `delivery_queue`, `recall_chunks`, `recall_chunks_fts`, `recall_sources`, `seen_events`, and `poll_state`.
- **Action Center (`src/action-center/index.ts`):** `ingest()`, `respond()`, `batchRespond()`, `confirm()`, `reopen()`, `expire()`, `resurface()`, and boot-time `reconcile()`.
- **Execution Registry (`src/execution/`):** `guided.fallback`, `obsidian.note.create`, `obsidian.note.append`, `notion.decision.create`, `notion.insight.create`, `notion.person.upsert`, `notion.project.update`, `ticktick.task.create`, and `pm-os.item.file`.
- **Scheduler and Event Bus (`src/scheduler/`, `src/events/`):** In-process cron evaluator (`Scheduler`), deduplicated `EventBus` (`seen_events`), `VaultWatcher` (`chokidar`), `GmailPoller`, and Fireflies HMAC webhook (`src/api/webhooks.ts`).
- **Recall (`src/recall/`):** Local embeddings (`Xenova/all-MiniLM-L6-v2`), `sqlite-vec` kNN + FTS5 BM25 retrieval fused via Reciprocal Rank Fusion (RRF), and optional Anthropic synthesis with citation verification.

### 2.2 Defects Identified in Deliberation Audit (`G2`)
1. **Unflushed quiet-hours queue:** `TelegramDelivery.flush()` in `src/delivery/index.ts` had no caller in production (`sweep()` only called `expire()` and `resurface()`).
2. **Non-cancelling run timeout:** `withTimeout()` in `src/run-layer/index.ts` used `Promise.race()` without `AbortController` or child-process termination (`SIGTERM` -> `SIGKILL`), allowing timed-out or cancelled runs to continue emitting items.
3. **UTC date bug in Obsidian daily note path:** `dailyNotePath()` in `src/execution/adapters/obsidian.ts` used `toISOString().slice(0, 10)` (UTC) instead of local calendar date (`Asia/Kolkata`), filing early-morning IST notes into the previous day.
4. **Request-supplied actor:** `/api/actions/:id/respond`, `/api/actions/batch`, `/api/actions/:id/confirm`, and `/api/actions/:id/reopen` trusted `request.body.actor` instead of deriving `actor: "sandip"` from the authenticated server session.
5. **Unbound approvals:** Approvals did not verify `expected_payload_hash` or `expected_revision`, creating a race if two surfaces (phone web and Telegram) acted on a mutated item simultaneously.
6. **Restart mid-run stranding:** Runs and tasks active during a daemon crash remained `running` forever on reboot.
7. **Mute vs Pause conflation:** No per-source rule table existed to separate delivery muting/snoozing from capability execution pausing.
8. **Unauthenticated non-loopback requests:** Exposing the server over Tailscale required a real bearer/cookie authentication check (`web:token` in macOS Keychain).

---

## 3. Data Model Specification (Migrations 8 and 9)

### 3.1 Migration 8 (`command_centre_schema`)
Adds the four core operational tables plus `source_rules` and exact-revision approval columns:
- `tasks`:
  - `id TEXT PRIMARY KEY`
  - `goal TEXT NOT NULL`
  - `lane TEXT NOT NULL DEFAULT 'general'` (`general | coding | research | operations`)
  - `status TEXT NOT NULL` (`queued | running | needs_input | awaiting_review | succeeded | failed | cancelled | interrupted`)
  - `revision INTEGER NOT NULL DEFAULT 1`
  - `runner TEXT NOT NULL DEFAULT 'worker'`
  - `parent_task_id TEXT REFERENCES tasks(id)`
  - `result_summary TEXT`
  - `created_at TEXT NOT NULL`, `updated_at TEXT NOT NULL`
- `runs`:
  - `id TEXT PRIMARY KEY`
  - `task_id TEXT REFERENCES tasks(id)`
  - `capability_id TEXT`
  - `runner TEXT NOT NULL` (`in-process | child-process | worker`)
  - `remote_run_id TEXT`
  - `admission_key TEXT UNIQUE`
  - `lease_token TEXT`, `lease_expires_at TEXT`
  - `fencing_generation INTEGER NOT NULL DEFAULT 1`
  - `status TEXT NOT NULL` (`running | succeeded | failed | timeout | cancelled | interrupted | skipped`)
  - `cost_usd REAL NOT NULL DEFAULT 0`
  - `started_at TEXT NOT NULL`, `heartbeat_at TEXT NOT NULL`, `ended_at TEXT`, `error TEXT`
- `artifacts`:
  - `id TEXT PRIMARY KEY`
  - `task_id TEXT REFERENCES tasks(id)`, `run_id TEXT REFERENCES runs(id)`
  - `kind TEXT NOT NULL` (`file | diff | url | transcript | brief`)
  - `path_or_url TEXT NOT NULL`, `content_hash TEXT NOT NULL`, `media_type TEXT NOT NULL DEFAULT 'text/markdown'`, `created_at TEXT NOT NULL`
- `activity_events`:
  - `cursor INTEGER PRIMARY KEY AUTOINCREMENT`
  - `id TEXT UNIQUE NOT NULL`
  - `task_id TEXT REFERENCES tasks(id)`, `run_id TEXT REFERENCES runs(id)`, `capability_id TEXT`
  - `type TEXT NOT NULL` (`task.submitted | run.started | tool.called | artifact.created | question.asked | question.answered | action.proposed | run.completed | run.failed | run.cancelled | run.interrupted | hook.received`)
  - `payload_json TEXT NOT NULL`, `created_at TEXT NOT NULL`
  - Guarded by `BEFORE UPDATE` and `BEFORE DELETE` triggers raising `ABORT`.
- `source_rules`:
  - `source_id TEXT PRIMARY KEY`, `muted INTEGER NOT NULL DEFAULT 0`, `snoozed_until TEXT`, `paused INTEGER NOT NULL DEFAULT 0`, `updated_at TEXT NOT NULL`
- `action_items` additions:
  - `task_id TEXT`, `run_id TEXT`, `payload_hash TEXT`, `revision INTEGER NOT NULL DEFAULT 1`
- `delivery_queue` additions:
  - `dedupe_key TEXT` with unique index `idx_delivery_queue_dedupe`.

### 3.2 Migration 9 (`command_centre_phase_extensions`)
Completes the `PROPOSAL-v1.md` and `build-blueprint.md` data model requirements for `scheduled_for`, `input_hash` (skip unchanged inputs), `delivery_queue.channel`, work/personal `scope` separation, and database backup metadata:
- `ALTER TABLE runs ADD COLUMN scheduled_for TEXT;`
- `ALTER TABLE runs ADD COLUMN input_hash TEXT;`
- `CREATE INDEX idx_runs_input_hash ON runs(capability_id, input_hash, status);`
- `ALTER TABLE delivery_queue ADD COLUMN channel TEXT NOT NULL DEFAULT 'telegram';`
- `ALTER TABLE tasks ADD COLUMN scope TEXT NOT NULL DEFAULT 'work';` (`work | personal`)
- `ALTER TABLE action_items ADD COLUMN scope TEXT NOT NULL DEFAULT 'work';` (`work | personal`)
- `ALTER TABLE recall_chunks ADD COLUMN scope TEXT NOT NULL DEFAULT 'work';` (`work | personal`)
- `CREATE TABLE calendar_events (...)`: persisted Google Calendar events table (`id`, `title`, `starts_at`, `ends_at`, `attendees`, `status`, `prep_emitted`, `nudge_emitted`, `last_synced_at`) so `CalendarPoller` survives restarts without re-emitting pre-meeting briefs or post-meeting nudges, and detects rescheduled `starts_at` timestamps.
- `CREATE TABLE db_backups (id TEXT PRIMARY KEY, backup_path TEXT NOT NULL, size_bytes INTEGER NOT NULL, integrity_ok INTEGER NOT NULL, created_at TEXT NOT NULL);`

---

## 4. Exhaustive Work Breakdown Structure (25 Items Across Phases 0 to 4)

### Phase 0: Safe Daemon, Storage, G2 Fixes, Hosting & Billing (`D6`, `D9`, `G2`, `C2`)

#### Item P0-1: SQLite Migrations 8 & 9 (`tasks`, `runs`, `artifacts`, `activity_events`, `source_rules`, `calendar_events`, `scope`, `input_hash`)
- **Files:** `src/store/migrations.ts`, `src/types/task.ts`, `src/types/action-item.ts`, `src/store/tasks.ts`, `src/store/runs.ts`, `src/store/source-rules.ts`
- **Requirements:**
  - Create `tasks`, `runs` (with `admission_key`, `scheduled_for`, `input_hash`, `lease_token`, `fencing_generation`, `cost_usd`), `artifacts`, append-only `activity_events`, `source_rules`, `calendar_events`, and `db_backups`.
  - Add `task_id`, `run_id`, `payload_hash`, `revision`, and `scope` to `action_items`.
  - Add `dedupe_key` and `channel` to `delivery_queue`.
- **Acceptance Criteria:**
  - Updating or deleting a row in `activity_events` aborts via SQLite trigger.
  - Duplicate `admission_key` in `runs` returns `{ admitted: false, run }` without starting a second run.

#### Item P0-2: G2 Run Layer Cancellation, Lease Fencing, Obsidian Local Date & Delivery Flush
- **Files:** `src/run-layer/index.ts`, `src/execution/adapters/obsidian.ts`, `src/delivery/index.ts`, `src/api/server.ts`
- **Requirements:**
  - Pass `AbortSignal` into capabilities, support child-process execution (`SIGTERM` then `SIGKILL` after grace period), and increment `fencing_generation` / clear `lease_token` on cancel or timeout so a late `ctx.emit()` throws `StaleLeaseError`.
  - Fix `dailyNotePath(date)` in `src/execution/adapters/obsidian.ts` to format `YYYY-MM-DD` using local calendar date methods (`getFullYear()`, `getMonth() + 1`, `getDate()`).
  - Call `await app.delivery.flush()` inside `sweep(app)` in `src/api/server.ts`, deduplicate `delivery_queue` by `(item.id, item.revision)`, and respect `isSourceDeliverySilenced(db, item.capability_id)`.
- **Acceptance Criteria:**
  - A timed-out or cancelled run cannot ingest Action Items after cancellation.
  - `dailyNotePath(new Date("2026-10-23T01:00:00+05:30"))` resolves to `2026-10-23.md` in IST.
  - Quiet-hours queued notifications flush on the first `sweep()` after quiet hours end.

#### Item P0-3: Server-Derived Actor, Exact-Payload-Hash Approval Binding & Boot Reconciliation
- **Files:** `src/action-center/index.ts`, `src/store/action-items.ts`, `src/store/runs.ts`, `src/api/server.ts`
- **Requirements:**
  - Compute `payload_hash = sha256(canonicalJson(execution_plan ?? payload))` on ingest and bump `revision` whenever `edited_payload` or re-ingest mutates the item.
  - Reject `respond()` and `confirm()` with HTTP `409` (`stale_approval`) if `expected_payload_hash` or `expected_revision` mismatches current state.
  - Ignore client-supplied `actor` on human review routes (`/api/actions/:id/respond`, `/api/actions/batch`, `/api/actions/:id/confirm`, `/api/actions/:id/reopen`), always attributing to `"sandip"`.
  - Require Bearer or `samaritan_session` cookie matching Keychain `web:token` for non-loopback requests.
  - On boot (`actionCenter.reconcile()`), transition any stranded `running` runs and tasks to `interrupted` and append `run.interrupted` events.
- **Acceptance Criteria:**
  - Concurrent or stale approval with an outdated `expected_payload_hash` or `expected_revision` fails with `409 stale_approval`.
  - Rebooting mid-run marks the stranded run and task `interrupted` before `/healthz` opens.

#### Item P0-4: Launchd Supervision (`caffeinate`), SQLite Online Backups & Pre-Login Keychain Health Check (`D6`)
- **Files:** `src/cli/plist.ts`, `src/cli/install-daemon.ts`, `src/store/backup.ts`, `src/cli/backup-db.ts`, `src/api/server.ts`, `package.json`
- **Requirements:**
  - Update `renderPlist()` in `src/cli/plist.ts` with an option (`preventSleep?: boolean`, default `true`) that wraps the daemon under `/usr/bin/caffeinate -dis` so macOS does not sleep while the daemon runs on AC power.
  - Implement `src/store/backup.ts` (`backupDatabase(db, backupDir)`): uses SQLite `VACUUM INTO` to create an atomic online snapshot in `~/.samaritan/backups/samaritan-YYYY-MM-DD-HHMMSS.db`, opens the snapshot read-only to verify `PRAGMA integrity_check`, records a row in `db_backups`, and prunes backups older than `retainCount` (default 14).
  - Add CLI script `src/cli/backup-db.ts` (`pnpm backup`) and daily automatic backup during daemon sweep.
  - Add `GET /api/system/health` and `POST /api/system/backup`: reports Keychain accessibility before/after login (`probeKeychainAccess()`), database schema version, latest backup status, monthly spend vs budget cap, and per-source freshness/outage state.
- **Acceptance Criteria:**
  - `backupDatabase()` produces a verified SQLite snapshot and records `integrity_ok = 1` in `db_backups`.
  - `renderPlist()` includes `/usr/bin/caffeinate -dis` by default.

#### Item P0-5: C2 Billing Guardrails, Monthly Spend Cap & Unchanged-Input Skipping (`C2`)
- **Files:** `src/run-layer/billing.ts`, `src/run-layer/index.ts`, `src/config/index.ts`, `src/store/runs.ts`
- **Requirements:**
  - Add `billing` block to `ConfigSchema` (`monthly_cap_usd: default 25`, `per_run_cap_usd: default 2`, `skip_unchanged_inputs: default true`).
  - Implement `computeInputHash(inputs)` and `checkBillingAllowance(db, config)`: calculates month-to-date `SUM(cost_usd)` from `runs`; if MTD spend >= `monthly_cap_usd`, blocks unattended model-backed runs with `budget_exceeded`.
  - When `skipIfUnchanged` is enabled on a capability run and the most recent succeeded run for that `capability_id` had the identical `input_hash`, record a `skipped` run with `cost_usd = 0` and skip execution.
  - Also support schedule time-window staleness (`max_staleness_minutes` on manifest trigger): if `Scheduler.reconcile()` catches up a missed trigger that is older than `max_staleness_minutes`, skip it rather than sending a morning brief at 2pm.
- **Acceptance Criteria:**
  - Unchanged inputs with `skipIfUnchanged: true` produce a `skipped` run and do not re-invoke the capability.
  - Exceeding `monthly_cap_usd` halts unattended paid runs and logs a `budget_exceeded` event.

---

### Phase 1: First Workflow (Meetings Context, Notes, Follow-Up Tasks) & Coding Hooks (`D5`, `D7`, `D10 Phase 1`)

#### Item P1-1: Google Calendar Incremental Sync (`syncToken`), Reschedule Handling & Post-Meeting Nudge
- **Files:** `src/events/listeners/calendar-sync.ts`, `capabilities/meeting-prep/manifest.yaml`, `capabilities/meeting-prep/index.ts`, `capabilities/meeting/manifest.yaml`
- **Requirements:**
  - Poll Google Calendar Events API using incremental `syncToken` persisted in `sync_cursors` (`source = 'google_calendar'`), falling back to full sync on HTTP `410 Gone`.
  - Persist events in `calendar_events`. Detect reschedules when `starts_at` changes for an existing `event_id`: reset `prep_emitted = 0`, supersede any pending `meeting-prep-brief` for that `event_id`, and emit `calendar.meeting_rescheduled`.
  - Emit `calendar.meeting_upcoming` 15 minutes before `starts_at` -> triggers `meeting-prep`, which queries Recall over the vault, Notion, and recent mail to build a cited pre-meeting brief.
  - Emit `calendar.meeting_ended` when `ends_at <= now` -> emits a post-meeting nudge (`meeting-notes-nudge` in Inbox + outbound Telegram alert) prompting Sandip to paste notes or wait for transcript.
- **Acceptance Criteria:**
  - Five meetings (including one reschedule and one with no notes) process without duplicate briefs or duplicate tasks.

#### Item P1-2: Multi-Source Meeting Notes Intake (Web UI, Telegram, Fireflies GraphQL Consumer, Granola)
- **Files:** `capabilities/meeting/index.ts`, `capabilities/meeting/manifest.yaml`, `src/events/listeners/fireflies-client.ts`, `src/api/server.ts`, `src/delivery/telegram-inbound.ts`
- **Requirements:**
  - Support four intake paths into `meeting`:
    1. Pasted notes in Web UI (`POST /api/meetings/notes`).
    2. Telegram note message (`/note <topic>: <notes>` or `/meeting <topic> | <notes>`).
    3. Fireflies webhook (`POST /api/webhooks/fireflies` -> `meeting.transcribed`): when `transcript` is not inline on the event payload, `meeting` calls `fetchFirefliesTranscript(meetingId)` against `https://api.fireflies.ai/graphql` using Keychain secret `fireflies:api`.
    4. Granola notes/transcript endpoint (`POST /api/meetings/granola`): normalizes Granola document markdown + transcript segments into `meeting` inputs.
  - Write reversible meeting minutes directly to `Areas/Meetings/YYYY-MM-DD - <topic>.md` in the Obsidian vault and stage extracted `decision`, `task`, `insight`, and `person` items in the Action Center.
- **Acceptance Criteria:**
  - `meeting.transcribed` with only a `meeting_id` fetches the transcript via the injected/configured Fireflies GraphQL client and extracts reviewable items.
  - `POST /api/meetings/granola` files the meeting note in the vault and stages extracted items in the Inbox.

#### Item P1-3: TickTick Open API v1 Execution Adapter with Provider Receipt & Tag Sanitization
- **Files:** `src/execution/adapters/ticktick.ts`, `test/command-centre.test.ts`
- **Requirements:**
  - Strip `#word` hashtags (`sanitizeTickTickText`) from all task titles and descriptions (`~/AGENTS.md` universal rule).
  - Degrade to `guided` staging when `config.ticktick.enabled` is false or Keychain `ticktick:<account>` is absent.
  - When enabled and configured, `POST https://api.ticktick.com/open/v1/task`, verify that the JSON response contains a non-empty provider `id` receipt, and return `status: "completed"` with the receipt. If the request times out after possible commit, record `unknown_outcome` details for reconciliation.
- **Acceptance Criteria:**
  - `#73` and `issue #19` in task titles are sanitized to `73` and `issue 19`.
  - Missing provider receipt `id` fails closed instead of claiming automated completion.

#### Item P1-4: Coding-Agent Waiting Alerts (`Claude Code`, `Codex CLI`, `Gemini CLI` HTTP Hooks)
- **Files:** `src/events/listeners/coding-agent-hook.ts`, `capabilities/coding-agent/manifest.yaml`, `capabilities/coding-agent/index.ts`, `~/.claude/settings.json`
- **Requirements:**
  - Normalize `POST /api/hooks/coding-agent` payloads from:
    - Claude Code: `Notification` (`permission_prompt`, `idle_prompt`, `agent_needs_input`), `Stop`, `SessionEnd`.
    - Codex CLI: `PermissionRequest`, `Stop`.
    - Gemini CLI: `Notification` (`ToolPermission`), `AfterAgent`.
  - Waiting hooks emit a high-priority `coding-agent-waiting` card in the Inbox (`dedupe_key: coding-wait:<session_id>`) with a link to Claude Remote Control / terminal session.
  - Completion hooks (`Stop`, `SessionEnd`, `AfterAgent`) automatically transition any pending waiting card for that `session_id` to `dismissed` so stale alerts never linger.
- **Acceptance Criteria:**
  - A `permission_prompt` hook creates a `pending` Inbox card; a subsequent `Stop` hook for the same `session_id` dismisses it automatically.

---

### Phase 2: Agent SDK Worker, Command Centre UI, Telegram Inbound & Cross-Assistant MCP (`D1` to `D5`)

#### Item P2-1: 5-Method `WorkerAdapter` with Child-Process Isolation & Rule-of-Two Enforcement (`D1`, `D9`)
- **Files:** `src/worker/index.ts`, `src/worker/child-worker.ts`, `capabilities/worker-task/manifest.yaml`, `capabilities/worker-task/index.ts`
- **Requirements:**
  - Implement `WorkerAdapter` (`start`, `events`, `answer`, `cancel`, `status`).
  - Provide both the deterministic in-process executor (for fast unit tests) and `createChildProcessWorkerExecutor()` in `src/worker/child-worker.ts` which spawns a separate Node child process (`fork` / `spawn`) with:
    - `cwd` confined to `~/.samaritan/artifacts/<task-id>/`,
    - Environment stripped of all external write/send credentials (`NOTION_*`, `GMAIL_*`, `TICKTICK_*`, `TELEGRAM_*`),
    - IPC protocol for `recall`, `writeArtifact`, `askQuestion`, `proposeAction`, and `recordToolCall`,
    - Hard `SIGTERM` -> `SIGKILL` termination on `cancel()`.
  - Enforce `resolveTaskArtifactPath` so workers cannot write outside `~/.samaritan/artifacts/<task-id>/`.
- **Acceptance Criteria:**
  - Child-process worker executes a task in a separate PID, writes an artifact inside `<artifactsRoot>/<taskId>`, and is killed immediately when `worker.cancel(task.id)` is called.

#### Item P2-2: Command Centre React UI (`Now`, `Inbox`, `Tasks`, `Activity`, `Settings` + Global Ask/Delegate Bar) (`D2`)
- **Files:** `ui/src/App.tsx`, `ui/src/components/Sidebar.tsx`, `ui/src/components/CommandBar.tsx`, `ui/src/views/Dashboard.tsx`, `ui/src/views/Inbox.tsx`, `ui/src/views/Tasks.tsx`, `ui/src/views/Activity.tsx`, `ui/src/views/Settings.tsx`, `ui/src/styles.css`, `ui/public/manifest.webmanifest`
- **Requirements:**
  - Navigation destinations matching `PROPOSAL-v1.md` `D2`:
    1. **Now** (`/`): Today's meetings, what needs you (priority inbox preview), what is running (active tasks & runs), and source freshness / outage banner.
    2. **Inbox** (`/inbox`): Unchanged full review surface with batch-approve, lane filters (`all`, `pending`, `awaiting_confirmation`, `deferred`, `completed`), and schema-driven detail pane.
    3. **Tasks** (`/tasks`): Cowork-style task composer, lane selector, live thread of `activity_events`, inline clarification answer box (`needs_input`), and registered artifact viewer.
    4. **Activity** (`/activity`): Unified feed across every capability and coding-agent session with cursor pagination and working `Stop` button (`/api/runs/:id/cancel`).
    5. **Settings** (`/settings`): Per-source notification switchboard (`Mute` delivery, `Snooze 2h`, `Pause` execution), source sync health, DB backup trigger, and execution routing table.
  - Persistent **Ask / Delegate Command Bar** (`ui/src/components/CommandBar.tsx`) rendered on every view (`Ask Recall` returns cited answers; `Delegate Task` submits a background worker task).
- **Acceptance Criteria:**
  - All 5 views (`Now`, `Inbox`, `Tasks`, `Activity`, `Settings`) and the persistent Ask/Delegate bar build cleanly (`pnpm build:ui`) and work on both desktop and mobile viewports.

#### Item P2-3: Cross-Assistant `samaritan` MCP Server (8 Tools, Scope Filtering, Static Pointers) (`D4`)
- **Files:** `src/mcp/index.ts`, `src/cli/mcp.ts`, `docs/SAMARITAN_MCP.md`, `~/Documents/Obsidian/Samaritan/SAMARITAN_MCP.md`, `~/AGENTS.md`
- **Requirements:**
  - Expose exactly 8 tools over stdio (`pnpm mcp`) and HTTP (`POST /api/mcp`):
    1. `get_context`
    2. `search` (supports `scope?: "work" | "personal" | "all"`)
    3. `read_artifact`
    4. `list_inbox` (supports `scope?: "work" | "personal"`)
    5. `propose_action`
    6. `submit_task`
    7. `task_status`
    8. `answer_question` (clarifications on `task-question` items only; never approves external writes)
  - Zero approval tools (`approve_action` or `samaritan_act` must not exist).
  - Static routing doc in `~/Documents/Obsidian/Samaritan/SAMARITAN_MCP.md` referenced from `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, and `~/.gemini/GEMINI.md`.
- **Acceptance Criteria:**
  - `MCP_TOOLS` has 8 tools, none of which can transition an Action Item to `approved` (except answering a `task-question` clarification).
  - `search` and `list_inbox` filter by `scope` when supplied.

#### Item P2-4: Bidirectional Telegram Bot (Approve, Edit, Snooze, Mute, Capture, Tasks, Answers, Screenshots) (`D5`)
- **Files:** `src/delivery/telegram-inbound.ts`, `src/delivery/index.ts`, `src/api/server.ts`
- **Requirements:**
  - Verify `chat.id` against `config.delivery.telegram.chat_id`.
  - Support inline callback queries:
    - `approve:<id>:<rev>:<hashPrefix>` -> `actionCenter.respond()` with server-derived `actor: "sandip"` and hash/revision verification.
    - `edit:<id>` -> prompts for edited text or applies inline `edit:<id>:<field>:<value>` patch and keeps item in review / approves.
    - `snooze:<id>:<minutes>` -> defers item for `minutes`.
    - `mute:<sourceId>` -> sets `muted = true` on `source_rules` (silencing delivery without pausing runs).
  - Support text commands:
    - `/task <goal>` -> submits a delegated worker task.
    - `/answer <task_id> <text>` -> answers a `needs_input` task question.
    - `/note <text>` -> fires `note.created` (or `meeting` if prefixed with `/meeting <topic> | <notes>`).
  - Support photo/screenshot messages (`message.photo` / `message.document`): publishes `screenshot.received` on the Event Bus to trigger `calendar-from-screenshot`.
- **Acceptance Criteria:**
  - Authorized Telegram callbacks (`approve`, `edit`, `snooze`, `mute`) and commands (`/task`, `/answer`, `/note`, `/meeting`, photo) execute and record `actor: "sandip"`.

---

### Phase 3: Domain Capabilities & Adapters (`D7`, `D10 Phase 3` & Consensus Map Gaps)

#### Item P3-1: `morning-plan` Capability + Undated-Backlog Nudges + Post-Workout & Office-Arrival Webhooks
- **Files:** `capabilities/morning-plan/manifest.yaml`, `capabilities/morning-plan/index.ts`, `src/api/webhooks.ts`, `src/events/types.ts`
- **Requirements:**
  - Triggered by cron (`0 8 * * *`, `max_staleness_minutes: 180`), `hevy.workout_completed` (`POST /api/webhooks/hevy`), or `location.office_arrived` (`POST /api/webhooks/arrival` from iOS Shortcut).
  - Synthesizes today's meetings (`calendar_events`), pending inbox items, and active tasks into:
    1. `morning-day-plan` (or `first-hour-focus` top 3-5 tasks when triggered by `location.office_arrived`), appended to today's Obsidian daily note.
    2. `backlog-due-date-nudge` (`assisted` via `ticktick.task.create`) for any backlog tasks that have no due date assigned.
- **Acceptance Criteria:**
  - Posting to `/api/webhooks/arrival` or running `morning-plan` produces the prioritized focus plan and flags undated backlog tasks for review.

#### Item P3-2: `gmail.draft.create` Assisted Execution Adapter (MailMCP / Gmail API)
- **Files:** `src/execution/adapters/gmail.ts`, `src/execution/adapters/index.ts`, `capabilities/email-triage/manifest.yaml`
- **Requirements:**
  - Register `gmail.draft.create` in `src/execution/adapters/index.ts` with `mode: "assisted"`.
  - Never send email automatically (`PROPOSAL-v1.md` `D7`: "Email: MailMCP or Gmail API, read and draft only. Never send automatically").
  - When `config.gmail.enabled` and Keychain `gmail:<account>` token exist, create a Gmail draft via `POST https://gmail.googleapis.com/gmail/v1/users/me/drafts` with RFC 2822 base64url-encoded message (`To`, `Subject`, `In-Reply-To`, body) and return `status: "staged"` with `guided_link: "https://mail.google.com/mail/u/0/#drafts/<draftId>"` so Sandip reviews and sends in Gmail. When unconfigured, stage with a `mailto:` deep link and copyable body.
- **Acceptance Criteria:**
  - `email-triage` items resolve to `effective_mode: "assisted"` (instead of degrading to `guided` for missing adapter) and stage a Gmail draft via `gmail.draft.create`.

#### Item P3-3: `job-scout` Capability (Job Matches, Recruiter Reply Drafts & Interview Prep)
- **Files:** `capabilities/job-scout/manifest.yaml`, `capabilities/job-scout/index.ts`
- **Requirements:**
  - Evaluates job-alert emails, recruiter threads, and pasted job descriptions against Sandip's PM profile criteria (role seniority, domain fit, compensation/location signals; reuses `job_tracker` scoring & deduplication structure; no LinkedIn scraping).
  - Emits three action item types:
    1. `job-match-review` (`notion.insight.create`): files high-fit roles with fit score and rationale.
    2. `recruiter-reply-draft` (`gmail.draft.create`): stages a tailored reply draft for recruiter outreach.
    3. `interview-prep-brief` (`obsidian.note.append`): triggered when an interview event is detected in calendar or recruiter email, generating a cited prep brief in the vault (Consensus Gap 2).
- **Acceptance Criteria:**
  - Running `job-scout` with job-alert, recruiter, and interview inputs emits scored job matches, a recruiter draft, and an interview prep brief.

#### Item P3-4: `posthog-pulse` Capability (Product Health Metrics & Baseline Comparison)
- **Files:** `capabilities/posthog-pulse/manifest.yaml`, `capabilities/posthog-pulse/index.ts`, `src/config/index.ts`
- **Requirements:**
  - Queries fixed, reviewed PostHog metrics via PostHog Query API (`POST https://app.posthog.com/api/projects/:id/query` using Keychain `posthog:api`) or evaluates supplied metric snapshots.
  - Compares current metric values against baselines, distinguishes `null`/missing data from `0`, and emits `posthog-health-pulse` (`card` layout) when anomalies occur or on scheduled digest.
- **Acceptance Criteria:**
  - Missing data is flagged as `data_missing` rather than a zero-value drop; anomalous metrics emit a review card with baseline delta.

#### Item P3-5: `wbr-journal` Capability & Multi-Repo `~/Developer/*/journal/` Watcher
- **Files:** `capabilities/wbr-journal/manifest.yaml`, `capabilities/wbr-journal/index.ts`, `src/api/server.ts`
- **Requirements:**
  - Extend `VaultWatcher` roots in `src/api/server.ts` (or scan `config.paths.journals`) to read `~/Developer/*/journal/INDEX.md` and recent `entries/*.md`.
  - Synthesizes a Friday Weekly Business Review (`wbr-document-review`, `layout: document`, execution target `obsidian.note.create` into `Areas/Weekly/YYYY-Www-WBR.md`) citing exact repo journal entries (`Decisions`, `Direction changes`, `Needs revisit`) without inventing metrics not present in the journals.
- **Acceptance Criteria:**
  - Running `wbr-journal` over repo journals produces a cited WBR document item that writes to `Areas/Weekly/` on approval.

#### Item P3-6: `nutgraf-brief` Capability & Nutgraf Machine-Credential Route
- **Files:** `capabilities/nutgraf-brief/manifest.yaml`, `capabilities/nutgraf-brief/index.ts`, `src/config/index.ts`
- **Requirements:**
  - Fetches ranked unread newsletter summaries from Nutgraf (`GET <nutgraf.url>/summary` with `Authorization: Bearer <Keychain nutgraf:machine>` or `x-nutgraf-machine-token`, falling back to supplied summary payload).
  - Emits `nutgraf-commute-brief` (`card` layout) with top ranked stories, deep link to `https://sandip.dev/nutgraf/`, and audio link when available (never generating TTS inside Samaritan per `Not doing`).
- **Acceptance Criteria:**
  - `nutgraf-brief` authenticates with the machine credential header and surfaces ranked stories + deep link.

#### Item P3-7: `bill-watch` Capability (Bank, Card & Statement Emails -> Guided Payment Reminders)
- **Files:** `capabilities/bill-watch/manifest.yaml`, `capabilities/bill-watch/index.ts`
- **Requirements:**
  - Parses invoice, credit card statement, utility bill, and bank alert emails.
  - Extracts payee, amount, currency (`INR` / `USD`), due date, account identifier, and due-date certainty.
  - Emits `bill-payment-reminder` items with `execution.mode: "guided"` and `financial_transaction: true` so the 3-place money lock guarantees payment always stays a human action.
- **Acceptance Criteria:**
  - Bill emails produce deduplicated guided payment reminders with extracted amount and due date, and cannot be set to `automated` execution.

#### Item P3-8: `health-coach` Capability (Oura V2 + Hevy Routine Copy Adapter)
- **Files:** `capabilities/health-coach/manifest.yaml`, `capabilities/health-coach/index.ts`, `src/execution/adapters/hevy.ts`, `src/execution/adapters/index.ts`
- **Requirements:**
  - Reads Oura V2 `daily_sleep`, `daily_readiness`, and `daily_stress` summaries (via `https://api.ouraring.com/v2/usercollection/*` with Keychain `oura:default` or input snapshot).
  - Applies recovery coaching rules (reusing `healthAI` readiness thresholds: readiness < 70 scales volume down 20% and swaps heavy compounds; readiness >= 85 keeps progressive overload) and emits `hevy-routine-adjustment` (`layout: diff`).
  - Register `hevy.routine.copy` adapter in `src/execution/adapters/hevy.ts`: on approval, calls `POST https://api.hevyapp.com/v1/routines` (with `api-key` from Keychain `hevy:default`) to create a dated copy of today's routine (`<Title> - Samaritan YYYY-MM-DD`), never overwriting the original routine plan (`PROPOSAL-v1.md` `D7`). Degrades to `guided` when unconfigured.
- **Acceptance Criteria:**
  - Low Oura readiness proposes a diff-layout workout adjustment; approving calls `hevy.routine.copy` (`POST /v1/routines`) and never overwrites the base routine.

#### Item P3-9: `imessage-digest` Capability & Read-Only Mac `chat.db` Reader
- **Files:** `capabilities/imessage-digest/manifest.yaml`, `capabilities/imessage-digest/index.ts`, `src/events/listeners/imessage-reader.ts`
- **Requirements:**
  - Reads recent messages from `~/Library/Messages/chat.db` using `node:sqlite` in read-only mode (`{ readOnly: true }`) when enabled and Full Disk Access is available (or accepts message snapshots in tests/inputs).
  - Enforces Rule-of-Two quarantine (no write/send tools) and filters for direct questions, scheduling requests, or urgent family/personal threads (`scope: "personal"`).
  - Emits `imessage-digest-review` (`execution.mode: "guided"`) with `sms://` / `imessage://` deep links for manual reply.
- **Acceptance Criteria:**
  - High-signal iMessage threads emit `personal`-scoped guided digest cards; broadcast/OTP noise is ignored.

#### Item P3-10: `calendar-from-screenshot` (`scrask-bot`) & `prd-review` Capabilities + `calendar.event.create` Adapter
- **Files:** `src/execution/adapters/calendar.ts`, `capabilities/calendar-from-screenshot/manifest.yaml`, `capabilities/calendar-from-screenshot/index.ts`, `capabilities/prd-review/manifest.yaml`, `capabilities/prd-review/index.ts`
- **Requirements:**
  - Register `calendar.event.create` (`assisted` mode) in `src/execution/adapters/calendar.ts`: checks Google Calendar conflicts before creating a hold or event (`POST .../calendars/primary/events`), degrading to a Google Calendar prefilled template link when unconfigured.
  - `calendar-from-screenshot` (Consensus Gap 1): accepts `scrask-bot` vision extraction JSON or raw screenshot text/metadata, checks for timezone/date ambiguity and calendar conflicts, and stages a `calendar-hold-proposal` in the Inbox.
  - `prd-review` (Consensus Gap 7): takes a feature brief or draft PRD path, queries Recall for related product decisions and architecture docs, writes a versioned artifact in `~/.samaritan/artifacts/`, and emits a `prd-document-review` item (`layout: document`) that files the approved PRD to the Obsidian vault.
- **Acceptance Criteria:**
  - `calendar-from-screenshot` stages an assisted calendar event hold and flags scheduling conflicts.
  - `prd-review` emits a `document`-layout review card with Recall citations and writes the approved PRD to the vault.

---

### Phase 4: Thornhill Phone Executor, WhatsApp Digest, Music Offers & Remote MCP (`D8`, `D10 Phase 4`)

#### Item P4-1: Thornhill Phone Executor Adapter (`phone.task.run`) & Stop-Point Webhook (`D8`)
- **Files:** `src/execution/adapters/thornhill.ts`, `capabilities/thornhill-phone/manifest.yaml`, `capabilities/thornhill-phone/index.ts`, `src/api/webhooks.ts`
- **Requirements:**
  - Register `phone.task.run` (`assisted` / `guided` mode; never `automated`) in `src/execution/adapters/thornhill.ts`.
  - Dispatches phone jobs to Thornhill's local gateway (`config.thornhill.url`, passing Samaritan's `task_id` and `run_id` for unified correlation per `C1/G1` and `D8`).
  - Add `POST /api/webhooks/thornhill`: when Thornhill encounters a `stop_before` gate (login, OTP, send message, or payment confirmation), it posts to Samaritan, which ingests an urgent `phone-stop-point` Action Item in the Inbox so Thornhill never approves its own stop points.
- **Acceptance Criteria:**
  - `phone.task.run` forwards `task_id` and `run_id` to Thornhill; a stop-point webhook creates an urgent `phone-stop-point` review item in Samaritan's Inbox.

#### Item P4-2: `whatsapp-digest` Capability (Read-Only Companion Digest from Agent Phone)
- **Files:** `capabilities/whatsapp-digest/manifest.yaml`, `capabilities/whatsapp-digest/index.ts`
- **Requirements:**
  - Consumes read-only WhatsApp message batches forwarded from the linked companion session on the Thornhill agent phone (never using an unofficial bridge on Sandip's primary number).
  - Applies Rule-of-Two untrusted-text quarantine, tags items with `scope: "personal"`, and emits `whatsapp-digest-review` (`guided` mode) for high-signal personal/group messages.
- **Acceptance Criteria:**
  - High-signal WhatsApp companion messages produce `personal`-scoped `guided` Inbox items.

#### Item P4-3: `music-offer` Capability (Pre-VIP Meeting & High-Stress Daily Summary One-Tap Links)
- **Files:** `capabilities/music-offer/manifest.yaml`, `capabilities/music-offer/index.ts`
- **Requirements:**
  - Triggered by `calendar.meeting_upcoming` (when meeting title/attendees match VIP or high-stakes keywords) or `oura.daily_stress` (when daily stress summary is elevated).
  - Emits `music-offer-card` (`execution.mode: "guided"`) with one-tap Apple Music (`music://`) and Spotify (`spotify:playlist:...`) deep links. Never auto-plays audio.
- **Acceptance Criteria:**
  - VIP meeting or high daily stress emits a `guided` music offer card with one-tap deep links and never auto-plays.

#### Item P4-4: Remote MCP OAuth Discovery & Scoped Token Endpoint (`D4`, `Phase 4`)
- **Files:** `src/api/server.ts`, `src/mcp/index.ts`
- **Requirements:**
  - Add OAuth 2.0 metadata discovery route `GET /.well-known/oauth-authorization-server` and token exchange route `POST /api/oauth/token` (validating `mcp:secret` / `web:token` from Keychain and issuing an HMAC-signed bearer token scoped to `mcp:tools`).
  - Allow `POST /api/mcp` from remote hosts (`claude.ai`, `ChatGPT web`, `Gemini app`) when a valid Bearer token or OAuth access token is presented, while preserving the hard invariant that zero approval tools exist on MCP.
- **Acceptance Criteria:**
  - Remote `POST /api/mcp` requests without a token return `401`; requests with a valid OAuth/Bearer token can invoke all 8 MCP tools and cannot approve Action Items.
