# Samaritan command centre: consensus proposal

Version: v1, drafted by Claude at 2026-10-20 11:04 IST from all three round 2 reports
(`claude/round-2.md`, `codex/round-2.md`, `gemini/round-2.md`).
Status: awaiting sign-off from Codex and Gemini. Amendments go in your round 3
file; I fold them into v2. Nothing outside `docs/deliberations` has been
changed. Every implementation step below is a proposal.

## The answer

Build on Samaritan. Do not adopt OpenClaw or Hermes as the core, and do not
start over.

Samaritan already has the part no framework ships: an approval inbox with typed
items, per-item policy, an audit trail, degrade-to-guided execution and a money
lock. What it lacks is operation (an always-on daemon, a scheduler, live
inputs), a delegated-task layer ("do this for me" like Cowork), an activity view
across every agent, and one small MCP server so Claude, Codex and Gemini all
reach the same memory and inbox. Add those. Run tool-using LLM work on the
Claude Agent SDK behind a small worker interface, so Hermes or OpenClaw can
replace it later if the SDK falls short. Thornhill stays the phone executor and
gives up its planned separate brain and bot.

### Why not OpenClaw, Hermes or scratch

- **OpenClaw**: real Control UI and a Workboard task board, the widest channel
  coverage. But it is an agent product with its own sessions, memory and
  approvals, so adopting it means two control planes or rebuilding Samaritan's
  review surfaces inside it. Its generic tools API is trusted operator access.
  Its security record is heavy (a third-party tracker counts hundreds of
  advisories since January 2026, most fixed; use its trust-model docs, not the
  count, if it is ever revisited).
- **Hermes**: real web dashboard, a run API with approval and stop controls,
  cron, Telegram, self-written skills, `smart` approvals by default and `deny`
  for unattended runs. It is the better future worker candidate. Not the core:
  another stack (Python), its own memory files competing with the vault, and
  runs that do not survive a gateway restart, so durability would still be
  Samaritan's job.
- **Scratch**: Samaritan is already the scratch build worth keeping. Rewriting
  an agent loop is not.

## Architecture

```
 You: laptop UI | phone web (Tailscale) | Telegram bot
 Assistants: Claude Code, Claude desktop, Codex, Gemini CLI (local MCP);
             claude.ai, ChatGPT web, Gemini app (remote MCP, later)
 Inputs: calendar, meeting notes, email, Claude Code hooks, schedules
                          |
                          v
 +-----------------------------------------------------------------+
 | Samaritan daemon on the Mac (one Node process under launchd)     |
 | scheduler | input pollers | run layer + worker adapter           |
 | tasks | runs | Action Center inbox | policy | audit | delivery   |
 | recall index over vault and Notion                               |
 +-----------------------------------------------------------------+
        | execution registry: guided / assisted / automated
        v
 Notion  TickTick  Obsidian  Gmail (MailMCP)  Calendar  Nutgraf  Thornhill
```

## Decisions

| ID | Decision |
|---|---|
| D1 Runtime | Samaritan orchestrates. Deterministic capabilities stay as functions. Tool-using work runs on the TypeScript Claude Agent SDK behind a worker adapter with five methods: `start`, `events`, `answer`, `cancel`, `status`. Workers run in child processes. No framework trial before the meeting milestone; see "When to revisit". |
| D2 Command centre | Extend the existing React UI. Views: **Now** (today, what needs you, what is running), **Inbox** (unchanged, the only review surface), **Activity** (every run from every source, with Stop), **Tasks** (describe a job, follow it, answer its questions), **Settings** (per-source notification rules). An Ask/Delegate command bar on every view. Mute, snooze and pause are separate: muting silences delivery, never the job. |
| D3 Second brain | One owner per kind of data. Vault: prose and anything you would read (briefs, minutes, WBRs, PRD drafts). Notion: Decisions, Insights, People, Projects. TickTick: to-dos. Samaritan SQLite: tasks, runs, inbox, audit, and a derived recall index. Raw run output goes to `~/.samaritan/artifacts/<task-id>/` and is registered by ID. Thornhill, Nutgraf and MailMCP keep their own storage. |
| D4 Cross-assistant | One MCP server, `samaritan`, about eight tools with plain schemas: `get_context`, `search`, `read_artifact`, `list_inbox`, `propose_action`, `submit_task`, `task_status`, `answer_question` (clarifications only). No approve tool. One short, static routing document in the vault, pointed to from `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` and `~/.gemini/GEMINI.md`; live state comes from `get_context`, not from a regenerated file. Test discovery from a fresh session in each client, including Cowork. |
| D5 Surfaces | One backend. Laptop: full UI. Phone: the same UI, responsive, over Tailscale HTTPS with real authentication; installable as a PWA later. Telegram: one bot for push, inline Approve, Edit, Snooze and Mute, capture, task submission and answers. Coding sessions stay on Claude Remote Control; Activity links to them. The server derives the actor from the authenticated session. |
| D6 Hosting | Your current Mac under launchd, sleep disabled, database backups, reached over Tailscale. Test Keychain access after a reboot before login. MailMCP and Nutgraf stay on AWS. |
| D7 Integrations | Official API or MCP first, Mac-local second, Thornhill phone third, unofficial bridges last. Phase per source in the table below. |
| D8 Phone | Thornhill remains its own service: device pool, account locks, routines, WebDriverAgent now, ESP32 when parts arrive. It shares Samaritan's task and run IDs and never approves its own stop points; those come to Samaritan's Inbox. |
| D9 Trust | Keep the policy engine, money lock and audit. Any run that reads untrusted text (email, messages, web pages) gets no send or write credentials and can only propose items (Meta's Rule of Two). Approvals bind to the exact payload hash, account and revision, from an authenticated human. Cancelled or timed-out runs are fenced and cannot emit or write. Silence never approves: unanswered items stay pending or expire. Low-risk items are pre-authorized by policy, not by a timer. |
| D10 Sequence | Below, with exit criteria. Effort ranges, not dates. |
| C1/G1 One brain | Samaritan is the single user-facing planner, task ledger, approval inbox and Telegram bot. Other services keep their internal state and correlate by ID. |
| G2 Fix first | Before anything runs unattended: real cancellation with fencing, a caller for `TelegramDelivery.flush()`, local-date fix in `dailyNotePath()`, server-derived actor, restart recovery. |
| C2 Billing | Interactive work on your Claude plan. Unattended daemon runs on a Console API key with a hard monthly cap and per-run cost tracking, drawing Max monthly API credits if your plan has them. Skip model calls when inputs have not changed. |

## Data model changes (minimal)

Start with what the first two phases use. Codex's fuller record set
(`codex/build-blueprint.md`) is the target; add a record only when the
behavior that needs it ships.

- New `tasks`: delegated goals (id, goal, lane, status, revision, runner,
  parent, timestamps, result summary). States: queued, running, needs_input,
  awaiting_review, succeeded, failed, cancelled, interrupted.
- New `runs`: one attempt of a capability or task (runner, remote run id,
  lease token and expiry, fencing generation, `scheduled_for` with a unique key
  so a schedule fires once, status, cost, timestamps, error).
- New `artifacts`: registered outputs (task, run, kind, path or URL, hash).
- New `run_events` in Phase 2 with the Activity view (cursor, type, small
  redacted payload).
- Reuse existing tables: `sync_cursors` for source cursors, `delivery_queue`
  as the outbox (add a dedupe key and channel), `executions` for receipts.
- `action_items` gains nullable `task_id`, `run_id`, `payload_hash`. A task's
  question or approval is an action item, so everything that needs you stays
  in one Inbox.

## Build sequence

| Phase | What | Effort | Done when |
|---|---|---|---|
| 0 | launchd daemon, node-cron scheduler, `runs` table, G2 fixes, authenticated actor | 2 to 3 focused days | Restart mid-run recovers honestly; a scheduled job fires once; quiet-hours messages deliver. |
| 1 | **Your first workflow.** Calendar sync; brief 15 minutes before each meeting with cited context from vault, Notion and recent mail (minimal retrieval, no full semantic fusion yet); nudge after it ends; notes pasted, sent on Telegram, or a Fireflies or Granola transcript; extraction into the Inbox; approved items to Notion, the vault and TickTick (TickTick API adapter; guided until it returns a provider receipt). Plus Claude Code waiting alerts: HTTP hooks for `permission_prompt`, `idle_prompt`, `agent_needs_input` emit a standard Inbox card. | about 1 focused week | Five real meetings, including one reschedule and one with no notes, go through without duplicates; restart after approval creates no duplicate task; laptop and phone show the same state. |
| 2 | `tasks`, `artifacts`, `run_events`; Agent SDK worker; Now, Activity and Tasks views; Telegram inbound; phone web over Tailscale; local MCP server and pointer files | 1 to 2 focused weeks | A task submitted from Claude Code or Telegram can be followed, questioned, answered and stopped from the phone. |
| 3 | One domain at a time, kept only if used: morning plan and undated-backlog nudges, email and recruiter drafts, job matches, PostHog pulse, WBR from journals, Nutgraf summary, bills from email, Oura and Hevy proposals, iMessage digest | 1 to 3 days per simple API source | Each earns its notifications by being acted on. |
| 4 | Thornhill adapter, WhatsApp digest from the agent phone, remote MCP with OAuth for claude.ai, ChatGPT web and the Gemini app, music offers | per item | |

First dependable command centre: 2 to 4 focused weeks. Full daily-life
coverage is an ongoing program.

## Integrations

| Source | Route | Phase | Limit to know |
|---|---|---|---|
| Google Calendar | API with sync tokens, polled | 1 | Calendar end does not prove you attended. |
| Meeting notes | Fireflies (existing skill) or Granola MCP, or pasted notes | 1 | Granola transcripts need its Business plan. |
| TickTick | Open API adapter | 1 | Guided until a receipt comes back. |
| Claude Code | HTTP hooks | 1 | Codex CLI and Gemini CLI have hooks too; validate each. |
| Email | MailMCP or Gmail API, read and draft only | 3 | Never send automatically. |
| Jobs | Alert emails, Indeed MCP, `job_tracker` extraction | 3 | No LinkedIn scraping. |
| PostHog | Official MCP or query API with fixed metrics | 3 | |
| Journals and WBR | File watch on `~/Developer/*/journal/` | 3 | |
| Nutgraf | Needs a machine credential (Cognito is user login only) | 3 | Audio is Nutgraf's own planned phase. |
| iMessage | Read `chat.db` on the Mac with Full Disk Access | 3 | Read-only digest; sends guided. |
| Oura | API v2, OAuth; webhooks after the phone syncs | 3 | Stress is a daily summary. No "stressed right now" trigger. |
| Hevy | Public API, needs Hevy Pro | 3 | Write a copy of today's routine, never overwrite the plan. |
| Bills | Bank, card and statement emails | 3 | Money stays guided: reminders and links only. |
| WhatsApp | Agent phone as linked companion, read-only | 4 | No unofficial bridge on your main number; bans can be permanent. |
| Music | Apple Music on the Mac, or Spotify (Premium) | 4 | Offer a one-tap link; never auto-play. |

## Not doing

- OpenClaw or Hermes as the core; a second brain, task store or Telegram bot in
  Thornhill; Claude Code's Telegram channel as the system bot.
- An MCP tool that approves; approval on silence or by countdown.
- A context file regenerated with live personal data and loaded into every repo.
- Unofficial WhatsApp bridges on your main number; real-time stress triggers;
  text-to-speech inside Samaritan; scraping Claude Code transcript files.

## When to revisit the runtime

Run a two-day comparison (Hermes first, then OpenClaw) only if the SDK worker
hits a concrete gap: recovery, tools, providers, or a need for Hermes's
self-written skills or OpenClaw's channel breadth. Same scenarios for both:
meeting brief, follow-up extraction with approval, free-form task with a
clarifying question, restart mid-run, duplicate event, rejection, cancel. A
runtime replaces the SDK worker if it removes more code than its bridge adds,
reports progress and artifacts into Samaritan, and cannot bypass its approvals.

## Proposed changes outside this folder (not made)

When you start building, these are the edits, in order: Samaritan
`src/run-layer/index.ts`, `src/delivery/index.ts`,
`src/execution/adapters/obsidian.ts`, `src/api/server.ts`, a new migration and
a launchd plist; `~/.claude/settings.json` hooks; the three global pointer
files; Thornhill `docs/architecture.md` to drop its brain and bot; a machine
credential route in Nutgraf.

## Questions for you

Merged from all three agents. None blocks the architecture; 1 to 4 shape
Phases 0 and 1.

1. Which Claude plan are you on (Pro, Max 5x, Max 20x)?
2. Does the current Mac stay at home during the day, or do you carry it?
3. Meeting notes: Fireflies, Granola, or notes you type? Which calendar?
4. Keep TickTick as the task app?
5. Monthly model budget, and a daily cap on proactive notifications?
6. Hevy Pro? Spotify, Apple Music or YouTube Music?
7. Messaging: iMessage read on the Mac, WhatsApp only from the agent phone. OK?
8. Email: drafts only. OK?

## Sign-off

- Claude: signed, v1, 2026-10-20 11:04 IST.
- Codex: pending.
- Gemini: pending.
