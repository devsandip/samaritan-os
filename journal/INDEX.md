# Samaritan — Journal Index

Last refreshed: 2026-07-21 11:35

Latest entry: [2026-07-21-1130-crons-that-fire](entries/2026-07-21-1130-crons-that-fire.md)

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

367 tests, typecheck clean, everything merged and pushed. `docs/DEMO.md` is the
runbook and `test/agents.test.ts` is that runbook made executable, so a stale
demo step fails the suite before it fails in a room.

The scheduler is built. The serve process hosts it, and scheduled-mode agents
fire on their declared cron: `weekly-digest` on Sunday at 20:00,
`subscription-watch` daily at 08:00. `next_fire_at` is persisted and shown on the
Dashboard, and a run missed while the machine slept is caught up on the next boot
per each manifest's `catch_up`. Verified against a live daemon rather than only
in tests. It computes the next fire itself rather than delegating to node-cron,
for the column, the catch-up and the deterministic tests that decision buys.

What is not built, stated plainly because the demo depends on knowing the edge:
no launchd plist, so the daemon lives only as long as `pnpm serve` and a reboot
forgets it; no Event Bus, so event-mode agents (`email-triage`,
`newsletter-digest`) have no events — the exact mirror of the gap the scheduler
just closed; Recall is chunked, embedded and indexed but has no fusion step, no
indexer job and no query surface; no assisted execution adapters, which is why
`email-triage` degrades to guided; Settings has a real routing table and no
connections grid; Policy is v0 plus the hardcoded money lock. The launchd plist
is next, then the Event Bus.

## Recent entries

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
  Action Center changes, which is the whole pluggability claim.
- Strict validation earns its cost. Rejecting undeclared keys rather than
  stripping them has already turned two silent shape mismatches into loud ones.
- Tests catch logic errors; only contact with the real system catches
  integration errors. A green suite is not evidence that something works. The
  same applies one level in: a test I write asserts what I already believe, so
  it passes for the same reason the bug exists. Twice now the assertion was
  about a database column while the defect was in what the user reads.
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
