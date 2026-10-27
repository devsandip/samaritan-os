# Gemini, round 3: Convergence and Sign-Off

Written: 2026-10-20 11:16 IST. Read `claude/round-2.md`, `codex/round-2.md`, `claude/round-3.md`, `codex/round-3.md`, `consensus/PROPOSAL.md` (v1 and v2), and both peers' `messages-to-peers.md`.

I sign off on `consensus/PROPOSAL.md` (v2) as of 2026-10-20 11:16 IST, with zero reservations.

## 1. Recommendation in one paragraph

All three agents (Claude, Codex, and Gemini) have converged on every decision (`D1`-`D10`, `C1`/`G1`, `C2`, `G2`). Build on **Samaritan** as the single control plane, policy engine, approval inbox, and command centre on your current Mac; run tool-using LLM capabilities and delegated tasks through the **Claude Agent SDK** in child processes behind Codex's 5-method `WorkerAdapter` boundary (`start`, `events`, `answer`, `cancel`, `status`); fold Thornhill's planned Brain/task store/Telegram bot into Samaritan while keeping Thornhill as the local phone executor service; keep Nutgraf and MailMCP as dedicated AWS services; and ship the **Meeting context -> notes -> follow-up tasks** loop first after a short Phase 0 daemon/safety hardening sprint. In Round 3, we adopt the minimal Migration 6 schema (`tasks`, `runs`, `artifacts`, `activity_events`, reusing Migration 1's existing `sync_cursors`, `action_items`, `action_item_events`, `executions`, and `delivery_queue`) and formally sign off on `consensus/PROPOSAL.md` v2.

---

## 2. Decision table (All rows converged)

| ID | Converged Position | Status | Confidence | One-line summary |
|---|---|---|---|---|
| **D1 Agent runtime** | Samaritan Run Layer + **Claude Agent SDK** (TypeScript) in child processes behind a 5-method `WorkerAdapter` (`start`, `events`, `answer`, `cancel`, `status`); deterministic TS capabilities stay in-process; no outer OpenClaw/Hermes daemon; optional runtime trial (Hermes/OpenClaw) deferred until after Phase 2 only if a concrete gap appears. | **Agree** | High | Reuses Samaritan's TypeScript codebase and governance while isolating stuck or untrusted runs in child processes. |
| **D2 Command centre** | Extend Samaritan's React/Fastify UI (`ui/src/`) with **Now**, **Activity**, and **Tasks** views plus an **Ask/Delegate** command bar and per-source notification rules in **Settings**; keep **Inbox** as the single approval surface; separate `tasks`, `runs`, `activity_events`, and `action_items` in SQLite. | **Agree** | High | Adds the missing command centre and Cowork task delegation on top of the existing 5-view SPA and 4 schema-driven renderers. |
| **D3 Second brain** | Preserve canonical source ownership: **Obsidian vault** (`~/Documents/Obsidian/Samaritan/` + repo `journal/`) for prose and exported human-readable artifacts; **Notion** for typed DBs (Decisions, Insights, People, Projects, Jobs); **TickTick** for personal tasks; **Samaritan SQLite** (`~/.samaritan/samaritan.db`) for operational state and the derived Recall index; `~/.samaritan/artifacts/<task-id>/` for transient/raw run outputs. | **Agree** | High | Keeps one authoritative home per data type and keeps raw/transient run outputs out of git repos. |
| **D4 Cross-assistant context** | Expose one small `samaritan` MCP server (~8 tools: `get_context`, `search`, `read_artifact`, `list_inbox`, `propose_action`, `submit_task`, `task_status`, `answer_question`; **zero approval tools**) over local stdio/HTTP for Claude Code, Claude desktop, Codex, and Gemini CLI (and remote OAuth tunnel in Phase 4 for web clients), paired with one short, **static** routing doc pointed to by `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, and `~/.gemini/GEMINI.md`. | **Agree** | High | Small toolset avoids Cowork argument drops; static pointer doc avoids leaking live personal data into every repo; no MCP tool can self-approve writes. |
| **D5 Surfaces** | One Fastify + SQLite backend serving: (1) Laptop Web UI (`127.0.0.1:4173`), (2) Responsive phone web over Tailscale HTTPS with real authentication in Phase 1 (installable as PWA in Phase 2), and (3) one **Samaritan Telegram Bot** (outbound alerts in Phase 1; inbound buttons, capture, notes, task submission, and answers in Phase 2). Coding sessions stay in Claude Remote Control, linked from Activity. | **Agree** | High | Answering or approving on any surface resolves the exact same revision-checked record everywhere. |
| **D6 Hosting** | Current Mac under `launchd` with sleep disabled (`caffeinate -dis`), local DB backups, and reboot/FileVault/Keychain health checks; keep `MailMCP` and `Nutgraf` (`the-library`) on AWS. | **Agree** | High | Matches Sandip's direct choice and keeps local access to `chat.db`, vault, repo journals, Keychain, and USB WebDriverAgent. |
| **D7 Integrations** | Official API/MCP first, Mac-local second, Thornhill phone third, unofficial bridges last. Phase 1 ships Google Calendar sync + Fireflies/Granola/pasted notes + minimal source-linked Recall lookup + TickTick OAuth adapter + Claude Code HTTP hooks (`POST /api/activity`). Treat Oura `daily_stress` as a daily summary (no 30m polling) and WhatsApp as a read-only companion digest on the agent phone. | **Agree** | High | Grounds every integration in verified API capabilities and avoids main-number WhatsApp ban risk. |
| **D8 Phone control** | Thornhill is Samaritan's phone executor service (`phone.task` adapter, `guided` or `assisted` mode), retaining its own device pool, account locks, 30-day screenshot logs, and `memory/apps/` routines on the Mac, while Samaritan owns user-facing task identity, questions, approvals, and Telegram delivery. Use WDA/mobile-mcp now; evaluate ESP32 when hardware arrives. | **Agree** | High | One user-facing brain and approval flow with clean executor separation via correlated `task_id` / `run_id`. |
| **D9 Trust and safety** | Samaritan owns final domain approvals; enforce Meta's Rule of Two (untrusted email/message/web readers run in scoped child workers with restricted tools/paths/credentials and zero write/send credentials, emitting only proposed Action Items); bind approvals to exact `payload_hash`/revision and account; derive `actor` from authenticated human sessions; child-process kill + lease fencing for Stop; **no auto-approve on silence/timeout**. | **Agree** | High | Prevents prompt-injected self-approval, stale-draft execution, and zombie background writes. |
| **D10 Build sequence** | **Phase 0 (2-3 days):** `launchd` daemon, `node-cron` with unique admission keys, Migration 6, `TelegramDelivery.flush()`, child-process Stop + fencing, server-derived `actor` auth, `dailyNotePath()` IST fix. **Phase 1 (~1 week):** Meetings workflow (Calendar sync -> pre-meeting Recall brief -> post-meeting outbound nudge -> pasted notes or Fireflies/Granola transcript -> Inbox review -> TickTick guided/automated + Notion/vault write), minimal authenticated phone web over Tailscale, and Claude Code waiting alerts via HTTP hooks. **Phase 2 (1-2 weeks):** Agent SDK worker; Now/Activity/Tasks UI; Telegram inbound; local `samaritan` MCP + static pointer files; PWA install. **Phase 3:** Morning plan, Email/Recruiters (`MailMCP` + `job_tracker`), `scrask-bot`, WBR, PostHog, Nutgraf brief, bills, Oura/Hevy proposals, iMessage digest. **Phase 4:** Thornhill adapter, WhatsApp companion digest, remote OAuth MCP, music. | **Agree** | High | Sequenced so operational safety precedes scheduled jobs, and the #1 meeting workflow ships in Week 1. |
| **C1 = G1 One brain** | One user-facing planner, task authority, approval inbox, and Telegram bot in Samaritan; Thornhill, Nutgraf, and MailMCP keep their service-local state correlated by ID. | **Agree** | High | Merged C1 and G1 with Codex's storage boundary clarification. |
| **G2 Prerequisite fixes** | Fix `TelegramDelivery.flush()` caller, child-process timeout termination + lease fencing, `dailyNotePath()` IST timezone, startup crash reconciliation, and authenticated `actor` identity in Phase 0. | **Agree** | High | Verified by all three agents in the current Samaritan codebase. |
| **C2 Billing** | Interactive work stays on subscription limits; unattended daemon runs use a Console API key (drawing on Max monthly API credits where eligible) with per-run and daily spend caps logged in `runs`, skipping inference when `sync_cursors` show no change. | **Agree** | High | Predictable cost control aligned with Anthropic's October 2026 Agent SDK and Max credits policy. |

---

## 3. What changed since my last round

1. **Adopted Claude's static context file rule (`D4`, `claude/round-2.md` §4.3):** Replaced my Round 1/2 auto-regenerated `BRAIN_INDEX.md` with a short, static routing document in the vault (pointed to by `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, and `~/.gemini/GEMINI.md`). Live schedule, decisions, and inbox state are fetched on demand via `get_context` / `search`.
2. **Adopted the 4-table Migration 6 refinement (`D2`, `consensus/PROPOSAL.md` v2):** Reusing `sync_cursors`, `delivery_queue`, `action_item_events`, and `executions` from `src/store/migrations.ts`, Migration 6 adds `tasks`, `runs` (with unique admission keys per logical request), `artifacts`, and `activity_events` (append-only with monotonic cursor for both task messages and run progress), plus nullable `task_id`, `run_id`, and `payload_hash` on `action_items`.
3. **Aligned Phase 1 channel dependencies (`D5`, `D7`, `D10`):** Included minimal authenticated phone web review over Tailscale, cited lookup over vault/Notion in pre-meeting briefs, and native HTTP hooks for Claude Code waiting alerts in Phase 1, with Telegram inbound moving cleanly to Phase 2.

---

## 4. Pushback on the others

None. Full three-way consensus reached and signed on `consensus/PROPOSAL.md` v2.

---

## 5. Open questions for the other agents

None.

---

## 6. Open questions for Sandip

See the merged 8-question list in `consensus/PROPOSAL.md` v2 ("Questions for you").

---

## 7. Sources

- `consensus/PROPOSAL.md` (v2), `claude/round-1.md`, `claude/round-2.md`, `claude/round-3.md`, `codex/round-1.md`, `codex/round-2.md`, `codex/round-3.md`, `gemini/round-1.md`, `gemini/round-2.md`.
