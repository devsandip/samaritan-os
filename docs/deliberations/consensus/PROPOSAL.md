# Samaritan command centre: consensus proposal

Version: v2, FINAL. Signed by all three agents with no reservations: Claude
2026-10-20 11:14 IST, Codex 11:15 IST, Gemini 11:16 IST. Body (from "The
answer" to "Sign-off") SHA-256
`3ed4a57c41a47477967b6ef1b5dd331991def78855f688d4fab857afc388069d`, checked by
Codex at signing and by Claude at 2026-10-20 11:22 IST. v1 is kept as `PROPOSAL-v1.md`.
Nothing outside `docs/deliberations` has been changed. Every implementation
step below is a proposal.

Already settled by Sandip: the first workflow is meeting context, notes and
follow-up tasks; the first host is the current Mac, which can stay on at home;
during this research, writes stay inside `docs/deliberations`.

## The answer

Build on Samaritan. Do not adopt OpenClaw or Hermes as the core, and do not
start over.

Samaritan already implements the review layer worth keeping: typed inbox items
with per-type render layouts, per-item policy, guided, assisted and automated
execution with a guided fallback when an adapter is missing, an audit trail and
a money lock. What it lacks is operation (an always-on daemon, a scheduler,
live inputs), a delegated-task layer ("do this for me", as in Cowork), an
activity view across every agent, and one small MCP server so Claude, Codex and
Gemini all reach the same memory and inbox. Add those. Run tool-using LLM work
on the Claude Agent SDK behind a small worker interface, so Hermes or OpenClaw
can replace it later if the SDK falls short. Thornhill stays the phone
executor and gives up its planned separate brain and bot.

### Why not OpenClaw, Hermes or scratch

OpenClaw and Hermes both have real task, approval and audit features. The
choice is integration cost and product fit, not an absence of features.

- **OpenClaw**: Control UI, a Workboard task board, the widest channel
  coverage. Adopting it means either two control planes or rebuilding
  Samaritan's review surfaces inside OpenClaw's sessions and approvals. Its
  generic tools API is trusted operator access, so it would need careful
  scoping per its trust-model docs.
- **Hermes**: web dashboard, a run API with approval and stop controls, cron,
  Telegram, self-written skills; approvals default to `smart`, and unattended
  runs to `deny`. The best future worker candidate. Not the core: a second
  stack (Python) and its own memory files beside the vault. Its API keeps run
  identities and marks an active run interrupted on restart rather than
  resuming it, so the durable user task still belongs to Samaritan.
- **Scratch**: Samaritan is already the custom layer worth owning. Rewriting
  an agent loop is not.

## Architecture

```
 You: laptop UI | phone web (Tailscale) | Telegram bot
 Assistants: Claude Code, Claude desktop, Codex, Gemini CLI (local MCP);
             claude.ai, ChatGPT web, Gemini app (remote MCP, later)
 Inputs: calendar, meeting notes, email, coding-agent hooks, schedules
                          |
                          v
 +-----------------------------------------------------------------+
 | Samaritan daemon on the Mac (one Node process under launchd)     |
 | scheduler | input pollers | run layer + worker adapter           |
 | tasks | runs | activity | Action Center inbox | policy | audit   |
 | delivery | recall index over vault and Notion                    |
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
| D3 Second brain | One owner per kind of data. Vault: prose and anything you would read (briefs, minutes, WBRs, PRD drafts). Notion: Decisions, Insights, People, Projects. TickTick: to-dos. Samaritan SQLite: tasks, runs, activity, inbox, audit, and a derived recall index. Raw run output goes to `~/.samaritan/artifacts/<task-id>/` and is registered by ID. Thornhill, Nutgraf and MailMCP keep their own storage. |
| D4 Cross-assistant | One MCP server, `samaritan`, about eight tools with plain schemas: `get_context`, `search`, `read_artifact`, `list_inbox`, `propose_action`, `submit_task`, `task_status`, `answer_question` (clarifications only). No approve tool. One short, static routing document in the vault, pointed to from `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` and `~/.gemini/GEMINI.md`; live state comes from `get_context`, not from a regenerated file. Local desktop and CLI clients and hosted web clients are configured and tested separately, each from a fresh session, Cowork included. |
| D5 Surfaces | One backend. Laptop: full UI. Phone: the same UI, responsive, over Tailscale HTTPS with real authentication (Phase 1), installable as a PWA later. Telegram: one bot; outbound alerts from Phase 1; inbound buttons (Approve, Edit, Snooze, Mute), capture, notes, task submission and answers from Phase 2. Coding sessions stay on Claude Remote Control; Activity links to them. The server derives the actor from the authenticated session. |
| D6 Hosting | The current Mac under launchd, sleep disabled, database backups, reached over Tailscale. Test Keychain access after a reboot before login. Show source freshness and an outage state. MailMCP and Nutgraf stay on AWS. |
| D7 Integrations | Official API or MCP first, Mac-local second, Thornhill phone third, unofficial bridges last. Phase per source in the table below. |
| D8 Phone | Thornhill remains its own service: device pool, account locks, routines, WebDriverAgent now, ESP32 when parts arrive. It shares Samaritan's task and run IDs and never approves its own stop points; those come to Samaritan's Inbox. |
| D9 Trust | Keep the policy engine, money lock and audit. Audit today means append-only triggers on `action_item_events` plus the status change and audit row written in one transaction by `transition()`; it is not a trigger on every possible `action_items` update. Any run that reads untrusted text (email, messages, web pages) gets no send or write credentials and can only propose items (Meta's Rule of Two). Child processes give termination and separation, not a sandbox: each worker also gets a restricted tool list, filesystem paths, credentials and write routes, and never a human approval session or open access to the approval UI. Approvals bind to the exact payload hash, account and revision, from an authenticated human. Cancelled or timed-out runs are fenced and cannot emit or write. Silence never approves: unanswered items stay pending or expire. Low-risk items are pre-authorized by policy, not by a timer. |
| D10 Sequence | Below, with exit criteria. Effort ranges, not dates. |
| C1/G1 One brain | Samaritan is the single user-facing planner, task ledger, approval inbox and Telegram bot. Other services keep their internal state and correlate by ID. |
| G2 Fix first | Before anything runs unattended: real cancellation with fencing, a caller for `TelegramDelivery.flush()`, local-date fix in `dailyNotePath()`, server-derived actor, restart recovery. |
| C2 Billing | Interactive work on the Claude plan. Unattended daemon runs on a Console API key with a hard monthly cap and per-run cost tracking, using Max monthly API credits if the plan has them and the org is linked. Skip model calls when inputs have not changed. |

## Data model changes (minimal)

One migration adds four tables. Codex's fuller record set
(`codex/build-blueprint.md`) is the target; add more only when the behavior
that needs it ships.

- `tasks`: delegated goals (id, goal, lane, status, revision, runner, parent,
  timestamps, result summary). States: queued, running, needs_input,
  awaiting_review, succeeded, failed, cancelled, interrupted.
- `runs`: one attempt of a capability or task (runner, remote run id, lease
  token and expiry, fencing generation, status, cost, timestamps, error), with
  a unique admission key per logical request: the schedule occurrence, the
  source event version, or the client request id. Not a shared timestamp.
- `artifacts`: registered outputs (task, run, kind, path or URL, hash).
- `activity_events`: append-only, monotonic cursor, stable event id,
  `task_id`, optional `run_id`, type, small redacted payload. Holds task
  messages and clarifications (which can exist before any run) and run
  progress, so Activity and task threads can replay after a reconnect.
- Reuse existing tables: `sync_cursors` for source cursors, `delivery_queue`
  as the outbox (add a dedupe key and channel), `executions` for write
  attempts and receipts, `action_item_events` for item audit.
- `action_items` gains nullable `task_id`, `run_id`, `payload_hash`. A task's
  question or approval is an action item, so everything that needs you stays
  in one Inbox.

## Build sequence

| Phase | What | Effort | Done when |
|---|---|---|---|
| 0 | launchd daemon, node-cron scheduler, the migration above, G2 fixes, authenticated actor | 2 to 3 focused days | Restart mid-run is reported honestly; a schedule occurrence admits one run; quiet-hours messages deliver. |
| 1 | **Your first workflow.** Calendar sync; a brief 15 minutes before each meeting with cited context from the vault and Notion (recent mail added once the daemon has its own mail credential; full semantic fusion later); an outbound Telegram nudge after it ends; notes pasted in the web UI on laptop or phone, or a Fireflies or Granola transcript; extraction into the Inbox; approved items to Notion, the vault and TickTick. Filing is guided (you confirm it by hand) until the TickTick API adapter returns a provider receipt, then automated. Minimal authenticated phone web over Tailscale. Coding-agent waiting alerts as standard Inbox cards from HTTP hooks. | about 1 focused week | Five real meetings, including one reschedule and one with no notes, go through without duplicates; restart after approval creates no duplicate task; laptop and phone show the same state. |
| 2 | Agent SDK worker; Now, Activity and Tasks views on `tasks`, `artifacts` and `activity_events`; Telegram inbound (buttons, notes, tasks, answers); local MCP server and pointer files; PWA install | 1 to 2 focused weeks | A task submitted from Claude Code or Telegram can be followed, questioned, answered and stopped from the phone. |
| 3 | One domain at a time, kept only if used: morning plan and undated-backlog nudges, email and recruiter drafts, job matches, PostHog pulse, WBR from journals, Nutgraf summary, bills from email, Oura and Hevy proposals, iMessage digest | 1 to 3 days per simple API source | Each earns its notifications by being acted on. |
| 4 | Thornhill adapter, WhatsApp digest from the agent phone, remote MCP with OAuth for claude.ai, ChatGPT web and the Gemini app, music offers | per item | |

First dependable command centre: 2 to 4 focused weeks. Full daily-life
coverage is an ongoing program.

## Integrations

| Source | Route | Phase | Limit to know |
|---|---|---|---|
| Google Calendar | API with sync tokens, polled | 1 | Calendar end does not prove you attended. |
| Meeting notes | Pasted notes; Fireflies (existing skill) or Granola | 1 | Granola: notes on Basic, transcripts on Business and Enterprise. |
| TickTick | Open API adapter | 1 | Guided until a receipt comes back. |
| Coding agents | HTTP hooks. Claude Code: Notification (`permission_prompt`, `idle_prompt`, `agent_needs_input`), Stop, SessionEnd. Codex: PermissionRequest, Stop. Gemini CLI: Notification (`ToolPermission`), AfterAgent | 1 (Claude Code), 2 (others) | A hook reports a wait; answering stays in the originating client. |
| Email | MailMCP or Gmail API, read and draft only, with a daemon credential | 3 | Never send automatically. |
| Jobs | Job-alert emails and `job_tracker` extraction | 3 | No LinkedIn scraping. |
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
  text-to-speech inside Samaritan; scraping coding-agent transcript files.

## When to revisit the runtime

Run a two-day comparison only if the SDK worker hits a concrete gap: recovery,
tools, providers, or a need for Hermes's self-written skills or OpenClaw's
channel breadth. The gap decides the candidate. Same scenarios for both:
meeting brief, follow-up extraction with approval, free-form task with a
clarifying question, restart mid-run, duplicate event, rejection, cancel. The
restart test asks for an honest durable outcome and reconciled writes, not a
transparent resume. A runtime replaces the SDK worker if it removes more code
than its bridge adds, reports progress and artifacts into Samaritan, and cannot
bypass its approvals.

## Proposed changes outside this folder (not made)

When building starts, in order: Samaritan `src/run-layer/index.ts`,
`src/delivery/index.ts`, `src/execution/adapters/obsidian.ts`,
`src/api/server.ts`, a new migration and a launchd plist; hook entries in
`~/.claude/settings.json` (then Codex and Gemini CLI); the three global
pointer files; Thornhill `docs/architecture.md` to drop its brain and bot; a
machine credential route in Nutgraf.

## Questions for you

Merged from all three agents. None blocks the architecture; 1 to 4 shape
Phases 0 and 1.

1. Which Claude plan are you on (Pro, Max 5x, Max 20x)?
2. The Mac stays on at home, you said. Is it the laptop you also carry to work?
3. Meeting notes: Fireflies, Granola, or notes you type? Which calendar?
4. Keep TickTick as the task app?
5. Monthly model budget, and a daily cap on proactive notifications?
6. Hevy Pro? Spotify, Apple Music or YouTube Music?
7. Messaging: iMessage read on the Mac, WhatsApp only from the agent phone. OK?
8. Email: drafts only. OK?

## Sources

Runtimes
- OpenClaw Workboard: https://docs.openclaw.ai/plugins/workboard
- OpenClaw Control UI: https://docs.openclaw.ai/web/control-ui
- OpenClaw trust model: https://docs.openclaw.ai/gateway/security/trust-model
- Hermes web dashboard: https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard
- Hermes API server: https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server
- Hermes programmatic integration: https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration
- Hermes security: https://hermes-agent.nousresearch.com/docs/user-guide/security/
- Claude Agent SDK: https://code.claude.com/docs/en/agent-sdk/overview (TypeScript; MCP, hooks, permissions, sessions; recommends API-key auth)

Billing
- Agent SDK with your plan: https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
- Monthly API credits for Max and Team: https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans

Clients and hooks
- Claude Code hooks: https://code.claude.com/docs/en/hooks
- Claude Code Remote Control: https://code.claude.com/docs/en/remote-control
- Codex MCP (local and hosted): https://learn.chatgpt.com/docs/extend/mcp
- Codex hooks: https://learn.chatgpt.com/docs/hooks
- Gemini CLI hooks: https://geminicli.com/docs/hooks/reference/
- Gemini CLI MCP: https://geminicli.com/docs/tools/mcp-server/
- Gemini Spark in India: https://blog.google/intl/en-in/company-news/technology/introducing-gemini-spark-your-247-personal-ai-agent-in-country/

Integrations and safety
- Google Calendar sync: https://developers.google.com/workspace/calendar/api/guides/sync
- Oura V2 schema: https://cloud.ouraring.com/v2/static/json/openapi-1.42.json
- Hevy API: https://api.hevyapp.com/docs/ (renders client-side; the Pro requirement and routine endpoints are stated in https://github.com/ewright3/hevy-py)
- Granola: https://www.granola.ai/integrations/chatgpt
- Spotify developer changes, Feb 2026: https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security
- Agents Rule of Two: https://simonw.substack.com/p/new-prompt-injection-papers-agents

Local evidence: `claude/notes/existing-systems.md`, `codex/repo-audit.md`,
`gemini/round-1.md` section 7.2.

## Sign-off

- Claude: signed v2 at 2026-10-20 11:14 IST, no reservations.
- Codex: signed v2 at 2026-10-20 11:15 IST, no reservations (`codex/round-3.md`).
- Gemini: signed v2 at 2026-10-20 11:16 IST, no reservations (`gemini/round-3.md`).

Converged in three rounds. Status recorded 2026-10-20 11:22 IST.
