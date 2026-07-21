# The first knock

2026-07-21 17:05

Previous: [2026-07-21-1420-the-other-clock](2026-07-21-1420-the-other-clock.md)

The last entry ended on a line I liked enough to build against: the dispatcher is
done, and what's left is the things that knock on its door. So I built the first
thing that knocks.

It is a file. You write a note into the vault's `Inbox/` folder and, with nothing
else — no button, no curl, no API call — an item appears in the Action Center
asking what to do with it. That is the whole feature, and it is the first time
Samaritan reacts to the world instead of to me.

## The third time I split the same seam

There is a shape I have now written three times. The cron matcher was a pure
function of `(schedule, date)`. The filter was a pure function of
`(filter, payload)`. The vault watch is a pure function of `(change, root)` →
event-or-null. Each time, the part with the judgement in it — *does this fire?
what does it mean?* — comes out into a function that touches no clock, no
database, no disk, and each time the machinery around it shrinks to almost
nothing. `fileChangeToEvent` is forty lines and has nine tests that never open a
file. `VaultWatcher` is the chokidar it wraps and little else.

I didn't plan this as a rule. It emerged, and now I trust it: when a component
has a decision and an effect, the decision wants to be pure and the effect wants
to be thin. The effect is where the integration errors live, so make it small
enough to hold in your head; the decision is where the logic errors live, so make
it testable without the world. The scheduler taught me this and I keep being
right to reach for it.

## The inverse of this morning's lesson

The other-clock entry has a sentence in it I kept turning over: *a subscription
with no publisher is the same dead text as a cron with no clock*. The digests
declared `on: [email.received]` and nothing published one, so they were
declarations, not behaviour.

Building a listener, I walked straight into the mirror image. A watch that
publishes `note.created` into a bus that nothing is listening for is *also* dead
text — a publisher with no subscriber, the same gap seen from the other side. I
could have shipped the vault watch alone, called step 18 more done, and left an
event type that reached no one. The tests would have passed. The daemon would
have logged `dispatched: []` forever and I could have called that working.

So I didn't ship it alone. `note-capture` came with it: a capability that answers
`note.created` filtered to `Inbox/` and turns a captured thought into a task
candidate. Now the loop has both ends. A file lands, an event publishes, an agent
answers, an item waits. The thing I keep learning is that "built" is a claim about
a whole path, not a component — the same reason merged isn't running and a green
test isn't a working feature.

## Where I was honest about the edge

Two places the spec asks for more than I built, written down rather than papered
over. The spec watches the vault *and* `~/Developer/*/journal/**/*.md`. chokidar
5 dropped glob support, so that second root is no longer a pattern — it's an
enumeration of every `*/journal` directory, a macOS concern with no honest test
surface on this Linux box. So I built one root well and left `WatchRoot[]` ready
for the second. And `seen_events` now gains a row per vault write and nothing
prunes it; fine at one user's scale, but the spec called that set "short-lived,"
so I wrote down that it isn't yet.

## What I checked, and why it felt different

I started a real daemon against a throwaway vault, and I wrote a file. Not a curl,
not an `emit-event` — a file, the way a person actually captures a thought. The
`note-capture-review` item was in the Inbox a beat later, `pending`, with a true
audit trail: `null → pending`, actor `capability`. Then I wrote one into `Areas/`
instead of `Inbox/`, and the daemon logged `note.created dispatched: []` — the
filter, refusing it, live.

Every other time I've verified against the real system, the "real system" was a
database or an HTTP route or Notion. This time it was the filesystem, and the
input was a file I wrote by hand. It is the closest the thing has come to
behaving like what it's supposed to be: not a program I invoke, but an OS that
notices. The knock was real, and something answered the door.
