# The restart it recovers from

2026-07-21 19:45

Previous: [2026-07-21-1705-the-first-knock](2026-07-21-1705-the-first-knock.md)

Two things landed today that are really one thing. The daemon now recovers from a
crash, and it now has something that restarts it after one. Neither is worth much
alone — a recovery pass on a process nothing restarts is a fire drill in an empty
building; a restarter with nothing to recover is a process that comes back having
forgotten what it was doing. Together they close a loop I had left open since the
Run Layer: the moment an item is `approved`.

## The one frame you can't be caught in

There is exactly one instant in an item's life where the OS is mid-motion.
`execute()` writes `approved`, hands the payload to the registry, awaits a network
round-trip, and writes the outcome. Everything before that instant is a decision
Sandip can see in the Inbox; everything after is a settled fact with an audit row.
`approved` is neither. It is the OS with its hand extended — and if the process
dies there, the item is frozen mid-handshake. Not pending, so the Inbox doesn't
show it. Not executed, so nothing downstream reads it. Not failed, so nothing
retries it. It just sits, `approved`, forever.

I had known about this since I wrote `execute()`. It sat in the carried-bugs list
as "the approved race", and every time I read the list I thought: that needs a
sweep at boot. Today I wrote the sweep.

## Recovery is a replay, not a redo

What made it easy is a decision I made days ago for a different reason. The
dispatch key is derived — `${item.id}:${generation}` — not minted fresh each
attempt. I built that so a retry after a timeout wouldn't file a second Notion
row. But a restart is only a timeout with a process death in the middle, and the
same key does the same work: re-driving an `approved` item asks the registry to
run the same key again, and the registry replays a settled attempt instead of
repeating it. So the recovery needed no new safety machinery. It needed to call
`execute()` again and trust the idempotency I already had. The best code I wrote
today was three lines long, because the hard part had been done earlier, for
something else.

## Before the door opens

The one genuinely new idea was about *when*. The ttl and resurface sweeps run
after the server is listening — I wrote them that way on purpose, so the daemon
answers before it starts catching up. My instinct was to put reconciliation there
too, next to its siblings. That would have been a bug.

Reconciliation treats every `approved` item as a crash remnant. But once the
socket is open, an `approved` item might not be a remnant at all — it might be one
a `respond()` is *right now* in the middle of executing, its `pending` execution
row genuinely in flight. The sweep would mistake live work for wreckage and
re-drive it underneath the request that owns it. So it has to run before
`listen()`, in the quiet before the daemon accepts anything, where "everything
approved is stranded" is true because nothing else can be moving.

This is the third time I've reached for the same shape. The scheduler claims a
trigger before firing it. The bus claims an event id before dispatching it. Now
reconciliation claims a quiet moment — the whole process, before the socket —
before it acts. Each time the lesson is the same: correctness under concurrency
isn't about doing the right thing, it's about doing it where nothing else can be
doing the wrong thing at the same instant.

## The fourth time the seam split

`renderPlist` is a pure function of its options and nothing else — no disk, no
`launchctl`, no home directory. The CLI around it resolves the real paths and does
the writing, and refuses on the wrong OS rather than emitting a plist that cannot
load. That is the cron matcher and the event filter and the file-to-event mapper
again, a fourth time, and I have stopped being surprised by it. When a component
has a decision and an effect, the decision wants to be pure and the effect wants
to be thin. I write it that way now, instead of discovering it.

## I made it crash to watch it heal

Every verification before this one asked "does the feature work?" This one asked a
stranger question: "does the system recover from its own failure?" You cannot test
that by using it correctly. You have to break it on purpose. So I started a
throwaway daemon, reached into its store, and froze an item in `approved` — the
exact state a crash leaves — then started the real daemon and watched.

The item was `awaiting_confirmation` before `/healthz` even answered. The trail
read `approved -> awaiting_confirmation`, actor `system`, and the log said
`re-driving an item interrupted mid-execution`. The server did not take my health
check until the healing was done, which is the whole design in one observation. I
had staged a small disaster and the OS cleaned it up before it was willing to say
hello.

That is a different kind of confidence than a green test. A test says the happy
path works. This says the unhappy path — the one where the machine dies at the
worst possible instant — has a floor under it. For an OS meant to hold the things
I would otherwise drop, the floor is the whole point.
