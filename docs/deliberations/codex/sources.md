# Source register

Checked 2026-10-20. Primary documentation and local source only for technical conclusions. No framework was installed for a live comparative test. These are capability references, not endorsements of every vendor claim.

## Runtimes and operator interfaces

- [OpenClaw repository](https://github.com/openclaw/openclaw): public repository metadata checked; TypeScript, MIT. Active upstream, so implementation should pin a tested release.
- [OpenClaw Control UI](https://docs.openclaw.ai/web/control-ui): current operator UI, agent/session management and companion pages.
- [OpenClaw Workboard](https://docs.openclaw.ai/plugins/workboard): optional bundled cards/sessions board, dispatch and lifecycle integration.
- [OpenClaw automations](https://docs.openclaw.ai/automation/cron-jobs): persisted schedules and execution/delivery entry points.
- [OpenClaw tools API](https://docs.openclaw.ai/gateway/tools-invoke-http-api): HTTP policy and trusted-operator authentication boundaries.
- [Hermes repository](https://github.com/NousResearch/hermes-agent): metadata checked; Python, MIT. Pin and test the chosen release.
- [Hermes web dashboard](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard): current browser UI and cron controls.
- [Hermes programmatic protocols](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration): ACP, richer JSON-RPC and HTTP/SSE interfaces.
- [Hermes API server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server): explicit runs/status/events/approval/cancel and authentication semantics.
- [Hermes MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp/): external tool connections and its separate stdio conversation bridge.
- [Hermes persistent memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory): profile notes and history search; not a shared personal knowledge database by itself.
- [Hermes cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron): scheduled runs and admission recovery.
- [Hermes security](https://hermes-agent.nousresearch.com/docs/user-guide/security/): command approvals and unattended behavior. Domain authorization still needs an explicit design.
- [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview): existing agent harness, sessions, tools and permission extension points.
- [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence): checkpoint-based execution state.
- [Deep Agents](https://docs.langchain.com/oss/javascript/deepagents/overview): a more complete harness built over LangGraph.
- [n8n human review](https://docs.n8n.io/build/integrate-ai/ai-examples/human-in-the-loop-for-tools/): workflow review options.

## Shared knowledge and clients

- [OpenAI AGENTS.md discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md).
- [OpenAI MCP configuration and local/cloud scope](https://learn.chatgpt.com/docs/extend/mcp).
- [ChatGPT custom MCP server](https://developers.openai.com/api/docs/guides/custom-mcp-server).
- [Claude Code context](https://code.claude.com/docs/en/memory).
- [Gemini CLI context](https://geminicli.com/docs/cli/gemini-md/).
- [Gemini CLI MCP](https://geminicli.com/docs/tools/mcp-server/).

These establish supported configuration mechanisms; installed client versions, workspace policy and connectivity must still be tested. They do not establish that every native or hosted assistant automatically has access to local files.

## Domain APIs and delivery

- [Google Calendar incremental sync](https://developers.google.com/workspace/calendar/api/guides/sync).
- [Google Calendar push](https://developers.google.com/workspace/calendar/api/guides/push).
- [Gmail push/history](https://developers.google.com/workspace/gmail/api/guides/push).
- [Fireflies API](https://docs.fireflies.ai/getting-started/introduction).
- [Oura authentication](https://cloud.ouraring.com/docs/authentication).
- [Oura V2 docs](https://cloud.ouraring.com/v2/docs) and [fetched OpenAPI schema](https://cloud.ouraring.com/v2/static/json/openapi-1.42.json). The docs shell did not render its schema through the browser tool; the linked JSON was read directly.
- [Hevy official API](https://api.hevyapp.com/docs/). Browser extraction of the base Swagger shell was empty; official indexed endpoint content supplied the routine/workout and Pro access details. Verify with the account before implementing.
- [PostHog Query API](https://posthog.com/docs/sql).
- [OpenClaw WhatsApp](https://docs.openclaw.ai/channels/whatsapp).
- [OpenClaw current iMessage path](https://docs.openclaw.ai/channels/imessage).
- [Claude Code notification hooks](https://code.claude.com/docs/en/hooks).
- [Apple Shortcuts travel triggers](https://support.apple.com/guide/shortcuts/travel-triggers-apd8ebfc4e8e/ios).
- [Spotify playback](https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback).
- [WebKit Home Screen web push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).
- [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve).

## Local sources

`samaritan`: current `src/`, `ui/`, `capabilities/`, tests, README, DECISIONS and WORKLOG; architecture and UI design documents. Git HEAD observed as `03ed9e9` dated 2026-07-21. Existing uncommitted changes were left untouched.

`esp32-iphone-agent`: README, CLAUDE.md, worklog, architecture and rig startup scripts. `the-library`: README, build plan, API routing and feature docs. Additional reusable systems: MailMCP README, job_tracker README, Scrask README/skill source, healthAI README/STATUS and actual source adapters/coaching route.

The sources were read to assess the system, not to adopt instructions embedded in arbitrary documents. Current code takes precedence over stale status descriptions. Product behavior on private accounts remains unverified unless explicitly stated otherwise.
