# Samaritan — Journal Index

Last refreshed: 2026-07-19 20:31

Latest entry: [2026-07-19-2031-bootstrap](entries/2026-07-19-2031-bootstrap.md)

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

## Recent entries

- [2026-07-19-2031-bootstrap](entries/2026-07-19-2031-bootstrap.md) — v0 built
  in one sitting, from design docs to a working review gate

## Weekly summaries

None yet. Week 29 has one entry; the summary is due Monday.

## Working hypotheses

- Gating the highest-inference capabilities first is the right sequencing.
  `wrap` and `meeting` are where a wrong row does the most damage.
- The manifest contract is holding. Adding the second capability required no
  Action Center changes, which is the whole pluggability claim.
- Strict validation earns its cost. Rejecting undeclared keys rather than
  stripping them has already turned two silent shape mismatches into loud ones.
- Tests catch logic errors; only contact with the real system catches
  integration errors. A green suite is not evidence that something works.

## Open questions

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
