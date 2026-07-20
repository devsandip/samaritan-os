# Agents can finally run

2026-07-21 02:15

Previous: [2026-07-20-1055-my-own-fix-was-broken](2026-07-20-1055-my-own-fix-was-broken.md)

I set out to make Samaritan demo-ready. Three beats: an agent posts to the
Inbox, I act on it, I add a new agent live. The first thing I found was that
none of them were possible.

There was no Run Layer. `src/run-layer/` did not exist. `src/cli/run-capability.ts`
did not exist either, though `package.json` had pointed a script at it since the
scaffold. Both `wrap` and `meeting` declared `entrypoint: index.ts` and neither
folder had one. The wrap manifest admitted it in a comment: nothing loads it in
v0.

So an agent could describe itself and could not be run. Everything that posts
to the Inbox today is a Claude skill shelling out to `samaritan emit`. That
proved the anchor, and it means "adding an agent" had no artifact to point at
and the Dashboard's agent grid was a facade. Its own comment said last-run was
approximated because no telemetry existed.

Fifteen hours of work later there are six agents, 330 tests, and a runbook.

## What I built

The Run Layer imports a capability's entrypoint, races it against the manifest's
timeout, ingests what comes back, and records whether it worked. Entrypoints are
TypeScript imported with no build step, because Node 26 strips types natively. A
capability folder now runs in dev and in production alike.

Four new agents, chosen to cover the platform rather than to be four variations
on one shape. `newsletter-digest` shows policy deciding: one item type, two
outcomes, and the capability decides neither. `email-triage` shows the assisted
loop, the one that does not end when I click approve. `weekly-digest`
auto-completes and I never see it. `subscription-watch` exists to be refused.

`samaritan seed` fills the Inbox by running every agent against a fixture,
through the real ingest path. That constraint is the whole design. The first
thing anyone clicks in a demo of a review gate is the audit trail, and a
hand-written row would have a fabricated one.

And `samaritan import-task`, which the plan did not have until Sandip asked for
it mid-build: paste a Claude scheduled task's instructions, get an agent. The
prompt is copied verbatim and read at run time, so the generated agent keeps
calling Claude with exactly what I wrote. Rewriting it as rules would produce a
different agent, not the same one somewhere else.

## What contact with the thing taught me

Almost everything worth knowing came from running it, not from thinking about
it.

The module cache buster broke because `mtimeMs` is fractional and the dot reads
as a file extension to the transform pipelines in front of `import()`. Only a
test that did a real dynamic import would have found that.

`vitest.config.ts` pointed `SAMARITAN_CONFIG` at a path without writing a config
there. `loadConfig` falls back to defaults when the file is missing, and the
defaults are the real vault. Nothing had exercised a file-writing adapter under
test, so a sandbox that was not one sat there looking like one. The first agent
that wrote a note would have written it into my actual Obsidian vault.

Re-seeding forked new items and re-executed the auto-completing agents,
appending the weekly digest to the vault twice. That is correct branch 3
behaviour for a real capability, whose re-emission means the event happened
again, and wrong for a seed replaying a fixture. A test asserting idempotency
found it; my own CLI check had missed it because I was counting the Inbox rather
than the store.

And the one I would not have found any other way: I opened the Inbox and looked
at the money-locked renewal. The badge said **Automated**, and underneath it,
"on approve, this is filed directly." On the one action in the system that can
never be automated. Items stored the manifest's mode and Routing only overrode
it later at dispatch, so the card promised exactly what the money lock exists to
refuse. Three layers of enforcement working perfectly, and the screen saying the
opposite.

That is the failure mode I keep meeting on this project. Not code that breaks.
Code that works while something adjacent quietly says something untrue.

## What I decided

The four new agents are deterministic. Their judgement functions are marked as
the seam where a model call belongs and none of them makes one. A demo agent
that needs a network round-trip and an API key has a failure mode on stage that
no amount of testing removes. `wrap` and `meeting` are the LLM half and already
work; imported tasks are LLM-backed by construction. The platform does not care
which kind posts to it, and the roster now demonstrates that rather than
asserting it.

The seed only ever defers, dismisses, or approves items whose mode is guided. It
is not entitled to file anything to Notion on my behalf. That is the entire
point of the thing it is demoing.

`--clear` resolves items rather than deleting them. The audit trail is
append-only with a trigger behind it, so an undo that erased history would be
both impossible and wrong. The system's own answer to an item I no longer want
is to dismiss it.

## Where that leaves it

Demo-ready, and honest about the edges. No daemon, so the crons are
declarations. No Event Bus, so event-mode agents run when I run them. Recall is
indexed but not queryable, and the sidebar says so rather than pretending.

The runbook says all of that out loud. Being asked is worse than saying it.
