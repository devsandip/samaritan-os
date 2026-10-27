# Claude, round 1

Written 2026-10-20, about 11:05 IST. Independent: I read only PROTOCOL.md,
COORDINATION.md and the other agents' STATUS, USER-ANSWERS and messages files,
not their round files. Repo facts: `notes/existing-systems.md`. Evidence with
links: `notes/research-evidence.md`. Integration detail: `notes/integrations.md`.

## 1. Recommendation in one paragraph

Do not adopt OpenClaw or Hermes as the core, and do not start over. Sandip
already built the hard, unusual part: Samaritan's Action Center (typed items,
per-item policy, audit trail, degrade-to-guided, money lock). What is missing is
plumbing, not a platform: an always-on daemon with a scheduler and event inputs,
an activity ledger that every agent reports into (Samaritan capabilities, Claude
Code sessions, scheduled tasks, Codex, Gemini, Thornhill), a "give it a task"
verb, and one small MCP server so every assistant can reach the same memory and
inbox. Run the LLM work on the Claude Agent SDK inside Samaritan's Run Layer.
Make Samaritan the single brain: Thornhill keeps its phone executor and drops
its planned separate brain, task store and Telegram bot. Build the first
workflow Sandip chose (meeting context, notes, follow-up tasks) on the current
Mac within two weeks, then widen.

```
 Askers: Sandip (laptop UI, phone PWA, Telegram) | Claude Code / Cowork / claude.ai
         | Codex | Gemini CLI | scheduled triggers | webhooks and pollers
                   |  MCP "samaritan" (<= 10 tools)  |  HTTP API  |  Telegram bot
                   v
 +----------------------------------------------------------------------------+
 | Samaritan daemon on the Mac (one Node process, launchd)                     |
 |  scheduler | event bus | run layer (Agent SDK runs) | policy | Action Center |
 |  task store | activity ledger | recall index | delivery (Telegram, push)     |
 +----------------------------------------------------------------------------+
        | execution registry: guided / assisted / automated
        v
  Notion  TickTick  Obsidian  Gmail (MailMCP)  Calendar  Hevy  Thornhill phone  ...
```

## 2. Decision table

| ID | Position | Conf. | Reason |
|---|---|---|---|
| D1 Runtime | Claude Agent SDK (TypeScript) called from Samaritan's Run Layer for LLM capabilities and ad hoc tasks. Claude Code stays the interactive coding tool. No OpenClaw, no Hermes core. Hermes stays a candidate worker later (its `/v1/runs` API with `pending_controls` could feed the Inbox). | high | Same language as Samaritan; no second memory or second inbox; Agent SDK is covered by plan limits or Max monthly credits. OpenClaw: 722 advisories, 14 critical, by 2026-10-18, huge surface. Both treat Claude as a third-party harness for billing. |
| D2 Command centre | Extend Samaritan's UI. Keep Inbox. Add three views: Now (today, what needs me, what is running), Activity (every run from every runtime: running, waiting on me, done, failed, with Stop and Mute), Tasks (a composer like Cowork: describe a job, it runs, questions and approvals come back as Inbox items). Settings gains per-source notification rules. | high | The Inbox, render schemas and audit already exist. Hermes's dashboard and OpenClaw's Control UI and Workboard are admin panels for their own agent, not a life inbox across runtimes. |
| D3 Second brain | One canonical home per kind of data. Obsidian vault: prose and every generated artifact. Notion: the four typed DBs. TickTick: tasks. Samaritan SQLite: system state (items, tasks, runs, audit) plus a derived recall index over the vault and Notion. Nothing new. | high | Already in place through `AGENT_OS.md`. Adding a framework brings its own memory (Hermes `MEMORY.md`/`USER.md`, OpenClaw stores) that would compete. |
| D4 Cross-assistant | (a) One MCP server `samaritan`, at most about ten tools with plain schemas: recall, today, list inbox, propose item, submit task, get task, answer task, log activity, capture. Local for Claude Code, Codex, Gemini CLI, Claude desktop. Remote (Streamable HTTP behind OAuth, via Tailscale Funnel or Cloudflare Tunnel) for claude.ai and ChatGPT. (b) One instructions file in the vault that each global file points to: `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`. | med | ChatGPT only reaches public HTTPS MCP servers. Gemini's consumer app takes custom MCP only through Spark (US, AI Pro/Ultra), so in India Gemini means Gemini CLI. Thornhill showed Cowork drops arguments on a 33-tool server, so keep the toolset small. |
| D5 Surfaces | Laptop: full UI on 127.0.0.1. Phone: same UI as a home-screen PWA over Tailscale. Telegram: push, approve/reject/snooze buttons, capture, submit a task, answer questions. One bot only. Coding sessions stay on Anthropic's Remote Control; Samaritan links to them. | high | iOS web push is unreliable, so Telegram does push and the PWA does reading and acting. Claude Code's Telegram channel only works while a session is open, so it cannot be the system bot. |
| D6 Hosting | Current Mac, per Sandip's answer, under launchd with sleep disabled, reached over Tailscale. Keep Nutgraf and MailMCP on AWS. Revisit a Mac mini only if the current Mac travels. | high | iMessage, the vault, Keychain and the USB phone all need a Mac. A VPS cannot reach them. |
| D7 Integrations | Official API or MCP first, Mac-local second, phone third, unofficial bridge last. Full table in `notes/integrations.md`. | med | Several brief items have hard limits: Oura stress is a daily summary, not real time; Hevy API needs Pro; WhatsApp has no personal API and bridges risk a ban. |
| D8 Phone | Thornhill becomes Samaritan's phone executor (`phone.task` action type, guided or assisted only), keeping its device pool, locks and learning layer. Use it only for the API gaps its own report lists. | med | Two brains with two task stores and two Telegram bots is the main risk in the current plans. Thornhill's task model is good; adopt it as Samaritan's task model. |
| D9 Trust | Keep the policy engine, money lock and audit. Add Meta's Rule of Two: a run that reads untrusted text (WhatsApp, iMessage, email, web) gets no send or write tools; its output is an Inbox item. Add a real Stop (abort the run, today a timeout only stops waiting), fail-closed approval timeouts, and an "auto-approve after N minutes unless I object" tier for low-risk items. Public exposure only for the remote MCP, behind OAuth, with task-level tools only. No marketplace skills. | high | Reading messages and email is the brief's biggest injection surface. |
| D10 Sequence | Phase 0, 2 to 3 sessions: daemon under launchd, node-cron scheduler, Telegram on with a scheduled flush, real Stop. Phase 1, about 4 sessions: Sandip's first workflow (calendar poller, meeting prep 15 min before, post-meeting nudge, `meeting` extraction to Inbox, approved items to TickTick and Notion) plus Claude Code hooks to the activity ledger and a morning brief. Phase 2, about 5 sessions: Activity and Tasks views on the Agent SDK, local `samaritan` MCP, PWA, pointer files. Phase 3: email triage, job search, iMessage digest, bills from email, Oura and Hevy, Nutgraf. Phase 4: Thornhill adapter, WhatsApp via the agent phone, remote MCP with OAuth, music. | med | Sessions mean focused Claude Code sessions; Samaritan v0 took one sitting. Each phase leaves something he uses daily. |
| C1 One brain | Samaritan is the only planner, task store, approval inbox and Telegram bot. Thornhill, Nutgraf and MailMCP are services it calls. | med | See D8. Proposed as a new ID. |
| C2 Billing | Unattended Agent SDK runs use a Console API key funded by the Max monthly credits, with a spend cap; interactive work stays on the plan. | low | Credits are explicitly sanctioned for the SDK; the plan-limit path for the SDK was "paused", which can change. Depends on his plan. |

## 3. What changed since my last round

First round.

## 4. Pushback on the others

Nothing read yet. One pre-emptive note on a fact I expect will come up: Codex
is right that Hermes has a real dashboard and a run API with approvals, and that
OpenClaw has Workboard. I checked both. Neither changes my D1: Hermes's
dashboard is an admin panel bound to loopback with no login by default, and its
approvals are per command, off by default; Workboard describes itself as
"intentionally small" and scoped to one OpenClaw gateway.

## 5. Open questions for the other agents

1. If you recommend Hermes or OpenClaw as the core, what happens to the
   Action Center's typed items and per-item policy, to the Obsidian vault as
   memory, and to Claude billing as a third-party harness?
2. Do you agree Thornhill should not have its own brain? If not, how do two
   task stores and two Telegram bots stay consistent?
3. Is there a lighter path to D5 than a PWA (for example Telegram Mini Apps)?
   I have not researched it.
4. Can anyone confirm Codex CLI and Gemini CLI hook events good enough to
   detect "waiting for input"?

## 6. Open questions for Sandip

Also in `QUESTIONS.md`.

1. Which Claude plan are you on (Pro, Max 5x, Max 20x)? It decides C2.
2. Does the current Mac stay at home, or is it the laptop you carry?
3. Thornhill: fine to make it Samaritan's phone executor, or do you want it to
   stay a separate product with its own brain?
4. Fireflies or Granola for meeting notes? Do you have Hevy Pro and Spotify
   Premium?
5. WhatsApp: is a read-only digest from the agent phone enough, and do you
   agree never to run an unofficial bridge on your main number?
6. Email: drafts only (my recommendation), or should anything ever send?

## 7. Sources

See `notes/research-evidence.md` for every claim with its link. Main ones:

- https://clawdocs.org/security/known-vulnerabilities
- https://docs.openclaw.ai/plugins/workboard
- https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard
- https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server
- https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/channels
- https://code.claude.com/docs/en/remote-control
- https://coworker.ai/blog/chatgpt-mcp
- https://www.usecarly.com/blog/gemini-mcp/
- https://simonw.substack.com/p/new-prompt-injection-papers-agents
- Local: `samaritan/journal/INDEX.md`, `samaritan/docs/COMPETITIVE-LANDSCAPE.md`,
  `esp32-iphone-agent/docs/architecture.md`, `esp32-iphone-agent/WORKLOG.md`,
  `the-library/docs/architecture.md`
