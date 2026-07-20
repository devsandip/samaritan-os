# Samaritan — Journal Index

Last refreshed: 2026-07-20 09:42

Latest entry: [2026-07-20-0942-snooze-survives-reingest](entries/2026-07-20-0942-snooze-survives-reingest.md)

Local-first personal agentic OS. The Action Center is a universal
human-in-the-loop layer and a pluggable capability platform: one inbox for
everything that needs me.

## Where we are now

v0 is complete and verified against the real Notion workspace. Ten commits,
public at github.com/devsandip/samaritan-os. The whole thing was built today
from a design suite that was already written.

The anchor works. `wrap` and `meeting` no longer write to Notion or TickTick
directly. They extract as before and emit to the Action Center, where each item
waits until I approve, edit-then-approve, reject or defer it. The success
criterion from the PRD holds: no wrap or meeting row reaches Notion without an
explicit approval, and `test/anchor.test.ts` is the executable form of that
sentence.

The stack is Node with `node:sqlite` (not better-sqlite3, which has no Node 26
prebuild), Fastify, zod contracts with types inferred from the schemas, and a
React SPA served from the same origin. 119 tests. The Inbox renders items by
dispatching on `render.layout`, so no UI code knows the name of any capability.

Notion is live end to end. Telegram is written, tested and parked, disabled by
default. Recall is not started, so Ask-Samaritan is a placeholder in the UI.

Since v0 closed, the lifecycle gaps have been filled on branches rather than on
main. `claude/what-next-89afb8` carries four commits: defer and resurface so a
snooze is no longer a one-way door, a universal dismiss for items whose
capability was unloaded, multi-status filtering on `GET /api/actions`, and tilde
expansion in config path defaults. `claude/heuristic-shirley-e076a9` contains
all four plus the re-ingest fix below. 183 tests on that branch.

Main is still at the v0 tip. Two branches now point at overlapping work, one
strictly containing the other, and neither is merged.

## Recent entries

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
  integration errors. A green suite is not evidence that something works.
- A wrong classification sits harmless until something starts reading it.
  `deferred` was on the settled side of the partition from the day the contracts
  were written, and it cost nothing until `resurface()` gave it a reader. Worth
  suspecting the same shape elsewhere when adding a sweep or a new consumer of
  an existing enum.

## Open questions

- Are any rows in the live store already orphaned by the old re-ingest
  behaviour? A deferred row with a `:superseded:` suffix in its dedupe key is
  the fingerprint, but a legitimate failed to pending to deferred row matches it
  too, so this needs a look rather than a blind sweep.
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
