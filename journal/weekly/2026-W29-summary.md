# 2026 W29 — The whole project, in one Sunday evening

Previous: none. This is the first week.

Week 29 for Samaritan was a single day, and really a single evening. Fifteen
commits between 18:18 and 22:11 on Sunday 2026-07-19. Everything below happened
inside those four hours.

## v0, 18:18 to 20:33

Eleven commits took the repo from a folder of design documents to running
software. The design suite was already written and internally consistent, and
`TECH-SPEC.md` section 12 had a fifteen-step build order, so the work was
execution rather than discovery. Contracts as zod schemas, the Action Store
behind a forward-only migration runner, the Policy Engine, capability registry,
routing, execution registry, ingest API. Then the anchor.

The anchor is the part that matters. `wrap` and `meeting` used to extract items
from a conversation and write them straight to Notion and TickTick. Now they
extract exactly as before and emit to the Action Center, and nothing is filed
until I approve it. That is the v0 thesis proven on two real capabilities.

Telegram delivery with quiet-hours queueing, the Inbox SPA, and a public repo
followed. Private workspace identifiers were rewritten out of all nine commits
before publishing, not just HEAD, because a scrub that only cleans the tip looks
thorough and is cosmetic.

Verified end to end against the real Notion workspace: emit, escalate, approve,
write, archive.

## The lifecycle gaps, 21:58 to 22:11

Four more commits landed after the handoff note was already written. Thirteen
minutes of work closed three of the four items I had just listed as Next.

Deferred got a way back out. It was a status you could enter and never leave:
nothing recorded when an item should return and nothing swept it, so "Later"
meant "discard quietly." That commit added the resurface window, the sweep, and
the transitions the Deferred view's own buttons needed. Every item also got a
universal dismiss, so an item whose capability was unloaded is no longer stuck
in the Inbox with no response the daemon will accept. `GET /api/actions` learned
to take several statuses. Config path defaults learned to expand a tilde.

All four sit on a branch. None of it is merged.

## What the week taught

Six real bugs, and only two came from tests. The vault root pointed one level
too high and the Notion ids were data source ids rather than database ids, and
both were invisible to a green suite because each half was self-consistently
wrong. Tests catch logic errors. Only contact with the real system catches
integration errors.

The other thing, visible only in hindsight: the 21:58 defer work is what turned
a latent misclassification into a live bug. `deferred` had been on the settled
side of the re-ingest partition since the first commit, harmless because nothing
ever woke a deferred row. Adding the sweep gave it a reader. That became the
first thing found in week 30.

## Postscript, added 2026-07-20 10:08

Two claims above were true when written and are not any more. Noting them here
rather than editing the body, so the record still says what I believed at the
time.

"All four sit on a branch. None of it is merged." Merged on the Monday morning,
along with the week 30 re-ingest fix. Main went from `3bd7df2` to `eb40f95` in
one fast-forward and was pushed.

The section on the lifecycle gaps reads as though the work was finished on the
Sunday. It compiled and passed on the Sunday. It did not run. The daemon was not
in watch mode and the live database was still on migration 2, so `defer_until`
did not exist and `resurface()` had never executed against real data until the
Monday restart. Week 29 built the feature. Week 30 is where it first existed
outside a test.
