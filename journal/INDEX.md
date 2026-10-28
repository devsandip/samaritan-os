# Samaritan - Journal Index

Last refreshed: 2026-10-28 07:58

Latest entry: [2026-10-27-2055-command-centre-shipped](entries/2026-10-27-2055-command-centre-shipped.md)

Local-first personal agentic OS. The Action Center is a universal
human-in-the-loop layer and a pluggable capability platform: one inbox for
everything that needs me.

## Where we are now

The Command Centre is live on `main` and running under `launchd` on
`127.0.0.1:4173`. All five phases of `PROPOSAL-v1.md` and the consensus
security and worker branch are merged: 24 capabilities loaded, 9 SQLite
migrations, 49 test files, and 663 passing tests.

The Action Center remains the single approval gate across every surface.
Approvals are bound to `expected_payload_hash` and `expected_revision` so
neither the web UI nor Telegram callbacks can approve a mutated payload (`409
stale_approval`). The cross-assistant MCP server (`src/mcp/index.ts`) exposes
eight read, search, task-delegation, and action-proposal tools (`get_context`,
`search`, `read_artifact`, `list_inbox`, `propose_action`, `submit_task`,
`task_status`, `answer_question`) with `work` and `personal` scope filtering
and zero approval tools. Delegated background tasks run on the Claude Agent SDK
in a child process with provider write credentials stripped from the worker
environment (`sanitizeWorkerEnv`) and artifacts confined to
`~/.samaritan/artifacts/<task-id>/`.

Both clocks and all inbound/polling listeners are built. The scheduler fires
cron capabilities with `max_staleness_minutes` wake-gap catch-up and
`input_hash` deduplication, while the Event Bus routes events from the Obsidian
vault and multi-repo `~/Developer/*/journal` watcher, the Gmail poller, the
incremental Google Calendar `syncToken` poller (`meeting_upcoming`,
`meeting_ended`, `meeting_rescheduled`), the Fireflies HMAC webhook and GraphQL
transcript consumer, the Slack Events API HMAC webhook, coding-agent hooks
(`Notification`, `Stop`, `SessionEnd`), and the read-only macOS `chat.db`
iMessage reader.

Execution spans automated, assisted, and guided adapters: Notion (`decision`,
`insight`, `person`, `project`), Obsidian (local `Asia/Kolkata` calendar date),
TickTick Open API v1 (with `#word` tag sanitization and project lookup), Gmail
draft creation (`gmail.draft.create`), Google Calendar event creation
(`calendar.event.create`), Hevy routine copy (`hevy.routine.copy`), Thornhill
phone dispatch (`phone.task.run`), and question-bound task answers
(`samaritan.task.answer`).

Recall is hybrid now. A query runs structured SQL over mirror tables
(`notion_decisions`, `notion_insights`, `ticktick_tasks`, `calendar_events`)
alongside local `sqlite-vec` kNN and FTS5 BM25 keyword search, fuses the results
with Reciprocal Rank Fusion, and reports `"hybrid"`, `"structured"`, or
`"semantic"` honestly depending on which paths matched. The five-view UI (`Now`,
`Inbox`, `Tasks`, `Activity`, `Settings`) includes the live Connections status
grid, System Health/Backups/Billing cards, and the `Cmd+K` Command Bar.

## Recent entries

- [2026-10-27-2055-command-centre-shipped](entries/2026-10-27-2055-command-centre-shipped.md)
  - shipped the full Samaritan Command Centre across Phases 0 through 4 (21 capabilities, 9 SQLite migrations, 5-view UI with Connections grid and `Cmd+K` Command Bar, 8-tool MCP server, child-process worker isolation, hybrid structured-plus-semantic Recall with work/personal scope filtering, and Slack Events webhook), deepened all Phase 3 and 4 capabilities with pure extractors and injectable HTTP seams, and verified 614 passing tests across 44 files before merging to `main`
- [2026-07-22-0210-the-door-not-the-errand](entries/2026-07-22-0210-the-door-not-the-errand.md)
  — the Fireflies webhook: the bus's first *inbound* listener, reached into rather
  than reaching out, so the whole path is a request I can sign and curl — verified
  end to end live, no faith needed. The design turns: raw body via a per-plugin
  content-type parser so signature verification changes nothing for the rest of
  the API; signature required when a secret is set, unverified allowed on loopback
  (§9); and the honest one — the event is a *notice* carrying the meeting id, not
  the transcript, so it is inert-but-authenticated on the bus until a consumer that
  fetches and extracts is built
- [2026-07-22-0120-the-first-wire-to-the-outside](entries/2026-07-22-0120-the-first-wire-to-the-outside.md)
  — the Gmail poller: the Event Bus's first networked listener, so a real inbox
  becomes `email.received` for the two capabilities already waiting on it. Same
  pure-core/thin-shell as the vault watch; the insight was that the checkpoint is
  an optimisation over the bus dedup, not the safety mechanism, so it shipped
  in-memory first. Verified live against the real Gmail API — a genuine 401 from a
  bad token, isolated so the daemon stayed healthy; only the valid-token 200 is
  left to faith
- [2026-07-21-2359-a-shortcut-not-a-lower-bar](entries/2026-07-21-2359-a-shortcut-not-a-lower-bar.md)
  — Action Center triage v1: batch-approve for similar items, and the wariness
  behind it — a batch gates on what the response *commits* (an approve is checked,
  a discard never is), reuses §9's risk axis but not its predicates, and routes
  each applied item through the identical single-approve path; verified live that
  the low-stakes cleared and a high-value item was held untouched
- [2026-07-21-2340-the-line-you-cannot-move](entries/2026-07-21-2340-the-line-you-cannot-move.md)
  — Policy Engine v1: reversibility and value join confidence, and the design
  question that mattered — what the OS makes absolute (money) versus a strong
  default a capability can override, and why an absent signal must be read as
  silence, never as a claim of safety
- [2026-07-21-2230-the-index-that-never-loaded](entries/2026-07-21-2230-the-index-that-never-loaded.md)
  — Recall query v1: the Ask-Samaritan box answers, RRF fusing a vector and a
  keyword search, synthesis off by default for privacy — and the live run finding
  that sqlite-vec never loaded in the real daemon behind a green suite and correct
  answers, the "distrust success" refinement of an old lesson
- [2026-07-21-1945-the-restart-it-recovers-from](entries/2026-07-21-1945-the-restart-it-recovers-from.md)
  — boot reconciliation and the launchd plist: the `approved` race closed by
  re-driving a stranded item on boot, why it must run before `listen()`, the
  fourth clean split of the same seam, and verifying recovery by staging a crash
- [2026-07-21-1705-the-first-knock](entries/2026-07-21-1705-the-first-knock.md)
  — the vault watch: the bus's first real listener, a file drop that fires an
  agent; the third time the same pure-core/thin-shell seam split cleanly, and why
  a publisher needs a subscriber shipped with it
- [2026-07-21-1420-the-other-clock](entries/2026-07-21-1420-the-other-clock.md)
  — the Event Bus: the scheduler's shape again, firing on an event instead of an
  hour; dedup by source id, a fail-closed filter DSL, both clocks now real
- [2026-07-21-1130-crons-that-fire](entries/2026-07-21-1130-crons-that-fire.md)
  — the scheduler: a self-contained cron matcher over the `next_fire_at` column
  that was always waiting, claim-before-fire, and catch-up across a restart
- [2026-07-21-0815-the-brief-and-what-is-left](entries/2026-07-21-0815-the-brief-and-what-is-left.md)
  — the brief as I gave it, and the map of everything still missing: no
  scheduler, no Event Bus, Recall indexed but not queryable
- [2026-07-21-0215-agents-can-finally-run](entries/2026-07-21-0215-agents-can-finally-run.md)
  — there was no Run Layer, so no agent could actually run; six agents, a seed,
  an importer, and a screen that was promising the opposite of what the money
  lock enforces
- [2026-07-20-1330-the-topology-is-commodity-the-contract-is-not](entries/2026-07-20-1330-the-topology-is-commodity-the-contract-is-not.md)
  — a competitive scan found my architecture already shipped twice at scale, my
  manifest already shipped once, and the unattended case unsolved everywhere
- [2026-07-20-1055-my-own-fix-was-broken](entries/2026-07-20-1055-my-own-fix-was-broken.md)
  — `awaiting_confirmation` had the same bug as `deferred`, my fix for it would
  have caused the thing it prevented, and my fix for that was broken too
- [2026-07-20-1008-merged-and-first-contact](entries/2026-07-20-1008-merged-and-first-contact.md)
  — everything merged to main, and the restart that finally ran migration 3
  against the live store
- [2026-07-20-0942-snooze-survives-reingest](entries/2026-07-20-0942-snooze-survives-reingest.md)
  — deferred was on the wrong side of the settled partition, so a re-ingest
  orphaned the snoozed row and it woke as a duplicate
- [2026-07-19-2031-bootstrap](entries/2026-07-19-2031-bootstrap.md) — v0 built
  in one sitting, from design docs to a working review gate

## Weekly summaries

- [2026-W29](weekly/2026-W29-summary.md) — the whole project in one Sunday
  evening, v0 plus the four lifecycle fixes that followed the handoff

## Working hypotheses

- Gating the highest-inference capabilities first is the right sequencing.
  `wrap` and `meeting` are where a wrong row does the most damage.
- The manifest contract is holding. Adding the second capability required no
  Action Center changes, which is the whole pluggability claim. It held a sixth
  and seventh time: `note-capture` is a manifest and a `run()`, and the vault
  watch reaches it without either knowing the other's name.
- When a component has a decision and an effect, split them: the decision into a
  pure function (no clock, no db, no disk) and the effect into a thin shell. Four
  times now — the cron matcher, the event filter, the file→event mapper, the plist
  renderer — the pure half took almost all the tests and the shell shrank to
  nothing. The effect is where integration errors hide, so keep it small; the
  decision is where logic errors hide, so keep it testable without the world. It
  is no longer a discovery; it is the first move.
- Correctness under concurrency is about *where* you act, not only what you do.
  Three components now claim an exclusive moment before touching shared state: the
  scheduler claims a trigger row before it fires, the bus claims an event id
  before it dispatches, and boot reconciliation claims the whole quiet before
  `listen()` so every `approved` item it re-drives is a genuine crash remnant and
  not live work a request owns. The move is to make the dangerous assumption true
  by construction — by acting where nothing else can be moving — rather than to
  guard against the race after the fact.
- Strict validation earns its cost. Rejecting undeclared keys rather than
  stripping them has already turned two silent shape mismatches into loud ones.
- A safety default keyed on an *absent* signal is a trap. When policy grew rules
  for reversibility and value, the safe reading of a missing field was the
  permissive one — absence carries no information, so escalating on it would have
  flooded the Inbox with every capability that never heard of the feature. You act
  on what a component says, never on what it failed to say. The related design
  line: make absolute only what the OS can judge for everyone (money); for what
  varies by case, set a strong default and let the party who knows the specific
  case override it — but never let silence override it.
- Tests catch logic errors; only contact with the real system catches
  integration errors. A green suite is not evidence that something works. The
  same applies one level in: a test I write asserts what I already believe, so
  it passes for the same reason the bug exists. Three times now the assertion
  held in a world slightly kinder than production — twice about a database column
  while the defect was in what the user reads, and once about `vector_index:
  true`, which passed only because vitest supplies a `require` the ESM daemon
  lacks, so the native index the test "confirmed" had never loaded outside a
  test. The refinement: it is not enough to run it live, because the live run
  returned a correct answer while the fast path it was supposedly using sat dead.
  Distrust *success* — read the logs of the thing that worked and ask what it
  quietly decided to do instead of what you told it.
- Review that is told to refute, and made to reproduce rather than argue, finds
  things I do not. It reversed a recommendation of mine and then found a defect
  in the fix I had already verified and committed. Both corrections arrived as
  transcripts.
- Merged is not running. There is no deploy step, the daemon is not in watch
  mode, and migrations apply on boot, so a merge changes nothing until something
  restarts the process and nothing announces the difference. Worth surfacing the
  schema version and build commit on `/healthz` rather than remembering.
- A wrong classification sits harmless until something starts reading it.
  `deferred` was on the settled side of the partition from the day the contracts
  were written, and it cost nothing until `resurface()` gave it a reader. Worth
  suspecting the same shape elsewhere when adding a sweep or a new consumer of
  an existing enum.

## Open questions

- Should policy auto-complete be allowed to break through a snooze? It can
  today, on the grounds that a deferred item should not be more protected than a
  fresh one. The opposite rule, that an explicit "not now" outranks everything,
  is also defensible.

- Is one action-item type per capability with a `kind` discriminator right, or
  would four separate types have been cleaner? The dispatching adapter stays a
  routing table rather than a second implementation, which is the argument for
  keeping it.
- Is the TickTick OAuth flow worth building, or is guided staging good enough
  indefinitely?
- Should `Source` and `Decided By` be mirrored into Notion at all, given the
  audit trail already carries provenance more richly?

## Things ruled out

- `better-sqlite3` as the driver. No prebuilt binary for Node 26 and pnpm will
  not run its build script. `node:sqlite` satisfies everything the spec's
  rationale actually asked for.
- `keytar` for secrets. Archived, and needs a native build. macOS ships
  `/usr/bin/security`, which does the same job with no dependency.
- Reading Notion database ids out of `AGENT_OS.md`. Those are data source ids
  for the MCP tool, not database ids for the REST API. Ask the API instead.
- Denylisting built-ins in the expr-eval sandbox. They live in three separate
  tables and removing the obvious one leaves callables behind. Allowlist.
- Rows orphaned in the live store by the old re-ingest behaviour. There are
  none, and there could not have been: checked read-only on 2026-07-20 and the
  live database was still on migration 2, so `defer_until` did not exist and
  `resurface()` had never run. The read was real rather than an empty-result
  artifact, since `capabilities` returned its two rows from the same connection.
