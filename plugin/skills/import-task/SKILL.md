---
name: import-task
description: Turn a Claude scheduled task into a Samaritan capability. Use when Sandip says "import this scheduled task", "make this a Samaritan agent", "turn this into an agent", pastes the instructions from a scheduled task and asks to convert it, or types `/import-task`. Produces a capability folder whose output goes through the Inbox review gate instead of straight into Notion or TickTick.
---

# /import-task — a scheduled task becomes an agent

A Claude scheduled task is a prompt plus a cadence. It runs, it does something,
and whatever it did is done. This converts one into a Samaritan capability so
the same work keeps happening and its output lands in the Inbox for review
instead of committing itself.

## What changes and what does not

**Does not change:** the prompt. It is copied verbatim into `instructions.md`
and read at run time. The generated agent still calls Claude with those exact
instructions, because the intelligence of a scheduled task *is* the prompt.
Rewriting it as a deterministic function produces a different agent, not the
same one somewhere else.

**Changes:** where the output goes. Instead of the task writing to Notion or
TickTick itself, each finding becomes an action item that waits for Sandip.

## Your job

The CLI does the mechanical part. You do the part a regex cannot: reading the
instructions and deciding what shape their output actually has.

### 1. Get the instructions

Ask Sandip to paste them, or read them from wherever he points. If he has the
task open in Claude, the prompt body is what you want, not the schedule UI
around it.

### 2. Decide the output shape

This is the judgement call. Look at what the task is asked to report and pick
the `custom_attributes` that match it. Defaults are
`title,detail,why_it_matters,source_ref`, which suit "find me things worth
knowing" tasks. Many tasks want something else:

- A monitoring task: `subject,status,changed_from,changed_to`
- A review queue: `title,url,age_days,blocked_on`
- A digest: `headline,summary,source,relevance`

Rules the manifest enforces, so get them right the first time:

- lower_snake_case only.
- The first attribute becomes the card's title, the second its body. Order them
  so the most identifying field is first.
- Every attribute is required on every item. If something only applies
  sometimes, the agent sends `""` rather than omitting the key.
- Anything policy should ever key on has to be declared here. A predicate can
  only read attributes that are on the item (TECH-SPEC §5.6).

### 3. Pick an id and a trigger

Kebab-case id, usually derived from what the task does: `morning-brief`,
`pr-review-queue`, `competitor-watch`. Pass `--cron` with the schedule the
Claude task runs on, in cron syntax.

### 4. Run it

```bash
pnpm import-task --id <id> --cron "<cron>" --attributes "<a,b,c>" --file <path>
```

Or pipe the instructions on stdin instead of `--file`.

### 5. Try it, then show him

```bash
pnpm run-capability <id>
```

Report what came back: how many findings, and what the first one looks like.
Then tell him it is in the Inbox and nothing has been acted on.

## After it exists

Say these three things, briefly:

1. **The prompt is editable without touching code.** It is in
   `capabilities/<id>/instructions.md`.
2. **Nothing fires it yet.** The in-process scheduler is v1 (TECH-SPEC §12
   step 17), so the declared cron is a declaration. Keep the Claude scheduled
   task running, or trigger it by hand, until then.
3. **It escalates everything.** An imported task has no track record through
   the review gate, so nothing it produces is auto-completed yet. Once he has
   seen a few rounds and trusts a class of them, that is a one-line change to
   `policy` in the manifest.

## Do not

- **Do not paraphrase the instructions.** Verbatim or not at all.
- **Do not set `auto_complete_when` on an import.** The whole point of bringing
  a task into Samaritan is that its output gets looked at first.
- **Do not point `execution.capability` at a real adapter yet.** It scaffolds
  `guided.fallback`, which renders the finding as copy-ready text and cannot
  fail. Change it once he knows where the output belongs.
- **Do not delete or disable the Claude scheduled task** without asking. Until
  the scheduler exists, that task is the only thing actually firing on a
  cadence.

## If the task does more than report

Some scheduled tasks act as well as observe: they file, message, or update
something. Those need a decision before importing.

Say what you noticed and ask. The action it performs becomes the item's
`execution`, and picking the adapter is a choice about how much autonomy that
action gets — which is exactly the choice Samaritan exists to make explicit.
Do not guess it.
