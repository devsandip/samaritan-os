# What already exists (read 2026-10-20)

Facts from the repos under ~/Developer. Positions are in `../round-1.md`.

## Samaritan (`~/Developer/samaritan`), last commit 2026-07-21

- Node 24, TypeScript, Fastify, `node:sqlite`, zod, React SPA on 127.0.0.1:4173.
- Built: Action Center (ingest, lifecycle, approve/edit/reject/defer, audit trail
  enforced by SQLite triggers), Policy Engine v0 with a hardcoded money lock,
  manifest-driven capability registry, routing table, execution registry with
  degrade-to-guided, Run Layer, six capabilities (`wrap`, `meeting`,
  `newsletter-digest`, `email-triage`, `weekly-digest`, `subscription-watch`),
  `samaritan seed`, `import-task` (Claude scheduled task to capability),
  Dashboard on real telemetry, Telegram delivery with quiet hours (written,
  tested, disabled by default). 330 tests.
- Not built: daemon under launchd, scheduler (every cron is a declaration),
  event bus and listeners (no Gmail poller, no Fireflies webhook, no file
  watch), Recall query surface (chunker, embedder and sqlite-vec index exist;
  no fusion, no indexer job, no `/api/recall`), assisted adapters (no Gmail
  draft, no calendar hold), connections grid.
- Notion adapters are live; TickTick is guided-only.
- `plugin/skills/` holds the eight Claude skills that actually run day to day
  (capture, log, decision, file, meeting, wrap, recall, weekly). They implement
  `AGENT_OS.md` at the vault root (`~/Documents/Obsidian/Samaritan/`) and write
  to Obsidian, Notion and TickTick. These are installed in Sandip's Claude
  account (they show up as `samaritan:*` skills).
- `docs/COMPETITIVE-LANDSCAPE.md` (2026-07-20): OpenClaw and Hermes ship the
  same topology; what is unclaimed is typed emitted items with a render schema,
  per-item policy, the execution registry, degrade-to-guided, earn-autonomy.

## Thornhill (`~/Developer/esp32-iphone-agent`), last commit 2026-10-19

- Spare iPhone 13 driven today by Xcode + WebDriverAgent through one shared
  mobile-mcp server on the tailnet (port 10000, bearer token). ESP32-S3 HID
  route planned, parts not arrived. Android over ADB planned for phase 2.
- Works from Claude Code. Fails from Cowork: tool calls arrive with empty
  arguments for the 33-tool server; a 4-tool server works.
- Designed, not built: a "brain" service (task store in SQLite, planner on the
  Claude Agent SDK, questions and approvals), a `thornhill` MCP front door
  (about 7 task tools), its own Telegram bot, an HTTP API, a phone gateway with
  device pool, account locks, approvals, audit and a learning layer.
- Open decisions in its latest resume: brain framework (Agent SDK vs API tool
  runner), API key vs `ant auth login`, v1 question channel.
- `reports/Phone agent offload tasks India.md`: which jobs belong on the phone
  (Blinkit carts, WhatsApp triage, post-order support, bills-due sweep,
  rewards, ride fares, slot hunting, returns, society apps, wndr.ist QA) and
  which should use official MCPs instead (Swiggy, Zepto, Zomato, Gmail,
  iMessage on the Mac).
- Rules: no banking, UPI, password or authenticator apps on the agent phone;
  never pay, send or accept terms without approval.

## Nutgraf, formerly The Library (`~/Developer/the-library`), last commit 2026-10-19

- Single-user newsletter reader at sandip.dev/nutgraf. AWS CDK: S3, CloudFront,
  API Gateway + Lambda, DynamoDB, Cognito (TOTP required), EventBridge ingest
  from Gmail every 2 hours.
- Claude enrichment: summaries, News or Learning shelf, topics, story index
  across newsletters, "day in brief" narrative (P2.6). "Jev" is its classifier.
- Audio briefing (Claude script, Polly, private podcast RSS in S3) is Phase 3,
  not built. No MCP server. The API takes a Cognito JWT, so an agent needs a
  machine credential path to call it.

## Other relevant folders

- `MailMCP`: self-hosted multi-account Gmail MCP on AWS, live, about $1/month.
  Same tool names as Claude's Gmail connector. Already connected in Claude.
- `clawhub/scrask-bot`: Sandip's published OpenClaw skill (screenshot to
  calendar/tasks). Evidence he has run OpenClaw.
- `healthAI`: AI fitness coach PRD and mockups (Apple Health, Oura, Hevy). No code.
- `job_tracker`: local Python web app, job URL to Claude extraction to Notion.
- `hermes`: empty folder.
- `PM_Obs`: agent-team prompts for a planning workflow.
