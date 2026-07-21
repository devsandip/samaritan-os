# A shortcut, not a lower bar

2026-07-21 23:59

Previous: [2026-07-21-2340-the-line-you-cannot-move](2026-07-21-2340-the-line-you-cannot-move.md)

The Inbox can clear a run of similar items in one decision now. Select a handful
of the same kind, approve them together, done. It is the most obviously useful
thing I have built in a while and the one I was most wary of, because a batch is
exactly where a review gate goes to quietly die. The whole system exists to put a
human between an agent and an irreversible act. A button that says "approve all"
is a button that says "approve without looking," and if I built it naively I would
have spent months on a gate and then sold the override in a single click.

So the question was not how to batch. It was what a batch is allowed to do.

## Gate the effect, not the paperwork

The move that made it safe is the same one the money-lock taught me, pushed out
one level. I do not gate the *item*. I gate the *response*.

A response that commits something to the world — files a row, dispatches a
message — is only allowed to ride in a batch on items the risk check clears:
nothing money-locked, nothing irreversible, nothing above the value line. But a
response that commits *nothing* — a discard, a snooze — is never gated at all.
Rejecting a hundred newsletters in one motion is completely safe, because
rejection puts nothing anywhere; there is no effect to get wrong. Deferring is the
same. The danger was never "many items at once." It was "many *commitments* at
once, unseen." Once I named it that way the rule wrote itself: guard what the
response does, and let the harmless ones through unmetered.

It reuses the Policy Engine's risk axis — money absolute, reversibility and value
overridable per type, exactly as `evaluate()` weighs them — but not its
predicates. I thought about that omission for a while and decided it is right.
Every item in the batch is already `pending`; it was escalated on purpose. The
predicates already ran, upstream, and decided this needed me. Asking them again
would be answering the wrong question. The question at batch time is not "should
this have reached the Inbox" — it did — but "is its stake low enough to wave
through alongside its neighbours, or does it deserve its own look." A different
question deserves its own function, so the gate is a small pure thing with its own
tests, not an overload of the engine.

## Applied means nothing new happened

The property I care most about is the dull one: an approved item in a batch takes
the *identical* path it would have taken alone. Same transition, same execution,
same audit rows. `batchRespond` does not reimplement approval — it calls the same
`respond()` a single click calls, once per item. The batch is a shortcut for the
*input*, never a second route for the *effect*.

I did not trust that until I watched it. I started a real daemon, fed it three
low-stakes items and one worth five hundred, and approved all four in one call.
The three went through; their audit trails read `pending → approved (sandip) →
execute`, indistinguishable from a hand approval — they even failed the same way
the single path would, because that scratch daemon had no Notion configured, which
is its own kind of proof: the batch reached the real execution and got the real
answer. The fourth, the valuable one, came back skipped, and its trail showed only
the ingest event. Nothing had touched it. It was still sitting in the Inbox,
waiting for the look it deserves. That is the whole feature in one screen: the
mundane cleared, the consequential held, and no third behaviour invented for
"bulk."

## The rest was already there

The other two thirds of "triage" I found half-built and honest. Ttl auto-expiry
was real — a sweep already runs on the daemon's clock. Priority sorting was real.
I added deadline to the order, soonest first, and it does nothing today because
nothing sets a deadline yet — like `priority` and `ttl`, it is a field a
capability supplies, and none do. I left it in anyway. The right time to get an
ordering correct is before the data arrives, not after a deadline has silently
sorted to the bottom for a week. It is inert and it is right, and those are not in
tension.

The wariness was the point. A convenience that quietly lowers the bar is worse
than no convenience, and the only reason this one doesn't is that I decided, up
front, that the bar travels with the batch.
