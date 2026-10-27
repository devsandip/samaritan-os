# Samaritan MCP Routing Guide (Static Reference)

This file is a static routing pointer for coding and desktop assistants (Claude Code, Claude Desktop, Codex, Gemini CLI). It never contains live personal data.

## Connection

- **Stdio MCP command**: `pnpm --dir /Users/sandipdev/Developer/samaritan mcp`
- **HTTP JSON-RPC endpoint**: `POST http://127.0.0.1:4173/api/mcp`

## Exposed Tools (8 Tools, Zero Approval Tools)

1. `get_context`: Returns Samaritan's active operational snapshot (pending Inbox count, active delegated tasks, upcoming calendar events, and per-source notification rules).
2. `search`: Searches Samaritan Recall across the Obsidian vault, Notion decisions/insights mirrors, project journals, and audit trail, returning cited passages.
3. `read_artifact`: Reads the metadata and text content of an artifact produced by a delegated task under `~/.samaritan/artifacts/<task-id>/`.
4. `list_inbox`: Lists items currently waiting in Sandip's Samaritan Inbox (`pending`, `in_review`, `awaiting_confirmation`).
5. `propose_action`: Submits an action item proposal (`decision`, `insight`, `task`, `person`, or `note`) into the Samaritan Inbox for Sandip to review. Never executes directly.
6. `submit_task`: Submits a delegated background task (`general`, `coding`, `research`, or `operations` lane) to Samaritan's worker.
7. `task_status`: Returns the current status, latest run, registered artifacts, and recent activity events for a delegated task.
8. `answer_question`: Provides a clarifying answer to a delegated task currently in `needs_input` status and resumes the worker. Cannot approve Inbox action items.

## Security Boundary

- Connected assistants can read context, propose actions, submit background tasks, and answer worker clarification questions.
- Approval tools (`respond`, `confirm`, `batch`) are excluded from MCP. Every external side effect requires human approval in the Samaritan Command Centre UI or Telegram bot.
