# Samaritan — Journal Index

Last refreshed: 2026-07-22 01:25

Latest entry: [2026-07-22-0120-the-first-wire-to-the-outside](entries/2026-07-22-0120-the-first-wire-to-the-outside.md)

Local-first personal agentic OS. The Action Center is a universal
human-in-the-loop layer and a pluggable capability platform: one inbox for
everything that needs me.

## Where we are now

Demo-ready. Six agents that actually run, a seeded Inbox, and a runbook whose
every step was executed before it was written down.

The Run Layer is the piece that changed things. Until 2026-07-21 a capability
could describe itself and could not be run: `src/run-layer/` did not exist,
neither did the CLI `package.json` had pointed at since the scaffold, and both
`wrap` and `meeting` declared entrypoints that were not there. Everything
reaching the Inbox came from a Claude skill shelling out to `samaritan emit`.
Now a capability folder is executable, with no build step, and adding one is
still just dropping a folder in.

The roster covers the platform rather than repeating one shape: policy deciding
between two outcomes, the assisted loop that does not end at approve,
auto-completion nobody sees, and one agent whose job is to be refused by the
money lock. `samaritan seed` fills the Inbox through the real ingest path, so
every audit trail in the demo is true. `samaritan import-task` converts a
Claude scheduled task into an agent, keeping its prompt verbatim.

v0 is complete and verified against the real Notion workspace. Ten commits,
public at github.com/devsandip/samaritan-os. The whole thing was built in one
sitting on 2026-07-19, from a design suite that was already written.

The anchor works. `wrap` and `meeting` no longer write to Notion or TickTick
directly. They extract as before and emit to the Action Center, where each item
waits until I approve, edit-then-approve, reject or defer it. The success
criterion from the PRD holds: no wrap or meeting row reaches Notion without an
explicit approval, and `test/anchor.test.ts` is the executable form of that
sentence.

The stack is Node with `node:sqlite` (not better-sqlite3, which has no Node 26
prebuild), Fastify, zod contracts with types inferred from the schemas, and a
React SPA served from the same origin. The Inbox renders items by dispatching on
`render.layout`, so no UI code knows the name of any capability.

The lifecycle gaps v0 left open are closed: defer and resurface, a universal
dismiss, multi-status filtering, and the re-ingest fixes for `deferred` and then
`awaiting_confirmation`, both of which had been sitting on the wrong side of the
settled partition. The idempotency key now carries a dispatch generation, so a
reopened item dispatches a genuinely different version rather than replaying a
voided attempt.

Notion is live end to end. Telegram is written, tested and parked, disabled by
default.

480 tests, typecheck clean, everything merged and pushed. `docs/DEMO.md` is the
runbook and `test/agents.test.ts` is that runbook made executable, so a stale
demo step fails the suite before it fails in a room.

Both clocks are built, and they are the same machine wearing two faces. The
scheduler fires scheduled-mode agents on a cron — `weekly-digest` Sunday at
20:00, `subscription-watch` daily at 08:00 — with `next_fire_at` persisted, shown
on the Dashboard, and caught up on the next boot if the machine slept through it.
The Event Bus fires event-mode agents on a published event: `POST /api/events`
takes a `SamaritanEvent`, dedups it by source id, and dispatches to every
subscriber whose `trigger.on` matches and whose `trigger.filter` passes, so one
`email.received` reaches `email-triage` and `newsletter-digest` or just the first
depending on who sent it. Both run through the same Run Layer, and both claim the
trigger before firing so a double-delivery fires once. Verified against a live
daemon, not only in tests.

The bus has its first real listener now: a chokidar watch on the vault publishes
`note.created` when a note lands, and `note-capture` answers one — write a file
into `Inbox/` and a review item appears, with no curl. It shipped with a
subscriber on purpose, because a publisher no one listens to is the same dead
text as a subscription no one publishes. Verified live against a daemon: an Inbox
write captured, an Areas write dispatched to nobody.

The daemon now survives its own restarts. On boot, before the socket opens, a
reconciliation pass re-drives any item a crash left in `approved` — the one frame
where the OS is mid-handoff, invisible to the Inbox and unread by anything
downstream — and the re-drive is safe because the derived dispatch key replays a
settled attempt instead of repeating it. It runs before `listen()` on purpose:
after the socket opens an `approved` item might be live work a request owns, not a
remnant. And `pnpm install-daemon` writes a launchd agent (`RunAtLoad` +
`KeepAlive`) so the process starts at login and comes back after a reboot, which
is the restart the reconciliation is there to clean up after. Verified by staging
the disaster: an item frozen in `approved` was recovered to awaiting_confirmation
before `/healthz` answered.

Ask-Samaritan answers now, and the last placeholder in the UI is gone. A question
is embedded locally, retrieved by a vector kNN and a BM25 keyword search over the
same chunks, fused with Reciprocal Rank Fusion, and returned as cited passages —
every claim tied to the note it came from. Synthesis into prose is opt-in and off
by default, a privacy choice (§9), so the answer never leaves the machine unless
Sandip turns it on. `samaritan index` fills the index and the daemon keeps it
current on a 15-minute reconcile. Verified live over a real socket — and the live
run caught what the suite could not: sqlite-vec was loaded with a bare `require`
that only exists under vitest, so the native vector index had never once loaded in
the real daemon, silently scanning instead. Correct answers the whole time, dead
index behind them. `createRequire` fixed it; distrusting a correct answer found it.

The Policy Engine is v1 now. It weighs all three risk dimensions §5.6 names, not
just confidence: an action marked irreversible, or one whose stated value crosses
a threshold, escalates to review before any `auto_complete_when` can wave it
through. Both are first-class context signals (a capability can't shadow them),
and both are overridable per-type — the one distinction from the money-lock, which
is absolute. The load-bearing choice was that absent means silence, not a safety
claim: a missing signal never escalates, so every existing item behaves exactly as
it did in v0. Verified live against the real config loader, not only the injected
unit tests.

What is not built, stated plainly because the demo depends on knowing the edge:
the inbound networked listeners — a Fireflies and a Slack webhook — so meeting and
chat events still reach the bus by `emit-event` or the HTTP route. The Gmail poller
is built now, the bus's first networked front end, off by default until a token is
in the Keychain. Still open: Recall's structured SQL path over the mirror tables
(so `retrieval_path` is always `semantic`) and its near-real-time chokidar
indexing, both left for later; no assisted execution adapters, which is why
`email-triage` degrades to guided; Settings has a real routing table and no
connections grid; and the Gmail refresh-token flow, so a token outlives its hour.
Next are the two inbound webhooks, both fully curl-verifiable where the Gmail poll
is not.

## Recent entries

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
