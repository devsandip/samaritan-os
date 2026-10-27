# Gemini Round 1: Architecture and Build Plan

Written: 2026-10-20 10:52 IST

## 1. Recommendation in one paragraph

Do not replace Samaritan with OpenClaw or Hermes Agent, and do not start from scratch. Make **Samaritan** the single control plane, policy engine, approval inbox, and command centre on your Mac, and collapse the separate "Brain" planned in Thornhill (`esp32-iphone-agent`) into Samaritan so you only run one task store, one Telegram bot, and one web dashboard. None of the popular open-source runtimes (OpenClaw, Hermes Agent, Goose, ZeroClaw) solve unattended human-in-the-loop governance with hard database invariants the way Samaritan v0 already does (`src/store/action-items.ts` audit triggers, three-place money lock, fail-closed `expr-eval` predicates, and schema-driven rendering). What Samaritan lacks is an always-on daemon (`node-cron` + event bus), an ad-hoc task dispatcher ("Cowork" mode), and live connectors for your existing repos (`MailMCP`, `the-library`, `healthAI`, `job_tracker`, `clawhub/scrask-bot`, and `esp32-iphone-agent`). Build the daemon and the end-to-end **Meeting context -> notes -> follow-up tasks** workflow on your current Mac first, expose a 6-tool `samaritan-mcp` server so Claude, ChatGPT, and Gemini share the same brain, and plug Claude Agent SDK (or Hermes/OpenClaw workers) underneath Samaritan's Run Layer as replaceable execution engines.

---

## 2. Decision table

| ID | Position | Confidence | One-line reason |
|---|---|---|---|
| **D1** | **Samaritan kernel + Claude Agent SDK / CLI workers** (optional Hermes runner for open-ended loops; reject OpenClaw as core OS) | High | Samaritan already enforces append-only audit triggers and fail-closed policy gates that OpenClaw and Hermes lack; use agent SDKs/CLIs inside capabilities, not above the Action Center. |
| **D2** | **Extend Samaritan's React/Fastify UI (`ui/src/`)** with a Cowork Task Dispatch bar, Live Runs/Claude-session board, and per-capability mute/channel controls | High | Samaritan's SPA already ships Dashboard, Inbox, Deferred, Completed, Settings, and 4 schema-driven render layouts (`card`, `form`, `document`, `diff`) with 330 passing tests. |
| **D3** | **Three-part split with strict roles:** Obsidian (`~/Documents/Obsidian/Samaritan/` + repo `journal/`) for prose/notes, Notion for relational tables, and `~/.samaritan/samaritan.db` (`node:sqlite` + FTS5 + `sqlite-vec`) as the operational ledger and unified RAG index | High | Matches your working `pm-os.item.file` adapter and `src/recall/` design without duplicating prose into databases or structured rows into markdown. |
| **D4** | **Single 6-tool `samaritan-mcp` server** (stdio + localhost HTTP) plus an auto-generated `~/.samaritan/BRAIN_INDEX.md` referenced from global `CLAUDE.md`, `GEMINI.md`, and `AGENTS.md` | High | Thornhill proved on 2026-10-18 that Cowork drops tool arguments on 33-tool MCP servers while 4-tool servers work; a tiny MCP surface plus deterministic file paths works across Claude, ChatGPT, and Gemini. |
| **D5** | **Laptop Web SPA (`127.0.0.1:4173`)** for deep work/batch triage, **Mobile PWA over Tailscale (`sandip-mac.tail9b2f5e.ts.net:4173`)** for phone dashboard/audio, and **one unified Telegram bot** for push alerts, inline Approve/Reject buttons, and quick task capture | High | One shared Fastify API and SQLite store prevents split state across laptop, phone, and Telegram. |
| **D6** | **Current Mac initially (`launchd` daemon + `caffeinate -dis`)**, keeping only stateless ingress (`MailMCP`, `the-library`) on AWS Lambda | High | Confirmed by Sandip in `codex/USER-ANSWERS.md`; local execution is required for repo journals, Obsidian vault, macOS Keychain, Claude Code session logs, and USB WebDriverAgent. |
| **D7** | **API/MCP-first (`MailMCP`, Google Calendar, Fireflies, Oura V2, Hevy API, PostHog, TickTick OAuth, `the-library`), reusing code from `healthAI`, `job_tracker`, and `scrask-bot`; phone UI automation only for gaps** | High | Half of the required connectors already exist across your `~/Developer/` repos as standalone silos that just need thin Samaritan capability wrappers. |
| **D8** | **Retire Thornhill's planned Brain/Telegram bot; run Thornhill strictly as the local Phone Executor Gateway daemon (`127.0.0.1`) behind a Samaritan execution adapter (`phone.task.run`)** | High | Building Thornhill's separate task store, planner, and approval bot would duplicate Samaritan's Action Center; phone stop-points (`stop_before` pay/send) should emit directly to Samaritan's Inbox. |
| **D9** | **Keep Samaritan's 3 structural invariants (DB audit triggers, 3-place money lock, guided fallback) + enforce a zero-tool structured-output quarantine on untrusted text (email, WhatsApp, job pages)** | High | Reading WhatsApp, iMessage, and email exposes the system to indirect prompt injection; separating untrusted extraction from gated execution prevents silent exfiltration or unauthorized sends. |
| **D10** | **Phase 1 (Days 1-4): Daemon + Scheduler + Meetings workflow (pre-meeting brief -> post-meeting note -> tasks); Phase 2 (Days 5-8): Command Centre UI + `samaritan-mcp` + bi-directional Telegram; Phase 3 (Days 9-14): Oura/Hevy, Nutgraf, Email/Scrask, WBR, Jobs; Phase 4 (Days 15-20): Thornhill adapter + Recall v1** | High | Directly delivers Sandip's #1 chosen workflow (`Meeting context -> notes -> follow-up tasks`) on his current Mac in week 1 before expanding breadth. |
| **G1** | **Unify Brain & Task Store:** Merge Thornhill's `task_submit`/`task_get` state machine (`queued|planning|running|needs_input|needs_approval|done`) into Samaritan's SQLite store | High | Gives Samaritan the "Claude Cowork" async task dispatch model for both desktop and phone tasks without running two competing orchestrators. |
| **G2** | **Fix Run Layer & Delivery gaps before daemonizing:** Add `AbortSignal` / worker termination to `src/run-layer/index.ts` and wire a scheduled caller for `TelegramDelivery.flush()` in `src/delivery/index.ts` | High | Code inspection shows `withTimeout()` currently leaks timed-out runs in the background and `TelegramDelivery.flush()` is never called after quiet hours end. |

---

## 3. What changed since my last round

N/A (Round 1 baseline).

---

## 4. Pushback on the others

N/A for Round 1 (independent research). Specific pushback and synthesis will follow in Round 2 after reading `claude/round-1.md` and `codex/round-1.md`.

---

## 5. Open questions for the other agents

1. **To Claude and Codex (Brain consolidation, `G1`):** `esp32-iphone-agent/docs/architecture.md` specifies a standalone Thornhill Brain service with its own SQLite task store, its own Telegram bot, and its own approval loop. Do we all agree to scrap the separate Thornhill Brain and use Samaritan as the single brain, approval gate, and Telegram bot, keeping Thornhill purely as the phone device-pool executor?
2. **To Claude and Codex (OpenClaw / Hermes role, `D1`):** OpenClaw recently added `Workboard` and Control UI session dashboards, and Hermes Agent has `hermes-webui` plus skill self-learning. However, adopting either as the top-level daemon means giving up Samaritan's schema-driven `ActionItem` contract and SQLite trigger invariants, or maintaining two control planes. Do either of you see any justification for running OpenClaw or Hermes as the outer daemon, versus invoking them (or borrowing OpenClaw's channel/skill logic like `scrask-bot`) *inside* Samaritan's Run Layer?
3. **To Claude and Codex (Cowork task model in Samaritan, `D2`):** Samaritan v0 models **Action Items** (outputs waiting on human review), but does not yet model **Tasks** (user-submitted goals like "research 5 PM roles and draft outreach" that run multi-step in the background and occasionally emit Action Items when `needs_input` or `needs_approval`). Should we add a first-class `tasks` table to `samaritan.db` (adopting Thornhill's `queued -> running -> needs_input/needs_approval -> done` lifecycle) so the Command Centre handles both inbound triage and outbound Cowork delegation?
4. **To Claude and Codex (Oura daytime stress trigger, `D7`):** The scratch-pad asks for music when stressed in Oura. Oura's V2 API (`daily_stress`) exposes periodic daytime stress summaries rather than a real-time continuous stream. Should we scope the music trigger to (a) pre-meeting calendar hooks (5 minutes before high-stakes meetings) plus (b) 30-minute polling of Oura's daytime stress summary when at the desk?

---

## 6. Open questions for Sandip

*(Also written to `gemini/QUESTIONS.md`.)*

1. **TickTick vs Notion for task tracking:** Your `CLAUDE.md` says TickTick is your canonical TODO inbox, and Samaritan v0 stages tasks for TickTick. Do you want to keep TickTick as the primary task app (by wiring its OAuth Open API for one-click creation), or move daily tasks into Samaritan/Notion/Obsidian?
2. **Meeting capture source when Fireflies is not in the call:** For your #1 workflow (meeting context -> notes -> follow-up tasks), are all your work meetings recorded by Fireflies, or do you also need a local Mac audio/system-audio transcriber (like Whisper/Parakeet) for ad-hoc calls and huddles where a bot cannot join?
3. **Hevy API availability:** Hevy's official REST API (`api.hevyapp.com/v1`) requires a Hevy Pro subscription and API key to read/update routines programmatically. Do you have a Hevy API key, or should Samaritan adjust workouts via Thornhill driving the Hevy iOS app on the spare iPhone?
4. **WhatsApp & iMessage read path:** On your Mac, iMessage can be read directly from `~/Library/Messages/chat.db` (Full Disk Access), while WhatsApp can either be read via the linked companion session on the Thornhill iPhone or a local bridge (like `whatsmeow`/Beeper). Are you comfortable granting local read-only DB access on your Mac, or should personal messaging stay strictly on the dedicated agent iPhone?
5. **Music provider:** When Samaritan offers focus or high-energy music before key meetings or on high-stress days, do you use Spotify, Apple Music, or YouTube Music?

---

## 7. Deep-Dive Architecture & Codebase Audit

### 7.1 Why Samaritan Beats OpenClaw and Hermes as the Core OS

A review of `samaritan/docs/COMPETITIVE-LANDSCAPE.md` and current October 2026 releases of OpenClaw (`openclaw/openclaw`) and Hermes Agent (`NousResearch/hermes-agent`) shows a clear architectural divide:

| Dimension | OpenClaw (Oct 2026) | Hermes Agent (Oct 2026) | Samaritan (v0 + v1 plan) |
|---|---|---|---|
| **Primary unit** | Chat session / `flow_run` | Autonomous agent loop + self-written skills | Typed `ActionItem` + thick `manifest.yaml` |
| **Approval guarantee** | Tool-exec prompt (`deny/allowlist/ask/auto`); prose `AGENTS.md` standing orders | `write_approval.py` only gates its own memory/skill writes; off by default | Fail-closed `expr-eval` Policy Engine + 3-place hardcoded money lock |
| **Audit invariant** | Metadata-only log; docs state "absence of a row proves nothing" | Session logs in SQLite | SQLite triggers abort any `action_items` transition without an `action_item_events` row |
| **Unattended cron behavior** | Executes directly or blocks session | Executes directly unless skill write approval is enabled | Evaluates policy -> auto-completes low-risk items or queues in Action Center + Telegram |
| **UI rendering** | Control UI + Workboard (session/task centric) | `hermes-webui` (chat + terminal + skill diff) | Schema-driven `card`, `form`, `document`, `diff` surfaces (`ui/src/renderers/`) |
| **Degradation** | Fails if tool/skill is missing | Fails or hallucinates workaround | Degrades automatically from `automated` -> `assisted` -> `guided` |

**Verdict:** OpenClaw and Hermes are built to maximize autonomous tool execution; Samaritan is built to maximize **trusted delegation**. Because this system touches work email, calendar, WhatsApp, bills, and job applications, Samaritan's governance contract must sit at the top. Where Hermes or Claude Agent SDK shine (multi-step research, coding, or drafting), they should run *inside* a Samaritan capability or task worker and emit their proposed side effects to Samaritan's Action Center.

### 7.2 Inventory of What You Already Have Across `~/Developer/`

You do not have a blank slate. You have six working or half-built pieces that have never been wired together:

1. **`~/Developer/samaritan` (The Kernel & Inbox):**
   - **Working:** `node:sqlite` store, migrations 1-5, Policy Engine, Execution Registry (`notion.*`, `obsidian.*`, `ticktick.*`, `pm-os.item.file`), Run Layer (`src/run-layer/index.ts`), React SPA (`Dashboard`, `Inbox`, `Deferred`, `Completed`, `Settings`), Telegram outbound with quiet hours (`src/delivery/index.ts`), capability scaffolder, Claude scheduled-task importer, 330 passing tests.
   - **Gaps to fix immediately:**
     - No long-running daemon (`node-cron` + event bus + `launchd` plist).
     - `TelegramDelivery.flush()` (`src/delivery/index.ts:158`) is never called by a timer, so quiet-hour messages stay queued.
     - `withTimeout()` (`src/run-layer/index.ts:145`) uses `Promise.race` without an `AbortController` or worker termination, leaving timed-out capabilities running in the background.
     - `dailyNotePath()` in `src/execution/adapters/obsidian.ts` uses UTC instead of IST (`Asia/Kolkata`).
     - `src/recall/` has chunking, local embeddings, and `sqlite-vec` + FTS5 tables (`index-store.ts`), but lacks RRF fusion, the vault/journal crawler, and the `/api/recall` endpoint.

2. **`~/Developer/esp32-iphone-agent` (Thornhill - The Phone Actuator):**
   - **Working:** Spare iPhone 13 driven over USB via Xcode + WebDriverAgent (`scripts/start-iphone-control.sh`), shared token-protected `mobile-mcp` on Tailscale (`http://sandip-mac.tail9b2f5e.ts.net:10000/mcp`), and app memory/routines (`memory/apps/swiggy/`).
   - **Architectural overlap:** Thornhill's `docs/architecture.md` proposes building a new Brain, SQLite task store, Telegram bot, and remote MCP front door. **Merge the Brain into Samaritan** and keep Thornhill strictly as the Python/TS Phone Executor Gateway managing device locks, account locks, popup handlers, and routines.

3. **`~/Developer/the-library` (Nutgraf - Newsletter Reader):**
   - **Working:** Live in prod at `https://sandip.dev/nutgraf/` on AWS (CloudFront + API Gateway + Lambda + S3 + DynamoDB), pulling Gmail every 2 hours (06:00-22:00 IST) and summarizing/classifying via Bedrock Haiku 4.5.
   - **Integration path:** Expose a read-only token-authenticated endpoint (or read from DynamoDB/S3 with the local AWS profile) so Samaritan's `commute-brief` capability can fetch top unread summaries and synthesize a 5-minute morning audio podcast (via OpenAI/ElevenLabs/local Kokoro TTS) playable from the mobile PWA or Telegram at 08:30 IST.

4. **`~/Developer/MailMCP` (Multi-account Gmail MCP):**
   - **Working:** Self-hosted AWS Lambda + KMS multi-account Gmail server supporting `search_threads`, `get_thread`, `create_draft`, `reply`, `label_message` across `work` and `personal` accounts (~$1/mo).
   - **Integration path:** Wire `MailMCP`'s Gmail client directly into Samaritan's `gmail.draft.create` (`assisted` mode) execution adapter and `email-triage` / `subscription-watch` capabilities.

5. **`~/Developer/healthAI` (Oura + Hevy + Nutrition Coach):**
   - **Working:** Next.js 15 web app + Expo mobile app, Bedrock Sonnet 4.6 / Haiku 4.5 coaching prompts (`packages/core/`), 80-item Indian food DB, and AWS Secrets Manager slots (`healthai/integrations/oura`).
   - **Gap:** `packages/core/src/sources/oura.ts` and `hevy.ts` currently return `mockOuraSnapshot` and `mockHevySnapshot`. Replacing those 27-line mocks with real `fetch()` calls to `api.ouraring.com/v2` and `api.hevyapp.com/v1` gives Samaritan immediate morning readiness + workout adjustment capabilities.

6. **`~/Developer/clawhub/scrask-bot` & `~/Developer/job_tracker`:**
   - **`scrask-bot`:** Working Python vision parser (`scripts/scrask_bot.py`) that routes screenshots through Gemini 2.0 Flash with automatic fallback to Claude Opus when per-field confidence `< 0.60`. Drop-in backend for Samaritan's `calendar-from-screenshot` capability.
   - **`job_tracker`:** Working FastAPI + Claude Sonnet extractor (`app/llm.py`, `app/dedup.py`, `app/notion_client_wrapper.py`) connected to Notion DB `d45bc836-239c-450b-a9cb-8be989880915`. Drop-in backend for Samaritan's `job-search` capability.

### 7.3 Designing the Missing Command Centre ("Action Center + Cowork")

To turn Samaritan's v0 Action Center into a full **Life OS Command Centre** across Laptop, Phone (PWA), and Telegram, extend `samaritan` in four concrete ways:

1. **Add First-Class Tasks (`tasks` table) alongside `action_items`:**
   - **Action Items** are bottom-up: a capability ran on a schedule/event and needs a decision (`approve`, `edit`, `reject`, `defer`).
   - **Tasks** are top-down ("Claude Cowork" style): you type or speak a goal ("Prepare my PRD review for the payments spec by 4pm", "Order groceries on Blinkit", "Find 5 Senior PM roles in fintech and score against my resume").
   - Schema addition to `samaritan.db`:
     - `tasks(id, title, goal, lane, status, runner, session_id, parent_task_id, created_at, updated_at, result_summary)` where `status` is `queued | planning | running | needs_input | needs_approval | done | failed | cancelled`.
     - When a running task hits a question or an irreversible step, it emits an `ActionItem` linked via `source.id = task.id`, which surfaces in the exact same Inbox and Telegram bot.

2. **Upgrade the Dashboard UI (`ui/src/views/Dashboard.tsx`):**
   - **Top Command Bar (`Ask or Delegate`):** A unified input box at the top of the Dashboard (and `Cmd+K` anywhere). Prefix or toggle between **Ask** (queries Recall RAG with citations) and **Delegate** (creates a background Task assigned to Claude Agent SDK, Codex, or Thornhill).
   - **Live Activity & Sessions Strip:** Directly below the 4 stat tiles, show active background Tasks, Thornhill phone runs, and local **Claude Code sessions** (by watching `~/.claude/projects/*/*.jsonl` and process state; when a Claude Code session is idle waiting on a user prompt or tool permission, surface an urgent `coding` lane card with a one-click jump or relay).
   - **Notification & Autonomy Switchboard (`Settings.tsx`):** Add per-capability toggles on `capabilities` rows (`enabled`, `delivery_channels: inbox|telegram`, `quiet_hours_override`, `mute_until`) persisted in SQLite so you can silence any noisy agent from your phone or laptop in one tap.

3. **Bidirectional Telegram Bot + Mobile PWA:**
   - Upgrade `src/delivery/index.ts` into a bidirectional Telegram controller:
     - Outbound notifications include inline keyboards (`[Approve]`, `[Edit]`, `[Snooze 2h]`, `[Dismiss]`, `[Mute agent 24h]`).
     - Sending a photo to the bot invokes `scrask-bot` -> stages a `calendar-from-screenshot` or task item.
     - Sending text/voice creates a `Task` or `capture` note.
   - Serve the Fastify/React SPA over Tailscale (`https://sandip-mac.tail9b2f5e.ts.net:4173`) with a Web App Manifest (`manifest.json`) so adding it to your iPhone Home Screen gives a full-screen mobile Command Centre.

### 7.4 Cross-Assistant Discovery (How Claude, ChatGPT, and Gemini Know Everything)

To ensure every AI assistant on your Mac knows Samaritan exists, knows what agents have done, and knows where files live:

1. **`samaritan-mcp` (6 tools, plain JSON schemas for Cowork compatibility):**
   - `samaritan_status()`: Returns active tasks, pending inbox count, today's schedule summary, Oura readiness, and recent auto-handled actions.
   - `samaritan_recall(query, filters?)`: Runs hybrid FTS5 + `sqlite-vec` + structured SQL search across Obsidian vault, repo `journal/` files, Notion mirror tables, and the Action Store audit log; returns snippets with file paths and Notion row IDs.
   - `samaritan_inbox_list(lane?, limit?)`: Lists pending Action Items needing Sandip.
   - `samaritan_act(action_item_id, response_id, edits?)`: Approves, edits, defers, or rejects an item through the same audited state machine.
   - `samaritan_task_submit(goal, lane?, runner?)`: Submits a background task to Samaritan's Run Layer / Thornhill.
   - `samaritan_emit(capability_id, items)`: Lets any interactive Claude/ChatGPT/Gemini session stage decisions, tasks, or drafts into the Action Center.

2. **Auto-Generated `~/.samaritan/BRAIN_INDEX.md`:**
   - Rewritten by Samaritan on boot and every 15 minutes.
   - Contains: canonical paths (`~/Documents/Obsidian/Samaritan/`, `~/Developer/*/journal/INDEX.md`, Notion DB IDs), today's calendar & focus items, active projects, and the last 20 completed actions/decisions.
   - Add a 10-line pointer block to `~/.claude/CLAUDE.md`, `~/Developer/CLAUDE.md`, `~/.gemini/GEMINI.md`, and ChatGPT's custom instructions / desktop MCP config instructing every model to read `~/.samaritan/BRAIN_INDEX.md` or call `samaritan_status()` / `samaritan_recall()` before answering questions about your work, schedule, or projects.

### 7.5 Day-in-the-Life Mapping (How the 11 Daily Beats Run)

| Time / Trigger | Capability | Data In | Action / Output | Execution Mode |
|---|---|---|---|---|
| **06:45 IST (Cron / Wake)** | `morning-coach` | Oura V2 (`daily_sleep`, `daily_readiness`) + Hevy (`workouts`, `routines`) | Computes recovery score; proposes adjusted Hevy workout weights/sets (`layout: diff`) | `assisted` (approve updates Hevy routine via API) |
| **08:00 IST (Post-workout event / Cron)** | `daily-brief` | Google Calendar + TickTick + Action Store + Obsidian daily note | Synthesizes personal + professional day plan; pushes to Telegram + Dashboard top card | `automated` (read-only brief) |
| **08:30 IST (Commute)** | `commute-podcast` | `the-library` (Nutgraf API/DDB) unread issues | Generates 5-min audio summary of top ranked newsletters + deep link to `sandip.dev/nutgraf` | `automated` (audio ready in Telegram/PWA) |
| **09:30 IST (Office arrival / Cron)** | `first-hour-focus` | Calendar + TickTick + GitHub PRs + `action_items` | Picks top 3-5 high-leverage tasks for hour 1; flags backlog tasks missing due dates | `assisted` (one-tap set due dates in TickTick) |
| **T-10m before any meeting** | `meeting-prep` | Calendar event + `Recall` (Obsidian `Areas/Meetings`, Notion Decisions/People, Gmail threads) | Sends 5-bullet context brief: why scheduled, past decisions, open tasks with attendees; offers high-energy playlist if VIP meeting | `automated` (brief) + `guided` (music deep link) |
| **T+2m after meeting ends** | `meeting` | Fireflies webhook/MCP or local audio/notes prompt | Writes `Areas/Meetings/YYYY-MM-DD - <topic>.md` directly; emits extracted decisions, tasks, insights (`layout: form` checklist) | `automated` on approve via `pm-os.item.file` -> Notion & TickTick |
| **Continuous / 30m poll** | `stress-watch` | Oura V2 (`daily_stress`) + Calendar density | If stress time spikes, sends quiet nudge with 1-tap Apple Music / Spotify focus playlist | `guided` (never auto-plays audio unprompted) |
| **Hourly / Push** | `email-triage` & `msg-triage` | `MailMCP` (Gmail) + `chat.db` (iMessage) + Thornhill (WhatsApp) | Filters noise; drafts replies for high-signal messages (`layout: card` with editable textarea); extracts bills/payment reminders | `assisted` (`gmail.draft.create`) / `guided` (payments & personal replies) |
| **Photo sent to Telegram** | `calendar-from-screenshot` | `clawhub/scrask-bot` (`scrask_bot.py`) | Extracts event/task with per-field confidence; auto-stages if confidence >= 0.75, else asks 1 clarification question | `assisted` (Google Calendar / TickTick) |
| **Daily 18:00 IST** | `job-scout` | `MailMCP` recruiter emails + job URLs -> `job_tracker` extractor | Scores roles against `resume/`, deduplicates against Notion DB, stages top matches with drafted recruiter replies | `assisted` (saves to Notion + stages Gmail draft) |
| **Continuous / Friday 17:00 IST** | `dev-watch` & `weekly-digest` | `chokidar` on `~/Developer/*/journal/` + `~/.claude/` transcripts | Alerts when a Claude Code session is blocked on input; compiles Friday WBR (`layout: document`) from all repo journals | `assisted` (writes approved WBR to Obsidian `Areas/Weekly/`) |

---

## 8. Sources

- Local repository inspection:
  - `~/Developer/samaritan/README.md`, `DECISIONS.md`, `docs/PRD.md`, `docs/TECH-SPEC.md`, `docs/UI-SPEC.md`, `docs/COMPETITIVE-LANDSCAPE.md`, `resume/RESUME_2026-07-21-0843.md`
  - `~/Developer/samaritan/src/run-layer/index.ts`, `src/delivery/index.ts`, `ui/src/views/Dashboard.tsx`, `capabilities/meeting/manifest.yaml`, `plugin/skills/meeting/SKILL.md`
  - `~/Developer/esp32-iphone-agent/README.md`, `docs/architecture.md`, `WORKLOG.md`
  - `~/Developer/the-library/README.md`
  - `~/Developer/MailMCP/README.md`
  - `~/Developer/healthAI/README.md`, `STATUS.md`, `packages/core/src/sources/oura.ts`, `packages/core/src/sources/hevy.ts`
  - `~/Developer/clawhub/scrask-bot/README.md`
  - `~/Developer/job_tracker/README.md`
  - `~/Developer/CLAUDE.md`
- External documentation verified 2026-10-20:
  - OpenClaw documentation & Control UI / Workboard architecture: https://docs.openclaw.ai/web/control-ui , https://docs.openclaw.ai/web/dashboard-architecture , https://docs.openclaw.ai/cli/approvals
  - Hermes Agent documentation & API server / desktop architecture: https://hermes-agent.nousresearch.com/docs/ , https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server , https://hermes-agent.nousresearch.com/docs/user-guide/desktop
  - Oura V2 OpenAPI specification: https://cloud.ouraring.com/v2/static/json/openapi-1.42.json
