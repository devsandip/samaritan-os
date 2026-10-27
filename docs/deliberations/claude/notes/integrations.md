# D7 detail: one line per source

Order of preference for every source: official API or MCP, then something local
on the Mac, then the Thornhill phone, then an unofficial bridge. Each becomes a
Samaritan capability (reads) or an execution adapter (writes).

| Source | Route | Notes and limits | Phase |
|---|---|---|---|
| Google Calendar | Calendar API poller in the daemon (OAuth, read + events scope) | Feeds meeting prep and the day plan. Holds are `assisted` (tentative event), never auto-accept. | 1 |
| Meeting notes | Fireflies (existing `meeting` skill) or Granola MCP | Granola MCP: notes on every plan, transcripts on Business; OAuth; works in Claude and ChatGPT. Either feeds the existing `meeting` capability. | 1 |
| TickTick | TickTick API adapter (Samaritan has guided-only today) | The TickTick MCP is already connected in Claude, so the OAuth app exists to copy. Promotes `task.create` from guided to automated. | 1 |
| Claude Code sessions | HTTP hooks to `POST /api/activity` | Notification matchers `permission_prompt`, `idle_prompt`, `agent_needs_input`; Stop; SessionEnd. Gives "which sessions are waiting" with cwd and a Remote Control link. Codex CLI and Gemini CLI have notify-style hooks; verify before relying on them. | 1 |
| Email | MailMCP (live, multi-account) for agent reads and drafts; Gmail history poller for events | Read + compose, never send. `email-triage` promotes from guided to assisted when a Gmail draft adapter exists. | 2 |
| Job search | Job-alert emails through MailMCP, Indeed MCP, `job_tracker` extraction | Rank against resume; Inbox item "apply?"; recruiter replies as Gmail drafts. No LinkedIn scraping (its rules name bots). | 2 |
| PostHog | Official PostHog MCP | Weekly product pulse into the WBR. | 2 |
| Journals to WBR | File watch on `~/Developer/*/journal/` | `weekly-digest` exists; add a WBR-shaped `document` item. | 2 |
| Nutgraf | Needs a machine credential (Cognito is user + TOTP only today) | Propose a read-only API key route or a small MCP on Nutgraf. Morning brief links the "day in brief" (P2.6); audio is its Phase 3 (Polly podcast RSS). | 3 |
| iMessage | Read `~/Library/Messages/chat.db` with Full Disk Access (as Claude's iMessage channel plugin does) | Read-only digest of what looks important. Sends stay guided. | 3 |
| Oura | API v2, OAuth only (personal tokens gone end of 2025); webhooks about 30 s after the phone syncs | `daily_sleep`, `daily_readiness` for the morning; `daily_stress` is a daily summary, so "you are stressed right now" is not real time. Treat stress prompts as best effort. | 3 |
| Hevy | Public API, needs Hevy Pro; create/update routines and workouts; webhook on new workout | Morning: adjust today's routine from readiness (propose, then apply on approve). Webhook: workout done triggers the day plan. | 3 |
| Bills and spending | Bank and card alert emails, statements and CAS mails through MailMCP; payment reminders from due dates | Account Aggregator data goes to regulated FIUs, not to a personal script (my understanding; unverified). Money lock stays: reminders and deep links only. Thornhill bills-due sweep later. | 3 |
| WhatsApp | Thornhill agent phone as a linked companion device, read-only digest | No official personal API. whatsmeow/Baileys bridges risk a ban on the main number, sometimes permanent. Do not run one on the primary number. | 4 |
| Music | Apple Music via AppleScript on the Mac; Spotify Web API needs Premium in dev mode (Feb 2026), 5 users, smaller endpoint set | Offer a one-tap play link in Telegram. Never auto-play. Lowest priority. | 4 |
