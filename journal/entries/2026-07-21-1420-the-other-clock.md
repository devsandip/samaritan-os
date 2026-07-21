# The other clock

2026-07-21 14:20

Previous: [2026-07-21-1130-crons-that-fire](2026-07-21-1130-crons-that-fire.md)

The scheduler entry ended by naming what came next: the clock that fires on an
email instead of an hour. So I merged the scheduler and built it.

`email-triage` and `newsletter-digest` were in exactly the state the digests
were in this morning. They declared `mode: event`, `on: [email.received]`, and
nothing had ever published an `email.received`. A subscription with no publisher
is the same dead text as a cron with no clock.

## The same shape twice

What struck me building it is how much the Event Bus is the scheduler wearing
different clothes. Both answer "should this capability run now?" — one from a
cron and a stored next-fire time, the other from an event type and a filter.
Both run through the exact same Run Layer, so a scheduled fire, an event fire,
and a hand-clicked "Run now" are one code path with three doors. And both had to
decide the same thing: what happens when the trigger arrives twice.

The scheduler advances `next_fire_at` before it fires, so an overlapping tick
can't double-run a slot. The bus records the event id before it dispatches, so a
message that arrives by both a webhook and a poll fires once. I wrote the second
one and realised I was writing the first one again. Claim, then act. The claim is
the thing that makes "at most once" true, and in both cases the price is the
same: a crash in the gap between claiming and acting loses that one run. I paid
it the same way both times, because the alternative — act, then claim — trades a
rare lost run for a double run, and a double run is the exact thing the dedup
exists to prevent.

There is a real difference underneath the symmetry, though, and it's worth being
honest about. A missed scheduled run has `catch_up: run_once` to recover it,
because the clock keeps ticking and the next boot can see the gap. A missed event
has nothing: if the process dies in that millisecond, the email is simply never
triaged, and no poll will re-offer it because the id is already marked seen. The
listeners I haven't built are where that would get fixed — a poller with a
watermark re-reads from the last *confirmed* position, not the last *seen* one.
For now the gap is a millisecond wide and I've written down that it's there.

## The filter is where two agents diverge

The nicest part is small. Both event agents take `email.received`. What makes
them different is four characters of manifest: `newsletter-digest` has
`filter: { from_in: ["@newsletters"] }` and `email-triage` doesn't. So one
`email.received` from a newsletter reaches both, and one from your boss reaches
only triage.

I could have reached for the predicate engine the Policy Engine uses. I didn't. A
filter isn't a place for logic; it's a place to say "this shape, not that one."
So it's three operators — `_in`, `_contains`, `_eq` — and it fails closed the way
the policy predicates do: a filter that names a field the event doesn't carry
doesn't match, because firing an agent on an event it couldn't actually have read
is the silent wrong answer. `@newsletters` is a label the Gmail connector would
resolve to real senders, and the connector doesn't exist, so the matcher compares
the literal and I wrote down that it's a stand-in. Honest beats clever.

## What I checked

I started the daemon and posted one newsletter to `POST /api/events`. It came
back `dispatched: ["email-triage", "newsletter-digest"]`, and the digest's item
was in the Inbox. I posted the same id again: `deduped: true`, and the Inbox
still held one item, not two. I posted one from a work address: triage only.
Three curls, and the two agents behaved exactly as their manifests said they
would.

## Where that leaves it

Both clocks run. Scheduled agents fire on a cron; event agents fire on a
published event. Neither has its real driver yet — the scheduler survives only as
long as `pnpm serve`, and the bus has no listener publishing events on its own.
Those are the two front ends left: a launchd plist so the daemon outlives a
terminal, and a listener — the chokidar vault watch is the one I can actually
test here, no API key, no network — so events arrive because something happened,
not because I typed a curl.

The dispatcher is done. What's left is the things that knock on its door.
