# 2026-07-20 09:42 — A snooze now survives a re-ingest

Previous: [2026-07-19-2031-bootstrap](2026-07-19-2031-bootstrap.md)

## What happened

Yesterday's defer work gave `deferred` a way back out. Today I found the hole it
opened, one layer up.

`SETTLED_STATUSES` had `deferred` in it. That list decides what a re-ingest does
when a capability emits something it has emitted before. Settled means the
event already ran its course, so the old row is preserved and a fresh one is
inserted under the original dedupe key. For an executed or rejected row that is
right. For a snoozed one it was not. The old row survived with its status and
its `defer_until` intact, orphaned behind a rewritten key, and `resurface()`
woke it alongside its replacement. Two copies of the same thing in the Inbox.

The bug needed both halves to exist. The settled classification has been there
since the contracts were written. It was harmless until yesterday, because
before `resurface()` nothing ever woke the orphan, so it just sat there
invisibly. Adding the sweep is what turned a latent mistake into a visible one.

## What I decided and why

The framing I was handed was a choice between two bad options. Treat deferred as
unsettled and a re-ingest cancels a snooze I deliberately set. Leave it settled
and I get duplicates. Both are real, and both are wrong.

The third option is the right one, and the store already supported it. A
re-ingest and a defer say orthogonal things. The capability is saying what the
content is now. I am saying when I want to look at it. Neither implies anything
about the other. So the row supersedes in place, keeps its status and its
window, and only the content changes. When it wakes, it shows what is true at
wake time instead of a snapshot from before the snooze.

What convinced me the partition itself was wrong, and not just the branch: the
test the partition applies is whether the logical event has run its course. For
executed, rejected and expired it has. For failed, execution was attempted and
something external may be half-committed. A snoozed item is the only one of the
five that is explicitly waiting to run its course. It was filed with the wrong
group.

Two things fall out. Delivery does not fire while the row stays deferred, or the
snooze leaks through the notification channel. And policy still re-runs, so a
refresh that now matches `auto_complete_when` executes without waiting. That
escape hatch is what makes holding the window safe rather than stubborn.

I corrected `TECH-SPEC.md` 5.1 rather than logging a deviation in
`DECISIONS.md`. The header of that file says deviations go there so the spec
stays the design record. This is not a deviation. Following 5.1 as written
produces the duplicate, so it is a defect in the design record, and leaving it
would mean the next person implements the same bug from the same instruction.

## Where we are now

The fix is one commit on `claude/heuristic-shirley-e076a9`, which contains the
four commits from `claude/what-next-89afb8` underneath it. 183 tests. Eleven of
them are new and cover this; seven of those failed against the old behaviour
before I changed anything, which is the part I trust most.

Three of the four items I left as Next yesterday are done, all on the what-next
branch: the deferred dead end, the orphaned-capability dismiss, and multi-status
filtering on `GET /api/actions`. Recall is still not started.

Nothing is merged to main yet. Two branches point at overlapping work and one
strictly contains the other, so this wants resolving before it drifts.

## Open questions

Whether any rows in the live database are already orphaned by the old
behaviour. The fingerprint is a deferred row whose dedupe key carries a
`:superseded:` suffix, but a legitimate failed to pending to deferred row can
look the same, so I did not write a sweep for it. Worth one query against the
real store before assuming the answer is zero.

Whether auto-complete should be allowed to break through a snooze at all. I
decided yes, on the grounds that policy saying "this needs no human" is the
system working as designed, and that a deferred item should not be more
protected than a fresh one. I am not certain. The alternative is that an
explicit "not now" outranks everything, which is also defensible.
