# Command Centre: the architecture consensus, built

Branch: `claude/samaritan-architecture-consensus-a01bce`

Source of the decisions: `docs/deliberations/consensus/PROPOSAL.md` (v2, signed
by Claude, Codex and Gemini on 2026-10-20). That folder is research and is not
committed on this branch; this doc records what was built from it and how.

## Starting point

A draft of this work already existed, uncommitted, in the main checkout on
`feat/command-centre` (written 2026-10-23). It passed its own tests but did not
do what the consensus asks in several places that matter:

- The worker ran in the daemon process, not a child process, and never used the
  Agent SDK; `submit_task` and `POST /api/tasks` waited for the whole run.
- `answer_question` could move any task-linked Inbox item to `approved` and
  `executed` with actor `sandip`, without the adapter running. An MCP client
  could forge an approval.
- Remote auth failed open when no token was set, approvals did not have to name
  a revision, and the MCP stdio command printed log lines into the JSON-RPC
  stream.
- Telegram inbound was never connected to Telegram, and its buttons were not
  bound to the item's revision.
- Calendar briefs fired only for events that changed in the last poll; there
  was no after-meeting nudge; a restart after approval could create a second
  TickTick task.

This branch starts from that draft (first commit) and fixes it. The draft in the
main checkout is untouched.

## What each decision maps to

| Consensus | Where | State |
|---|---|---|
| D1 runtime: Agent SDK worker in a child process, five-method adapter | `src/worker/` (`index.ts` service, `child.ts` the SDK run, `child-executor.ts` the fork and IPC, `protocol.ts`, `types.ts`) | Built. The SDK child is exercised only through a fixture child in tests; no real model call has been made. |
| D2 views: Now, Inbox, Activity, Tasks, Settings, command bar | `ui/src/views/` | Built. Now shows today's meetings, running work, source errors and worker spend. |
| D3 one owner per kind of data, artifacts by id | migration 8 (`tasks`, `runs`, `artifacts`, `activity_events`), `~/.samaritan/artifacts/<task-id>/` | Built. |
| D4 one MCP server, eight tools, no approve tool | `src/mcp/index.ts`, `POST /api/mcp`, `src/cli/mcp.ts` (stdio proxy) | Built and run against a live daemon. Not yet registered with any client. |
| D5 surfaces: laptop, phone over Tailscale with real auth, Telegram | `src/api/auth.ts`, `ui/src/views/Login.tsx`, `src/delivery/telegram-*.ts` | Built. Tailscale Serve itself is not configured. |
| D6 hosting on this Mac under launchd | existing `pnpm install-daemon` | Unchanged; the new pollers and worker live in the same process. |
| D8 Thornhill keeps its own service | none | Not started (Phase 4). |
| D9 trust | see "Trust" below | Built. |
| G2 fixes | run admission and fencing, `flush()` in the sweep, local date in `dailyNotePath()`, server-derived actor, restart recovery | Built. |
| C2 billing | `worker` config block, Console key `anthropic:worker`, per-run cost in `runs.cost_usd`, monthly cap | Built. |
| Phase 1 meeting loop | `src/events/listeners/calendar-sync.ts`, `capabilities/meeting-prep`, `capabilities/meeting-followup`, `capabilities/meeting`, TickTick adapter | Built; exit criteria walked in `test/meeting-loop.test.ts` against a fake Google. |
| Phase 1 coding-agent alerts | `src/events/listeners/coding-agent-hook.ts`, `capabilities/coding-agent` | Built for Claude Code. Codex and Gemini hook names are mapped but untested against real clients. |
| Phase 3 and 4 | none | Not started, as the sequence intends. |

## Trust (D9)

- **Who is calling is decided by the server.** `src/api/auth.ts` sorts callers
  into a signed-in human, a local process, or a remote stranger. Remote access is
  off until a `web:token` exists. Once it exists, decisions (respond, batch,
  confirm, reopen, routing, source rules, Stop, answer) need a human session even
  from loopback, because an assistant with a shell on this Mac reaches loopback as
  easily as the UI does.
- **The gate is hard to walk around.** It decides on the route Fastify matched,
  not the raw URL, so `/%61pi/actions` gets the same answer as `/api/actions`. It
  accepts only requests addressed to 127.0.0.1, localhost or the configured
  `public_url`, and a browser POST only from one of those origins, which stops DNS
  rebinding. An unsigned Fireflies webhook is accepted only from this Mac.
- **One daemon per database.** The daemon takes a lock next to the database
  before boot reconciliation, so a second `pnpm serve` stops instead of fencing
  the first one's runs and re-driving its approvals.
- **Approvals bind to what was on screen.** Every committing response through the
  API must carry `expected_revision` (or the payload hash) and is refused with
  428 otherwise; a mismatch is 409 `stale_approval`. Batch approve sends one
  revision per item. Telegram buttons carry a random token whose row records the
  item, response, revision and payload hash; a stale or reused button is refused.
- **The worker can only read and propose.** The SDK child gets no built-in tools,
  no filesystem settings, no MCP servers but Samaritan's four (search,
  write_artifact, ask_question, propose_action), and an environment with nothing
  but PATH, HOME, a temp dir and the model key. Every tool call is a round trip to
  the daemon, which checks the run's lease first.
- **Stop means stop.** Cancel fences the lease, SIGTERMs the child, SIGKILLs it
  after a grace period, and records whether the exit was seen.
- **Silence never approves.** Coding-agent cards the terminal resolved are
  `expired`, not approved. Cancelled meetings expire their briefs.

## Decisions taken while building

- **The swappable seam is the executor, not the service.** The consensus names a
  five-method worker adapter. `WorkerService` implements those five for every
  surface; a runtime (the SDK today, Hermes or OpenClaw later) plugs in as one
  `WorkerExecutor` function given lease-checked tools. Swapping the runtime then
  touches nothing in the ledger, Inbox or approvals.
- **Answering a question is a decision like any other.** It goes through
  `ActionCenter.respond()` and a `samaritan.task.answer` adapter, so it has an
  audit row and a revision check, and it is the same path from the Inbox, the
  Tasks view, Telegram and MCP. MCP answers are recorded with a new actor,
  `assistant`. An answer names the question it answers, so a late reply to an
  earlier question is refused rather than applied to the next one, and an
  assistant may answer only the tasks an assistant submitted.
- **A restarted run is reported, not replayed.** Running tasks become
  `interrupted` on boot and run again only on Retry. Queued tasks that never
  started do start.
- **Telegram inbound is a long poll.** No public webhook, so nothing on this Mac
  is exposed for Telegram's sake. The draft's webhook route is removed.
- **The MCP stdio server is a proxy to the daemon.** It opens no database and
  runs no worker, so every assistant sees one live state and a task outlives the
  assistant that submitted it. Register it as `node <repo>/dist/cli/mcp.js`.
- **Fireflies is left to PR 8.** The draft subscribed `meeting` to
  `meeting.transcribed`, but that event carries no transcript, so the run did
  nothing. The open PR 8 on `claude/continue-building-0uer2e` builds the proper
  consumer; this branch reverts the subscription rather than duplicate it.
- **The meeting note is still written directly.** `meeting`'s manifest already
  settled that the vault note is a reversible local file and is not gated. It
  now never overwrites an existing note and validates the date it puts in a path.
- **TickTick check-or-create.** TickTick takes no idempotency key, so the
  adapter writes an intent row before posting and puts `ref: samaritan:<hash>` in
  the task. A retry after an unknown outcome looks for that reference first and
  fails rather than risk a duplicate if it cannot look.
- **A killed run counts at its ceiling.** The SDK reports cost only when a run
  ends, so a cancelled or timed-out run is charged its per-run budget against the
  monthly cap. The cap errs high, never low.
- **Pinned SDK version.** `@anthropic-ai/claude-agent-sdk` is pinned to 0.3.300,
  released 2026-10-14, not the newest release.

## Setting it up on this Mac

Secrets go in the Keychain, service `samaritan`:

| Account | What | Needed for |
|---|---|---|
| `web:token` | any long random string | the phone, and signing decisions in the UI |
| `anthropic:worker` | a Console API key with a spend cap | delegated tasks (C2: not the Claude plan) |
| `telegram:bot` | bot token | Telegram alerts and buttons |
| `gcal:default` | JSON `{"client_id","client_secret","refresh_token"}` | calendar sync |
| `ticktick:default` | Open API token | automated TickTick filing |

```bash
security add-generic-password -s samaritan -a web:token -w
```

Config (`~/.samaritan/config.yaml`): `calendar.enabled`, `ticktick.enabled`,
`delivery.telegram.enabled` and `chat_id` (and `user_id` if the bot is ever in
a group), `server.public_url` once Tailscale Serve is set up, and the `worker`
block for model, per-run and monthly budgets.

The live database is at migration 5. Migrations 6 to 8 apply on the next daemon
start.

## Verified, and not

Verified here: typecheck and build for daemon and UI; the full test suite,
including regression tests for every finding of an independent security review
of this branch; the
daemon started from `dist/` in a sandbox, with the MCP stdio proxy driven
through initialize, a notification, tools/list, submit_task and get_context
(stdout carried only JSON-RPC); the UI in a browser at desktop and 375px width
(sign-in with a token, delegate a task, no horizontal overflow on any view).

Not verified: a real Agent SDK run (no Console key on this machine), real
Google Calendar, Telegram and TickTick calls, Tailscale Serve, launchd after a
reboot before login, and the Codex and Gemini hook payloads.

## Not done yet

- Register the MCP server (`node /Users/sandipdev/Developer/samaritan/dist/cli/mcp.js`) with Claude Desktop / Cowork once ready.
- Live external verification that requires interactive credentials or network tunnels: a real Agent SDK run with `anthropic:worker`, live Google Calendar / Telegram / TickTick / Thornhill / Oura / PostHog / Nutgraf credentials in Keychain, Tailscale Serve HTTPS configuration, and launchd verification after a reboot before login.
