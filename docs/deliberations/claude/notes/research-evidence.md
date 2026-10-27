# Research evidence for round 1 (checked 2026-10-20)

Each line: claim, then source. "Single source" means I found one source only.

## Runtimes

- OpenClaw repo had 722 published security advisories as of 2026-10-18: 14
  critical, 249 high. Latest stable 2026.10.4 (2026-10-16) is at or above every
  published fix. https://clawdocs.org/security/known-vulnerabilities
- OpenClaw 2026.10.10-beta.1 (2026-10-15): Control UI sidebar and session
  inspector, Workboard gets an experimental Postgres store, exec approval
  ownership separated from node policy, now requires macOS/iOS/Safari 26.2+.
  https://releasebot.io/updates/openclaw
- OpenClaw Workboard: "bundled but disabled by default", Kanban cards linked to
  task, run and session; "intentionally small", "tracks local operating work for
  one OpenClaw Gateway". https://docs.openclaw.ai/plugins/workboard
- OpenClaw new web UI (2026.8.1): chat-centred, sessions grouped by project or
  person, approvals inline in the conversation that raised them, mobile drawer.
  https://docs.openclaw.ai/releases/2026.8.1/the-new-web-ui.md
- Hermes web dashboard: `hermes dashboard`, 127.0.0.1:9119, pages for status,
  chat (embedded TUI), sessions, cron, config, logs, skills, MCP, webhooks,
  channels. No login on loopback; auth gate only on non-loopback bind. "Use it
  only on a trusted network or behind a VPN". No mobile app.
  https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard
- Hermes API server: OpenAI-compatible `/v1/chat/completions`, `/v1/responses`,
  plus `/v1/runs` with SSE events and `stop`, `approval`, `clarify` routes;
  `pending_controls` on a run; bearer key required; default 127.0.0.1:8642.
  https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server
- Hermes releases: v0.21.6 (2026-10-08) dashboard auth hardening and an email
  sender-allowlist bypass fix; v0.22.0 (2026-10-14) connectors, plugin catalog,
  memory providers moved to plugins. https://www.gradually.ai/en/changelogs/hermes-agent/
- Hermes about 255k GitHub stars on 2026-10-19 (third-party guide citing the
  GitHub API). Approval policies for destructive commands are off by default.
  https://hermesatlas.com/guide/ (single source for both)

## Anthropic billing and policy

- 2026-04-04: Pro/Max limits no longer cover third-party harnesses such as
  OpenClaw; they need extra usage or an API key.
  https://thenextweb.com/news/anthropic-openclaw-claude-subscription-ban-cost
- Support article, current: "You can still use the Claude Agent SDK, claude -p,
  and third-party apps with your subscription limits." June 15 update: planned
  Agent SDK change paused. October 7 update: "Claude Max and Team plans now
  include monthly API credits."
  https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
- Monthly credits: Max 5x $100, Max 20x $200, Team up to $500 pooled; cover the
  Claude API, Agent SDK, Managed Agents; not Claude Code; no rollover. Agent SDK
  or `claude -p` on a Console API key draws credits; signed in with the plan it
  draws plan limits. https://qcode.cc/en/claude-max-team-api-credits ,
  https://x.com/ClaudeDevs/status/2107895957933408429
- The two statements above (April third-party restriction vs current support
  text) are in tension. I read the current support article as authoritative and
  the credits as the stable path. Flagged for the others to check.

## Anthropic surfaces that already cover parts of the brief

- Claude Code hooks: events include Notification (matchers `permission_prompt`,
  `idle_prompt`, `agent_needs_input`, `agent_completed`, elicitation), Stop,
  SessionStart, SessionEnd. Hooks can be `type: "http"` and POST the event JSON;
  every event carries `session_id`, `cwd`, `transcript_path`. SessionStart does
  not support HTTP hooks. https://code.claude.com/docs/en/hooks
- Claude Code channels (research preview): MCP server pushes events into a
  running session; Telegram, Discord, iMessage plugins; events only arrive while
  the session is open; permission relay available.
  https://code.claude.com/docs/en/channels
- Remote Control: drive a local Claude Code session from claude.ai/code or the
  mobile app; Pro/Max/Team/Enterprise; API keys not supported; sessions appear
  in the claude.ai/code session list. https://code.claude.com/docs/en/remote-control
- Dispatch (Cowork, research preview): one persistent thread from phone to the
  desktop app, uses local files and connectors; desktop must stay awake; no
  completion notifications; one thread.
  https://support.claude.com/en/articles/13947068-assign-tasks-to-claude-from-anywhere-in-cowork

## Cross-assistant MCP

- ChatGPT: custom remote MCP through Developer Mode on paid plans; server must
  be public HTTPS (SSE or Streamable HTTP), OAuth or no auth; cannot reach a
  local or private-network server directly; OpenAI's Secure MCP Tunnel is the
  documented workaround. https://coworker.ai/blog/chatgpt-mcp (2026-07-16,
  updated 2026-10-15)
- Gemini consumer app: custom MCP only through Gemini Spark, personal accounts,
  AI Pro (US, English) and Ultra. Gemini CLI reads MCP servers from its own
  config. https://www.usecarly.com/blog/gemini-mcp/ (2026-08-27, single source)
- Obsidian CLI shipped in desktop 1.12.4 (2026-02-27); needs the app running;
  commands for search, read/create/append, daily notes, properties, Bases,
  tasks. https://obsidian.md/changelog/2026-02-27-desktop-v1.12.4/ ,
  https://obsidian.md/help/cli
- Thornhill's own finding: Cowork drops arguments for a 33-tool MCP server; a
  4-tool server works. `esp32-iphone-agent/WORKLOG.md`, 2026-10-18.

## Safety

- Meta's Agents Rule of Two (2025-10-31): in one session an agent should have at
  most two of [A] untrustworthy input, [B] access to sensitive systems or
  private data, [C] ability to change state or communicate externally; if all
  three are needed, require human supervision.
  https://simonw.substack.com/p/new-prompt-injection-papers-agents

## Phone surface

- iOS web push works only for home-screen web apps (iOS 16.4+), permission from
  a user gesture, subscriptions can silently disappear.
  https://webscraft.org/blog/pwa-pushspovischennya-na-ios-u-2026-scho-realno-pratsyuye?lang=en
