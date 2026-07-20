# 2026-07-20 10:55 — I shipped a fix, then found it was broken

Previous: [2026-07-20-1008-merged-and-first-contact](2026-07-20-1008-merged-and-first-contact.md)

## What happened

I went looking for the deferred bug's sibling in `awaiting_confirmation`, on the
theory that the same failure mode would show up twice. It did. Then my fix for
it turned out to be wrong twice over, and both times something other than my own
judgement caught it.

## The first thing I got wrong

I said the risk was a duplicate external side effect. Re-ingest rolls a
dispatched item back to `pending`, you approve it again, and a second TickTick
task gets created. My recommended fix was to move `awaiting_confirmation` to the
settled side of the re-ingest partition, so a re-ingest would fork a fresh row
and leave the dispatched one alone.

That was wrong, and it was wrong in the most embarrassing direction. The
execution registry keys idempotency on the item id and replays any attempt that
already staged, without calling the adapter. Branch 2 preserves the item id, so
the duplicate I was warning about could not happen. Forking, which is exactly
what my fix would have done, mints a new id and a new key, misses the replay
guard, and dispatches for real. My fix would have created the bug I claimed to
be preventing.

The defect was real, just not the one I described. The rollback destroys
`_guided_link` by overwriting `execution`, and `confirm()` and `reopen()` both
answer only `awaiting_confirmation`, so the item ends up with no way to close its
own loop. Stranded, not duplicated.

## The second thing I got wrong

I shipped the corrected fix: hold the row, record the re-emission, and tell the
user to press "Didn't do it" if the handoff is void, after which the newer
content lands. I wrote a test for that path and it passed.

The test was checking the wrong thing. It asserted the row's `custom` updated. It
never asserted that the revision was actually dispatched. Adversarial review
caught it and I reproduced it in a minute:

```
title:        "REVISED"
instructions: "task: ORIGINAL, due: 2026-07-25"
executions:   1 attempt
```

The adapter is never called for the revision. The card shows the new task over a
checklist for the old one. My own audit-trail copy was instructing the user
straight into it.

The cause is the same fact I had just finished reasoning about correctly in the
commit message. The idempotency key was the item id, which is stable for the
item's entire life, so once an approval staged, the registry replayed it forever.
I understood that well enough to argue from it, and still did not notice it made
my remedy useless.

Worse, the commit I had landed in between made it more dangerous rather than
causing it. Before that commit the replay returned no link and the action bar was
visibly empty. After it, the replay returned a link and instructions for the
wrong task. I turned visibly broken into confidently wrong.

## What I decided

The key carries a generation now: `<item id>:<n>`, where `n` counts prior
`awaiting_confirmation -> pending` events. Only `reopen` writes those, and only I
call `reopen`, so the generation advances exactly when I declare a handoff void.
A retry after a failure does not advance it, because that genuinely is the same
approval, which is the case the guard exists for.

The hold itself stands. A dispatched row is left untouched and the re-emission is
recorded as an event whose from and to are the same status. The cost is that
refreshed content waits, and that cost is now written into section 5.1 rather
than left implicit.

## What this actually taught me

I already believed a green suite is not evidence that something works. I believed
it about integration bugs, where the seam is between my code and Notion. This is
the same lesson one level in: my test passed because I wrote it to check the
thing I already believed, not the thing the user experiences. The assertion was
about a database column. The user's experience is a checklist telling them to do
the wrong task. Nothing connected the two.

The habit that caught it is worth keeping: run the fix through people who are
told to refute it, and make them reproduce rather than reason. Both times the
correction came with a transcript, not an argument. The first review reversed my
recommendation. The second found a defect in the thing I had just verified and
committed.

There is a smaller lesson about writing. In both commit messages I reasoned
correctly about the idempotency key and then failed to apply that reasoning one
step further. Being able to explain a constraint clearly is not the same as
having thought through what it implies.

## Where we are now

Three commits: the hold, the replay fidelity, the dispatch generation. 201 tests.
The middle one must never ship without the third, which is a thing to remember if
anything here ever gets bisected or cherry-picked.

This is the third instance of one shape: a status on the wrong side of a
classification, harmless until something reads it. `deferred`, then
`awaiting_confirmation`, now `failed`, which is on main today and files stale
content to Notion when a superseded row is retried. That one is logged rather
than fixed.

I did not take the review's advice on the `approved` race. Holding `approved` the
way the dispatched case is held would remove the only rescue for a row wedged by
a crash mid-dispatch, and the reconciliation sweep that would replace that rescue
does not exist yet. Bounded and pre-existing, so it waits for the sweep.
