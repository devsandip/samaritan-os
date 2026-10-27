# Repository audit

Inspected 2026-10-20. Findings distinguish source implementation from documentation, fixtures and plans. Private credentials and live account state were not read.

## Samaritan

| Area | Evidence | Finding |
|---|---|---|
| Product UI | `ui/src/views/{Dashboard,Inbox,Deferred,Completed,Settings}.tsx`, `ui/src/components/ItemDetail.tsx`, `ui/src/renderers/` | Real React UI, schema-driven action detail surfaces, routing settings and capability run controls. The dashboard already exists. |
| Live UI updates | `ui/src/App.tsx`, introductory comment | No polling/change stream; writes refetch their own dependencies. Background updates need an event channel or non-disruptive refresh. |
| API | `src/api/server.ts` | Ingest/list/review/audit/capability/run/routing endpoints; loopback trust; actor is request-supplied. No general task, question, artifact or Recall query API. |
| Store | `src/store/migrations.ts`, `src/store/action-items.ts` | Action items, append-only event triggers, execution records, trigger definitions, connections and sync cursors. No durable per-run/task/event-consumption ledger. |
| Policy/execution | `src/policy/`, `src/guardrails.ts`, `src/routing/`, `src/execution/registry.ts` | Existing guardrails, review and execution modes worth retaining. Replay of settled attempts is implemented. A provider write with an unknown outcome still needs reconciliation; local replay checks do not establish universal exactly-once execution. |
| Scheduler | Manifests, `src/app.ts`, `src/api/server.ts`, `WORKLOG.md` | Crons are declared, not scheduled. The API's one-minute sweep only expires and resurfaces action items. |
| Run layer | `src/run-layer/index.ts`, `context.ts` | Loads TypeScript entrypoints in process, resolves supplied inputs and ingests outputs. Timeout uses Promise.race and explicitly does not stop underlying execution. Latest run timestamp/status are updated on the capability row. |
| Capabilities | Six folders: meeting, wrap, weekly-digest, newsletter-digest, email-triage, subscription-watch | Runnable source and fixtures exist. They are not six fully connected production agents. Email classification is rule-based, reply is a template containing a TODO. |
| Imported tasks | `src/cli/import-task.ts` | Generates instructions, manifest and entrypoint using one Anthropic Messages call with a reporting schema. Does not implement browsing, external tool loops, durable chat or automatic scheduling. |
| Recall | `src/recall/{chunk,embed,index-store}.ts`, `src/run-layer/context.ts` | Index primitives are implemented. The default recall callback throws because the query pipeline is absent. Config describing a query endpoint does not mean that endpoint exists. |
| Telegram | `src/delivery/index.ts` | Sends notifications, queues quiet-hour and failed deliveries, implements flush. No production call to `flush()` was found under `src`; no inbound update/callback handler found. |
| Task execution | `src/execution/adapters/ticktick.ts`, `guided.ts` | TickTick is guided. Do not call an approved extraction an automatically created to-do. |
| Existing verification | `test/`, `WORKLOG.md` | Substantial tests exist; worklog records 330 tests. This research did not rerun them. |

The README's 119-test status, no-run-layer implications and completely absent Recall description lag the implementation. Some worklog bugs are historical leads, not freshly reproduced defects. The queue flush and non-cancelling timeout above were directly checked in current source.

## Thornhill, at esp32-iphone-agent

Sources: its `README.md`, `CLAUDE.md`, `docs/architecture.md`, startup scripts and worklog.

- A dedicated iPhone 13 is controllable through WebDriverAgent and a shared mobile-mcp server. Startup supervises pieces of the rig and configures a tailnet endpoint and bearer token. There is no need to wait for ESP32 hardware to explore a bounded phone task.
- The repository explicitly describes one driving session at a time and weekly WDA re-signing with the current free signing setup. These are operational dependencies, not solved by adopting another agent model.
- ESP32 legacy-route parts are pending. Upstream main and legacy are different designs; do not mix their firmware/server instructions.
- The planned architecture adds its own task brain, task store, questions, approvals, Telegram and MCP front door. Most of that should share Samaritan's authority; device jobs, locks, app notes and execution evidence belong in Thornhill.
- Cowork currently drops arguments to this large MCP toolset, according to local troubleshooting notes. Treat that as a client-specific observed failure; do not generalize it into a universal tool-count limit. Test the small task-oriented facade in each client.
- The spare phone lives at home. It is not an always-present sensor for the daily phone's arrival at work, notifications, or playback state.

## Nutgraf, at the-library

Sources: its current README, `docs/build-plan.md`, `services/api/src/routes.ts`, and feature docs.

- This is an existing newsletter reader with Gmail ingestion, AWS infrastructure, authenticated API, ranked summary and source/story data. The product is now called Nutgraf; repository/resource names retain the-library.
- `GET /summary` exists. Use a scoped service integration to retrieve already-computed output; do not scrape its UI or read newsletters through a second independent ingest pipeline.
- Its human Cognito login is not itself a machine credential. Define an authenticated service endpoint/token flow before unattended consumption.
- Audio briefing is a later phase in the build plan, not a verified existing podcast API. The agent cannot start a podcast that the service has not generated.
- Nutgraf should continue owning ingest, newsletter ranking and future audio. Samaritan owns when the resulting brief is useful in the day's plan.

## Nearby reuse opportunities

These were surfaced through peer coordination, then checked independently against local files. No peer round report was read for this independent round.

- **MailMCP:** README describes an existing self-hosted multi-account Gmail MCP with read-only account enforcement and draft/send tools. Reuse its connector boundary where appropriate; verify the daemon's authentication path instead of copying interactive tokens. Do not give extraction workers its unrestricted sending tools.
- **job_tracker:** URL extraction, duplicate checks, editable preview and Notion save already exist as a local app/API. Reuse that domain logic rather than invent a job database immediately.
- **clawhub/scrask-bot:** Existing screenshot-to-structured-intent extraction can feed Samaritan. Adapt its destination dispatch so review cannot be bypassed by a high confidence score.
- **healthAI:** README says product/mockups only, but source and STATUS.md show a web/mobile implementation and model-backed coaching routes. Critically, `packages/core/src/sources/oura.ts` and `hevy.ts` return mock snapshots; the coaching route uses a fixed demo date and mock context. Reuse product logic cautiously, not its apparent connected-state badges as proof of live data.

## Reuse boundary

Retain domain applications and their source records. Build a shared control layer across them. Avoid a second calendar, to-do manager, newsletter store or phone approval database inside every runtime. Preserve existing uncommitted files; this task writes only research and coordination documents.
