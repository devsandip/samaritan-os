# The brief, and what is left

2026-07-21 08:15

Previous: [2026-07-21-0215-agents-can-finally-run](2026-07-21-0215-agents-can-finally-run.md)

The last entry recorded what got built. This one records what I asked for, and
what is still missing, because the second list is the more useful one now.

## What I asked for

Three things I wanted:

1. Agents posting to the Inbox.
2. Agents created for that purpose.
3. A demo of the whole loop: registering an agent, the agent posting, me acting
   on it.

And three jobs I set:

1. Work out which agents need to exist.
2. Work out how to fill the Inbox on day one so there is something to demo.
3. Work out how agents get added, discovered and plugged in.

Mid-build I added a fourth: a way to turn a Claude scheduled task into an agent
that runs on Samaritan. Paste the instructions, get an agent.

The answer to all three questions turned out to sit behind the same missing
piece. There was no Run Layer, so nothing could run an agent from inside
Samaritan, "adding an agent" had no artifact to point at, and the Dashboard's
agent grid was a facade. Build it and all three questions answer themselves:
six agents, `samaritan seed` through the real ingest path, and adding one stays
a folder drop.

## What is not built

Worth writing down properly, because the demo says "everything on screen works"
and that sentence is only safe if I know exactly where the edge is.

**Nothing fires on a schedule.** No daemon, no scheduler. Six agents declare
crons and event triggers and every one of them is a declaration. They run when
I run them, from the CLI or the Run now button. This is the single biggest gap
and everything else in v1 is smaller than it.

**Nothing listens.** No Event Bus, no Fireflies webhook, no Gmail poller, no
filesystem watch. `newsletter-digest` and `email-triage` are event-mode agents
with no events.

**Recall is indexed, not queryable.** The chunker, the embedder and the
sqlite-vec store are all there. The fusion step, the indexer job and the query
surface are not, so Ask Samaritan is still a placeholder and `ctx.memory.recall`
throws an explanatory error rather than answering.

**No assisted adapters.** `gmail.draft.create` does not exist, which is why
`email-triage` degrades to guided on load. The degradation is correct and the
card says so, but the assisted path in the demo is a guided path wearing the
assisted state machine.

**Settings has routing, not connections.** The routing table is real and
editable. The per-integration connection grid is a comment explaining that v0
does not have one.

**Policy is v0.** The money lock is hardcoded and enforced three ways. The rest
is predicates plus a confidence threshold. No reversibility or value rules, no
per-type overrides.

**Triage is partial.** The ttl sweep works. Priority and deadline sorting, and
batch-approve for similar low-risk items, do not exist.

Then the small ones I know about and have not fixed: the `failed` re-ingest
bug, the `approved` race that needs a startup reconciliation sweep before it can
be fixed properly, the missing "Remind me" affordance, a held event that an open
detail pane never sees, and `dailyNotePath()` computing the date in UTC so a
note written after local midnight lands in yesterday.

## What I think comes next

The scheduler. Not because it is the most interesting thing left, but because
six agents currently declare a cadence that nothing honours, and every day that
stays true the demo has a sentence in it that the product does not.

After that the Event Bus, for the same reason one level down. Then Recall,
which is the only remaining piece whose absence is visible on screen.
