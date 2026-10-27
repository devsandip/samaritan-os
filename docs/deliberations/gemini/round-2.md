# Gemini, round 2

Written: 2026-10-20 11:30 IST. Read `claude/round-1.md` (+ `notes/`), `codex/round-1.md` (+ `repo-audit.md`, `integration-matrix.md`, `build-blueprint.md`), and both peers' `messages-to-peers.md`.

## 1. Recommendation in one paragraph

All three agents have converged on the core architecture: keep **Samaritan** as the single control plane, policy engine, approval inbox, and command centre on your current Mac; run tool-using LLM capabilities and ad-hoc tasks through the **Claude Agent SDK** behind a small worker boundary inside Samaritan's Run Layer; fold Thornhill's planned Brain into Samaritan while keeping Thornhill as the local phone executor; and ship the **Meeting context -> notes -> follow-up tasks** workflow first. In this round, I adopt Codex's security rule removing approval actions from the MCP facade (only authenticated human surfaces may approve items), adopt Codex's child-process worker fencing and payload-hash approval binding, and adopt Claude's HTTP hook route (`POST /api/activity`) for Claude Code session monitoring. I push back on three specific points: skip Codex's 2-day OpenClaw bake-off before Phase 1, trim Codex's 10-table SQLite proposal down to 4 tables that reuse `action_items` and `delivery_queue`, and drop Claude's "auto-approve after N minutes of silence" tier in `D9`.

---

## 2. Decision table

| ID | Position | Confidence | One-line reason |
|---|---|---|---|
| **D1 Agent runtime** | **Agree:** Extend Samaritan's Run Layer with a small `WorkerAdapter` interface (`start`, `events`, `answer`, `cancel`, `status`) backed by the **Claude Agent SDK** (TypeScript) in child processes alongside deterministic TS capabilities; no OpenClaw or Hermes core, and no pre-Phase-1 OpenClaw trial. | High | Reuses Samaritan's TS stack and governance contracts while isolating stuck/untrusted runs in child processes; `WorkerAdapter` keeps Hermes or OpenClaw swappable later without a 2-day delay now. |
| **D2 Command centre** | **Agree:** Extend Samaritan's React/Fastify UI (`ui/src/`) with three additions: **Now / Activity** (today's schedule, active runs across runtimes, blocked coding sessions, Stop/Mute controls), **Tasks** (Cowork-style goal composer and thread continuation), and **Per-source Notification Rules** in Settings, while keeping **Inbox** as the single review surface. | High | Builds directly on Samaritan's working 5-view SPA and 4 schema-driven renderers (`card`, `form`, `document`, `diff`). |
| **D3 Second brain** | **Agree:** Preserve canonical ownership per data type: **Obsidian vault** (`~/Documents/Obsidian/Samaritan/` + repo `journal/`) for prose, meeting notes, and PRDs; **Notion** for relational DBs (Decisions, Insights, People, Projects, Jobs); **TickTick** for personal tasks; **Samaritan SQLite** (`~/.samaritan/samaritan.db`) for operational state (`action_items`, `tasks`, `runs`, `artifacts`, `audit`) plus the derived Recall index. | High | Prevents rival memory stores across assistants while keeping prose human-editable and structured records queryable. |
| **D4 Cross-assistant context** | **Agree:** Expose one small `samaritan` MCP server (6 to 8 read/propose tools, plain schemas, **zero approval tools**) over local stdio/HTTP for Claude Code, Codex, Gemini CLI, and ChatGPT desktop, plus authenticated public HTTPS tunnel later for web clients; pair with a concise routing doc in the vault linked from `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, and `~/.gemini/GEMINI.md`. | High | Small tool count avoids the Cowork 33-tool drop bug, and excluding approval tools prevents any assistant session from self-approving its own proposed writes. |
| **D5 Surfaces** | **Agree:** One Fastify + SQLite backend serving (1) Laptop Web UI (`127.0.0.1:4173`), (2) Phone responsive Web / Home-Screen PWA over Tailscale (`sandip-mac.tail9b2f5e.ts.net:4173`) with explicit auth, and (3) one bidirectional **Samaritan Telegram Bot** for push alerts, inline Approve/Reject/Snooze buttons, capture, and task submission. Coding sessions stay in Claude Remote Control, linked from Activity. | High | Telegram handles reliable mobile push and quick triage; the Tailscale PWA handles rich review without needing public HTTPS Mini App plumbing in Phase 1. |
| **D6 Hosting** | **Agree:** Current Mac initially under `launchd` with sleep disabled (`caffeinate -dis`), local DB backups, and boot/Keychain availability checks; keep `MailMCP` and `Nutgraf` (`the-library`) on AWS. | High | Matches Sandip's direct choice (`codex/USER-ANSWERS.md`) and is required for `chat.db`, repo journals, vault, Keychain, and USB WebDriverAgent. |
| **D7 Integrations** | **Agree:** Official API/MCP first, Mac-local second, Thornhill phone third. Start with Google Calendar sync + Fireflies/Granola or pasted meeting notes + TickTick OAuth adapter + Claude Code HTTP hooks; treat Oura `daily_stress` as a periodic summary (not real-time stress detection) and WhatsApp as a read-only companion digest on the agent phone (never an unofficial bridge on the main number). | High | Respects real API constraints verified across all three Round 1 audits (`healthAI` mocks, Oura V2 OpenAPI schema, WhatsApp ban risk). |
| **D8 Phone control** | **Agree:** Thornhill becomes Samaritan's phone executor (`phone.task` adapter, `guided` or `assisted` mode), keeping its own local device pool, account locks, 30-day screenshot logs, and `memory/apps/` routines on the Mac, while Samaritan owns user-facing task identity, questions, approvals, and Telegram delivery. Use WDA/mobile-mcp now; evaluate ESP32 when parts arrive. | High | Eliminates duplicate brains and duplicate Telegram bots while preserving clean service boundaries via shared `task_id` / `run_id`. |
| **D9 Trust and safety** | **Agree:** Samaritan owns final domain approvals; enforce Meta's Rule of Two (runs reading untrusted email/messages/web run in scoped child workers with zero write/send credentials and only emit proposed Action Items); bind approvals to exact `payload_hash`/revision; derive `actor` from authenticated user sessions; child-process kill + lease fencing for Stop; **no auto-approve on timeout/silence**. | High | Combines Samaritan's existing policy/money-lock guards with process isolation, server-derived auth, and fail-closed timeouts. |
| **D10 Build sequence** | **Agree:** Stage 0-1 (Week 1): Supervised daemon (`launchd`, `node-cron`, `TelegramDelivery.flush()`, child-process Stop, `source_cursors`) + end-to-end **Meetings workflow** (Calendar sync -> pre-meeting Recall brief -> post-meeting note/transcript extraction -> Inbox review -> Notion + TickTick OAuth write) + Claude Code HTTP hooks. Stage 2 (Week 2): Command Centre UI (Now/Activity + Tasks composer on Claude Agent SDK), bidirectional Telegram callbacks, and local `samaritan` MCP + pointer files. Stage 3 (Week 3+): Morning plan, Email/Recruiters (`MailMCP` + `job_tracker`), `scrask-bot`, WBR, Nutgraf summary, Oura/Hevy, PostHog. Stage 4: Thornhill phone adapter + WhatsApp companion digest. | High | Delivers Sandip's chosen #1 meeting workflow in week 1 on top of reliable daemon plumbing before broadening integrations. |
| **C1 / G1 One brain** | **Agree (merged C1 and G1):** Samaritan is the single user-facing planner, task ledger, approval inbox, and Telegram bot; Thornhill, Nutgraf, and MailMCP are specialized services it calls with correlated IDs rather than merging their internal databases into one file. | High | Unifies UX and governance while keeping service storage decoupled. |
| **C2 Billing** | **Agree:** Interactive sessions use Claude subscription limits; unattended Samaritan daemon runs use an explicit Console API key (drawing from Max monthly API credits if applicable) with a hard spend cap and per-run `cost_usd` tracking in the `runs` table; skip LLM calls when polled cursors show no change. | High | Prevents surprise bills and matches Anthropic's current October 2026 Agent SDK / Max credits policy. |
| **G2 Runtime & delivery fixes** | **Agree:** Ship child-process cancellation + lease fencing in `src/run-layer/index.ts`, a scheduled caller for `TelegramDelivery.flush()` in `src/delivery/index.ts`, server-derived `actor` auth on `/api/*`, and IST timezone fix in `dailyNotePath()` as Stage 0 prerequisites. | High | All three agents independently verified these exact defects in the current Samaritan source. |

---

## 3. What changed since my last round

1. **Removed `samaritan_act` (approval capability) from the MCP server (`D4`, `D9`):** Codex (`codex/build-blueprint.md` and `codex/messages-to-peers.md` #4) rightly caught that exposing an approval tool to assistant MCP clients lets a prompt-injected LLM session approve its own staged action. `samaritan-mcp` is now strictly read/propose/submit (`samaritan_today`, `samaritan_recall`, `samaritan_list_inbox`, `samaritan_propose_item`, `samaritan_submit_task`, `samaritan_task_status`, `samaritan_answer_question`). Approvals execute only from authenticated human surfaces (Web UI / PWA and Telegram), and `actor` is derived by the server from the session rather than trusted from request JSON.
2. **Corrected the SQLite audit trigger description and process boundary (`D1`, `D9`):** Accepting Codex's verification (`codex/messages-to-peers.md` #1). The SQLite triggers in `src/store/migrations.ts` guard `action_item_events` against `UPDATE`/`DELETE`, while `transition()` in `src/store/action-items.ts` enforces the status-plus-audit pair in an application transaction. Because in-process capabilities share the Node process and filesystem, untrusted extraction runs must execute in child processes with scoped read-only credentials and lease fencing.
3. **Adopted Claude Code native HTTP hooks (`D2`, `D7`):** Replaced my Round 1 proposal of watching `~/.claude/projects/*/*.jsonl` with Claude's cleaner finding (`claude/notes/research-evidence.md`): configure Claude Code's native HTTP hooks (`Notification` matchers `permission_prompt`, `idle_prompt`, `agent_needs_input`, plus `Stop` and `SessionEnd`) to `POST` directly to Samaritan's `POST /api/activity`, surfacing a direct link to Claude Remote Control.
4. **Dropped 30-minute Oura stress polling (`D7`):** Aligned with Claude and Codex that Oura V2 `daily_stress` is a daily aggregate summary and cannot act as a real-time stress detector. Music prompts are triggered by pre-meeting calendar rules or manual check-ins, never unprompted polling claims.
5. **Refined `C1`/`G1` (One Brain vs One Database) and external runtime citations (`D1`, `C2`):** Adopted Codex's distinction that Samaritan is the single user-facing brain/inbox while Thornhill and Nutgraf retain their own service-local storage (`~/.phone-gateway/` and AWS DynamoDB/S3). Also updated Round 1 notes to reflect Hermes's current `approvals.mode: smart` / `/v1/runs` API and Anthropic's October 7, 2026 support documentation on Agent SDK plan limits and Max monthly credits.

---

## 4. Pushback on the others

1. **Pushback on Codex's 2-day OpenClaw runtime trial (`codex/round-1.md`, "A runtime trial with an actual decision"):**
   Do not spend two focused development days benchmarking OpenClaw against the Claude Agent SDK before building Stage 1. Codex noted in `codex/messages-to-peers.md` (10:52 IST) that it is willing to accept the Claude Agent SDK as the initial default without making the OpenClaw trial a prerequisite. Let us lock that in: put Codex's 5-method `WorkerAdapter` interface (`start`, `events`, `answer`, `cancel`, `status`) in front of the Claude Agent SDK now, ship the meeting workflow in Week 1, and only trial OpenClaw or Hermes later if the Claude Agent SDK hits a concrete blocker.
2. **Pushback on Codex's 10-table SQLite expansion (`codex/build-blueprint.md`, "Proposed records"):**
   Codex proposes ten new tables (`delegated_tasks`, `task_messages`, `runs`, `run_events`, `artifacts`, `questions`, `approvals`, `schedule_receipts`, `source_events`, `outbox`). Creating separate `questions`, `approvals`, and `outbox` tables duplicates Samaritan's existing `action_items`, `action_item_events`, `executions`, and `delivery_queue` tables and risks splitting the review queue in two. Instead, keep the schema minimal (4 new tables in Migration 6):
   - `tasks`: delegated Cowork goals (`id, goal, lane, status, revision, runner, session_id, parent_task_id, created_at, updated_at, result_summary`).
   - `runs`: execution attempts for both scheduled capabilities and tasks (`id, capability_id, task_id, attempt, runner, remote_run_id, lease_token, lease_expires_at, status, cost_usd, usage_json, started_at, finished_at, error`).
   - `artifacts`: generated files/outputs (`id, task_id, run_id, kind, path_or_url, sha256, created_at`).
   - `source_cursors`: sync tokens and idempotency watermarks (`source_id PRIMARY KEY, cursor_value, last_synced_at, status`).
   - Reuse `action_items` for all task questions and approvals by adding nullable `task_id`, `run_id`, and `payload_hash` columns to `action_items`, and reuse `delivery_queue` (extended with `channel` and `dedupe_key`) as the single outbox.
3. **Pushback on Claude's "auto-approve after N minutes unless I object" tier (`claude/round-1.md`, `D9 Trust`):**
   Agreeing with Codex (`codex/messages-to-peers.md` #8), we should drop the countdown auto-approval tier for v1. If Sandip is in a back-to-back meeting or driving and misses a phone notification for 15 minutes, a timer expiring must never silently trigger an external side effect. If an action is genuinely low-risk and reversible (such as writing an Obsidian meeting note or filing a low-signal digest), the Policy Engine's `auto_complete_when` predicate already executes it immediately with an audit row; if it requires human review, it must fail closed (stay `pending` or transition to `expired`, never `approved`).

---

## 5. Open questions for the other agents

1. **To Codex and Claude (Schema convergence on `D2`/`D9`):** Do we agree on the 4-table addition (`tasks`, `runs`, `artifacts`, `source_cursors`) plus nullable `task_id`, `run_id`, and `payload_hash` on `action_items`, so that task clarifications and approvals flow through Samaritan's existing `action_items` Inbox and `delivery_queue` outbox rather than parallel `questions`/`approvals`/`outbox` tables?
2. **To Claude (Countdown auto-approval in `D9`):** Are you comfortable dropping the "auto-approve after N minutes unless I object" tier from v1 so all escalated items remain strictly fail-closed?
3. **To Claude and Codex (Convergence check):** With `C1`/`G1` merged, `D1` settled on Samaritan + Claude Agent SDK behind `WorkerAdapter` (no pre-Phase-1 OpenClaw bake-off), and `D4` excluding approval tools from MCP, I believe all ten `D1`-`D10` rows plus `C1`, `C2`, and `G2` have converged. Per `PROTOCOL.md` ("Convergence"), if both of you agree on the two points above, Claude (alphabetically first among active drafters `claude`, `codex`, `gemini`) should draft `consensus/PROPOSAL.md` in Round 3 for Codex and Gemini to sign off.

---

## 6. Open questions for Sandip

*(Consolidated across all three agents and updated in `gemini/QUESTIONS.md`.)*

1. **Task destination (`D3`, `D7`):** Should approved follow-up tasks continue to land in **TickTick** (via a real TickTick OAuth adapter replacing the v0 guided stub), or another task app?
2. **Meeting transcript source (`D7`, `D10`):** For the Week 1 meeting workflow, are you pulling transcripts from **Fireflies**, **Granola**, or both (plus pasted notes when unrecorded)?
3. **Claude plan & monthly spend ceiling (`C2`, `D1`):** Which Claude plan are you on (Pro, Max 5x, Max 20x), and what monthly API spend cap and daily proactive notification ceiling should Samaritan enforce?
4. **Always-on Mac posture (`D6`, `D8`):** Does your current Mac stay plugged in at home during the workday (so `launchd` + USB iPhone rig stay online while you are at the office), or do you carry this MacBook to work?
5. **Hevy Pro & Music provider (`D7`):** Do you have **Hevy Pro** (required for Hevy's REST API, otherwise workout edits stays guided/Thornhill) and which music service (**Apple Music**, **Spotify Premium**, or **YouTube Music**) should pre-meeting/focus links target?
6. **Email & WhatsApp boundaries (`D7`, `D9`):** Confirm that (a) email capabilities should only ever stage **Gmail drafts** (`assisted` mode, never auto-send), and (b) WhatsApp should only be read via the linked companion session on the Thornhill agent iPhone (never an unofficial bridge on your primary number).

---

## 7. Sources

- Peer Round 1 reports and supporting artifacts:
  - `claude/round-1.md`, `claude/notes/existing-systems.md`, `claude/notes/research-evidence.md`, `claude/notes/integrations.md`, `claude/messages-to-peers.md`
  - `codex/round-1.md`, `codex/repo-audit.md`, `codex/integration-matrix.md`, `codex/build-blueprint.md`, `codex/sources.md`, `codex/messages-to-peers.md`, `codex/USER-ANSWERS.md`
- Codebase verification:
  - `~/Developer/samaritan/src/store/migrations.ts`, `src/store/action-items.ts`, `src/run-layer/index.ts`, `src/delivery/index.ts`, `src/api/server.ts`
- External documentation verified in Round 1 & Round 2:
  - Anthropic Agent SDK plan usage & Max monthly API credits: https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan , https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans
  - Claude Code HTTP hooks & Remote Control: https://code.claude.com/docs/en/hooks , https://code.claude.com/docs/en/remote-control
  - Hermes Agent security & approval modes: https://hermes-agent.nousresearch.com/docs/user-guide/security/ , https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server
  - OpenClaw Workboard & Control UI: https://docs.openclaw.ai/plugins/workboard , https://docs.openclaw.ai/web/control-ui
  - OpenAI MCP local vs remote support: https://learn.chatgpt.com/docs/extend/mcp
