# The line you cannot move

2026-07-21 23:40

Previous: [2026-07-21-2230-the-index-that-never-loaded](2026-07-21-2230-the-index-that-never-loaded.md)

The Policy Engine can weigh three things now instead of one. It always knew how to
read confidence — is the capability sure enough to skip me? Today it learned the
other two dimensions the spec named a year ago and I kept deferring: is this
undo-able, and how much is at stake. An irreversible action, or one whose value
crosses a line, now goes to the Inbox before any capability's "just file it" can
take effect.

Writing the rules was an afternoon. The part worth remembering is the hour I spent
deciding how absolute they should be.

## Absolute, or merely default

Money is absolute. The spec is unambiguous and I built it that way months ago:
`payment.make` escalates, no manifest can override it, three independent layers
refuse to let it not. It is the one place the system removes a choice on purpose.

My first instinct was to make irreversibility the same — hard, unbendable, a
second bright line. It felt safer. But I stopped, because "irreversible" is not
like "money." Money is a category the OS can define for everyone: a payment is a
payment in every capability that will ever exist. Whether an action is
"irreversible enough to always ask" is a judgment that depends on the specific
action, which the capability author knows and the OS does not. If I made it
absolute I would eventually be wrong for someone — a capability with an
"irreversible" action that is genuinely fine to run unattended, blocked forever by
a rule that couldn't tell the difference.

So reversibility and value are strong defaults with an escape hatch. The OS sets
the line; a capability that knows better sets `allow_irreversible` or its own
`value_threshold` and takes responsibility. Money keeps the escape hatch welded
shut. The distinction I landed on: the OS should draw the lines it can draw for
everyone, and set sensible defaults for the ones it can't, but it should let the
person who knows the specific case move a default — and never let *silence* move
it.

## Silence is not consent

That last clause is the one I'm proudest of, and it is entirely about what happens
when a field is absent.

A missing `reversibility` is treated as reversible. A missing `value` is treated
as zero. The rules fire only on a stated signal, never on its absence. This is
what made the whole change safe to ship: every action item that already exists has
neither field, so every one of them evaluates exactly as it did yesterday. Nothing
moved under anyone.

I could have done the opposite — treat an unstated reversibility as "unknown,
therefore escalate, to be safe." It sounds more cautious. It would have been a
catastrophe: every capability that never heard of this feature would suddenly
flood the Inbox, and the cost of the safety net would land entirely on the silent
majority who did nothing wrong. Caution that punishes silence isn't caution, it's
noise. The safe default for an *absent* signal is the permissive one, precisely
because absence carries no information. You escalate on what a capability *says*,
not on what it failed to say.

## A guardrail before the thing it guards

None of the capabilities I have today set these fields in a way that changes their
own fate. The anchors escalate everything already; the auto-completing ones are
genuinely low-stakes. So in one sense I built a net under a floor nobody is
standing near yet.

I don't think that's premature. The money-lock was the same — it guards
`payment.make`, and exactly one capability exercises it. A guardrail's job is to
be there before the fall, not after. What I refused to accept was leaving it as
pure abstraction, so subscription-watch now records each renewal's real risk
profile: `reversibility: "hard"`, `value` set to the dollar amount. The money-lock
is still what escalates it — I kept `trigger_reason` honest about that — but the
stakes are data on the item now, and if the money-lock ever failed, the value rule
would catch the same renewal on its own. Defense in depth, and a first real
speaker for a signal that would otherwise be talking to no one.

## The shape holds

`evaluate()` is still pure. The global thresholds live in config, and I threaded
them in through an options argument rather than letting the engine reach for the
world — the same decision/effect split I keep writing, the config resolved in the
shell and handed to the pure core. I verified it the way I verify everything now:
not by trusting the unit tests that inject the config directly, but by starting
the real thing, letting it read a real config file, and watching a value-50 item
escalate and a value-10 item pass. The wire the tests couldn't see, seen.
