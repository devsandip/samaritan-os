# 2026-10-27 20:55 - The Command Centre and the pure seam across twenty-one capabilities

## Context

After the three-model deliberation converged on `PROPOSAL-v1.md`, the work was to turn Samaritan from a six-capability review inbox into the single personal Command Centre across Web UI, Telegram, and the eight-tool cross-assistant MCP server, and then to replace every thin capability scaffold with real domain logic before merging to `main`.

## Decisions

- Kept the Action Center as the single approval gate across all surfaces. MCP exposes eight read, search, task-delegation, and proposal tools and zero approval tools. Child worker processes have provider write credentials stripped from their environment (`sanitizeWorkerEnv`) and can only propose side effects over IPC.
- Extended the pure-decision / thin-shell split to every Phase 3 and Phase 4 capability (`scanMultiRepoJournals`, `evaluatePrdMultiLens`, `evaluatePosthogMetrics`, `computeReadinessCoaching`, `parseBillEmail`, `extractEventFromScreenshotText`, `detectCalendarConflicts`, `isHighSignalImessage`, `verifySlackSignature`) and to Recall's structured SQL mirror search (`structuredRetrieve`).
- Preserved honest labels on Recall answers: `retrieval_path` reports `"semantic"` when only vector and FTS5 chunks match, `"structured"` when only mirror tables (`notion_decisions`, `notion_insights`, `ticktick_tasks`, `calendar_events`) match, and `"hybrid"` when both contribute passages.
- Treated `null` or `undefined` analytics values in `posthog-pulse` as `data_missing` rather than `0` so a broken event pipeline never pages as a metric crash.

## Direction changes

- Was a single-surface web inbox with six capabilities and semantic-only Recall; now a five-view Command Centre (`Now`, `Inbox`, `Tasks`, `Activity`, `Settings`) with twenty-one capabilities, delegated worker tasks, bidirectional Telegram, an eight-tool MCP server, and hybrid structured-plus-semantic Recall scoped by `work` and `personal`.

## Needs revisit

- Evaluate live Oura V2 and Hevy routine copy thresholds after two weeks of real morning runs.
- Measure Thornhill mid-call stop-point latency when handling utility and customer-support phone tasks.
