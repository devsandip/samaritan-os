# 2026-07-20 10:08 — Merged, and the first time any of it touched real data

Previous: [2026-07-20-0942-snooze-survives-reingest](2026-07-20-0942-snooze-survives-reingest.md)

## What happened

Everything merged. Main moved for the first time since v0 closed, from `3bd7df2`
to `eb40f95`, seven commits. The two branches that pointed at overlapping work
resolved themselves: `heuristic-shirley` was built on top of `what-next` rather
than beside it, so it was a strict superset and one fast-forward carried both.
`what-next` then rebased onto main with nothing to replay, because all four of
its commits were already in there. No conflicts, and the `WORKLOG.md` collision
I was braced for never happened.

Then I restarted the daemon, and that is the part worth writing down.

## The gap between merged and running

The server had been up thirteen and a half hours. It was not in watch mode, so
it was still executing the code it was started with: pre-merge, and pointed at a
database that had only ever seen migrations 1 and 2.

Which means the `defer_until` column did not exist. The resurface index did not
exist. `resurface()` had never run against the real store, not once. The defer
work was written yesterday evening, covered by thirty-five tests, reviewed,
merged this morning, and had never touched real data at any point in that
sequence. Restarting the process is what applied migration 3 and made the
feature exist.

Nothing announced that gap. There is no deploy step in this project, so "merged"
and "live" are two different states and nothing in the tooling distinguishes
them. I only found out because the other session went looking for orphaned rows
and discovered the column it wanted to query was not there.

That also closed the orphan question, more firmly than a query result would
have. The concern was rows orphaned by the old re-ingest behaviour. There are
none, and there could not have been: the feature that creates them had never
run. The read was real, not an empty-result artifact, because `capabilities`
returned two rows from the same connection.

## A correction

Yesterday I said the tilde-expansion bug was live for `logging.dir`, since the
config sets the three `paths` keys explicitly but not that one. That was wrong.
Nothing in the codebase reads `logging.dir`. It is declared in the schema and
consumed nowhere, so the bug could not have fired through it.

So the real blast radius was zero on this machine. The bug needs a config that
omits the `paths` section, and mine does not. The only thing it ever hit was my
own sandboxed smoke server, which omitted it. The fix is still correct, and the
regression test still earns its place, because the next install starts from a
config file someone may well trim. But I overstated it, and I overstated it in
the direction that made my own find look more valuable.

## Where we are now

Main is at `eb40f95` and pushed. The daemon runs it, with migration 3 applied,
`defer_until` and its partial index present, and the sweep timer live against
the real store for the first time. Health is green, two capabilities, no
problems.

`claude/heuristic-shirley-e076a9` is deleted and its worktree removed.
`claude/what-next-89afb8` is identical to main and has nothing of its own left.

183 tests. Recall is still the last unbuilt piece of v0.

## What I would watch for

The daemon is still not in watch mode, so it will keep running `eb40f95` until
something restarts it. Every future merge has the same invisible gap. Worth
either putting the restart in a script next to the merge, or having `/healthz`
report the schema version and the commit it was built from, so the difference
between merged and running is something I can see rather than something I have
to remember.
