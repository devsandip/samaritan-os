# Samaritan MCP routing guide (static reference)

A static pointer for assistants (Claude Code, Claude desktop, Codex, Gemini
CLI). It never contains live personal data; live state comes from
`get_context`.

## Connection

- **Stdio**: `node /Users/sandipdev/Developer/samaritan/dist/cli/mcp.js` (run
  `pnpm build` first). A thin proxy to the running daemon: it opens no database,
  so the daemon must be up (`pnpm install-daemon`).
- **HTTP**: `POST http://127.0.0.1:4173/api/mcp`, Streamable HTTP with JSON
  responses. Loopback only; over the tailnet it needs a signed-in session.

Do not register `pnpm mcp`: pnpm prints its own lines on stdout before the
server starts, and the client stops parsing.

## Tools (eight, none of them approve anything)

1. `get_context`: Inbox count and preview, tasks in play, running work, the next
   meetings, per-source notification rules.
2. `search`: Recall over the vault, project journals and the audit trail, with
   citations.
3. `read_artifact`: an artifact a delegated task wrote, by id.
4. `list_inbox`: items waiting for Sandip.
5. `propose_action`: puts a decision, insight, task, person or note in the Inbox
   for review. Nothing is filed until Sandip approves it.
6. `submit_task`: delegates a background task. Returns at once with the queued
   task; pass `request_id` to make a retry safe. Follow it with `task_status`.
7. `task_status`: a task, its runs, artifacts and recent activity.
8. `answer_question`: answers a delegated task's open clarifying question. It
   accepts only a `task-question` on a task that is waiting, and is recorded as
   the `assistant` actor. It cannot approve a proposal or restart a stopped task.

## Boundary

Assistants read, propose, delegate and answer clarifications. Approvals happen
only in the Samaritan UI or on Telegram, from Sandip's signed-in session.
