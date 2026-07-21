# Crons that fire

2026-07-21 11:30

Previous: [2026-07-21-0815-the-brief-and-what-is-left](2026-07-21-0815-the-brief-and-what-is-left.md)

The last three things I wrote all ended on the same sentence: the scheduler is
next, six agents declare crons and nothing fires them, it is the only gap that
makes a sentence in the demo untrue. Today I closed it.

Two agents in the roster declare a cron. `weekly-digest` says Sunday at 20:00,
`subscription-watch` says every day at 08:00. Both were text. No Sunday ever
fired the digest. The scheduler is the clock that reads those lines.

## The column that was already waiting

I expected to reach for `node-cron`, which is what the spec names. I didn't, and
the reason is a column. `triggers.next_fire_at` has existed since the very first
migration, and nothing has ever written to it. node-cron would not have changed
that: it schedules a callback and never tells you when it will next run. So the
Dashboard could not say "next run in 3h", and §8's idea of a stale trigger — one
that has not fired within its expected window — would have had nothing to compare
against.

The moment I decided to compute the next fire myself, three problems collapsed
into one. The Dashboard reads the column. The staleness check reads the column.
And catch-up, which I thought was going to be the hard part, turned out to be a
comparison against the same column: if I boot and `next_fire_at` is in the past,
a run was due while I was asleep. That is the whole mechanism. A library timer
that dies with the process could never have told me that; a persisted timestamp
tells me for free.

So the scheduler is a matcher plus a loop. The matcher is a pure function of a
schedule and a date, which is the only reason I could write thirty-odd tests for
it without a single one of them sleeping.

## The decision I keep having to make on this project

Claim before firing, or fire then claim. I advance `next_fire_at` to the next
slot *before* the run starts, in the same synchronous step that decided it was
due. That means an overlapping tick cannot fire the same slot twice, and a burst
of missed minutes collapses to one run instead of a storm.

The cost is real and I want it written down: a crash in the middle of a run loses
that one run, because the slot is already marked done. I decided that is
acceptable, and `catch_up: run_once` is the escape hatch for the runs where it is
not — a weekly digest that matters, versus a daily 8am nudge that is stale by the
time you read it anyway. `weekly-digest` opts in; the reminders do not.

The alternative — fire, then advance only on success — retries a failing agent
every sixty seconds forever, and double-fires on an overlap. Ingest dedupes by
key, so the double-fire is mostly harmless, but "each slot fires at most once" is
a contract I can explain in one sentence, and "mostly harmless" is not.

This is the same shape as the money-locked card from last time. The bug is never
that the code breaks. It is that two true-looking things disagree about one
fact — here, "this slot is due" and "this slot has been handled" — and the fix is
to make it impossible for them to disagree, not to reconcile them after.

## What I checked before believing it

I started the daemon and asked it what it thought. It armed `subscription-watch`
to today at 08:00 and `weekly-digest` to Sunday the 26th at 20:00, and left the
event and manual agents null. That is the screen I could not have shown this
morning.

## Where that leaves it

The sentence is true now. Start the serve process and the scheduled agents fire
on their cron; miss one while the Mac sleeps and it catches up on the next boot.

The honest edges have moved, not vanished. There is still no launchd plist, so
the daemon lives exactly as long as `pnpm serve` — a reboot forgets it. The Event
Bus is still not built, which is the exact mirror of the gap I just closed:
`email-triage` and `newsletter-digest` are waiting on events the way the digests
were waiting on a clock. And Recall is still indexed and not queryable.

The next clock to build is the one that survives a reboot. Then the one that
fires on an email instead of an hour.
