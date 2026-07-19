---
name: meeting
description: Process a meeting into a structured Obsidian note + extracted Notion rows + TickTick tasks. Use whenever Sandip types `/meeting [topic]`, has a Fireflies transcript available, finishes a call, or wants to file something that just happened in a meeting. Also use when a Fireflies post-meeting sweep fires automatically. Decisions and next steps from meetings are the highest-yield structured items in the system — don't let them sit in transcripts.
---

# /meeting — Process a Meeting

Create an Obsidian meeting note, extract structured items, file them to Notion + TickTick. Update People DB for attendees.

## System contract

- **Vault root:** `/Users/sandipdev/Documents/Obsidian/Samaritan/`
- **Meeting notes location:** `Areas/Meetings/YYYY-MM-DD - <topic>.md`
- **Notion DBs:** Decisions `<decisions-db-id>`, Insights `<insights-db-id>`, People `<people-db-id>`, Projects `<projects-db-id>`
- **Fireflies MCP** (if connected): pull transcript by date or meeting id.
- **TickTick MCP namespace:** `mcp__<ticktick-mcp-server-id>__*`
- **Full system contract:** `AGENT_OS.md`.

## Inputs

The meeting content comes from one of:
1. **Fireflies transcript** (post-meeting sweep or `/meeting` after a recorded call). Pull via Fireflies MCP.
2. **Sandip's notes pasted into chat.**
3. **A summary Sandip dictates after the meeting.**

If you have access to a Fireflies transcript for the same date and topic, prefer it (more complete).

## Process

1. **Determine the meeting metadata.**
   - Date: today by default, or the meeting date if specified.
   - Topic / title: from Sandip's prompt or the Fireflies title.
   - Attendees: from Fireflies, calendar, or ask.
   - Project: infer from topic/attendees; if unclear, ask.

2. **Create the Obsidian meeting note** at `Areas/Meetings/YYYY-MM-DD - <topic>.md`:
   ```markdown
   ---
   type: meeting
   date: YYYY-MM-DD
   project: "[[Project Name]]"
   attendees: [Sandip, Alice, Bob]
   transcript: <fireflies url if any>
   ---
   # YYYY-MM-DD — <topic>

   ## Context
   <one-line on why this meeting happened>

   ## Discussion
   <bullet summary, 5–10 bullets max, not a transcript dump>

   ## Decisions
   - <decision 1> ([DEC-N](notion-url))
   - <decision 2> ([DEC-N+1](notion-url))

   ## Next Steps
   - [ ] @sandip — <action> (by <date>) ([TickTick](url))
   - [ ] @alice — <action>

   ## Open Questions
   - <question 1> ([INS-N](notion-url))
   ```

3. **Extract structured items.** Iterate through the transcript / notes:

   **a. Decisions.** For each decision identified, call the `decision` skill's logic (or directly write Notion Decisions rows). Project = the meeting's project. Decided By = the speaker who made the call. Source = the meeting note path or Fireflies URL.

   **b. Next steps.** For each:
   - Identify owner. If unclear from context, ask. Don't default to Sandip silently.
   - If owner = Sandip: create a TickTick task via `mcp__<ticktick-mcp-server-id>__create_task` in the project's TickTick project (look up `TickTick Project ID` from the Projects row). Task title = the action, due date if mentioned.
   - If owner = someone else: list in the meeting note's `## Next Steps` only. Do NOT create tasks in others' systems.

   **c. Open questions.** For each, create a Notion Insights row with Tags=`[open-question]`, Project linked. Keep the title short and the Detail field as the full question with context.

4. **Update People DB.**
   - For each attendee, look up by name in People DB.
   - If exists: update `Last Interaction` to today.
   - If new: create a row with Name, Role / Org (if known from the transcript), and link to the project.

5. **Backfill the meeting note** with the row IDs/URLs you just created (so the Obsidian note links to the structured rows).

6. **Confirm in a short report:**
   ```
   Filed: Acme weekly sync (2026-05-30)
   - Meeting note → Areas/Meetings/2026-05-30 - Acme weekly sync.md
   - 2 decisions → DEC-12, DEC-13
   - 3 tasks → TickTick (1 mine, 2 theirs)
   - 1 open question → INS-44
   - 2 People updated (Priya, Raj), 1 new (Tomás)
   ```

## Examples

**Sandip:** `/meeting Acme weekly sync`

(Fireflies transcript available for today.)

Pull transcript. Identify: Sandip, Priya (Acme PM), Raj (Acme eng). Topic = pricing rollout. Decisions: (1) push GA to next Tuesday because the staging env had perf issues. Next steps: (Sandip) update the release notes by Monday; (Priya) re-run the load test. Open questions: do we need to communicate the delay to Tier-1 customers?

Output as above.

**Sandip:** `/meeting Hiring sync — pasting my notes:
- Decided to make Aarav an offer, $X comp
- Need to finish reference checks this week (Karthik owns)
- Open: who covers infra interview if Aarav declines`

No transcript — work from Sandip's pasted notes. Same flow: create note, extract structured items.

## Edge cases

- **No project clear from the topic:** ask once. Don't file rows against a wrong project.
- **Transcript references decisions that were _almost_ made but not finalized:** file as pending Decisions with Status=pending, Evidence=the discussion summary.
- **Big meeting (>10 attendees):** still update People for each, but consider tagging the meeting note `large-meeting` so the weekly review can deprioritize it for People updates if noisy.
- **Recurring meeting (e.g., daily standup):** keep filing decisions and tasks, but the meeting note can be terser — sometimes a 3-bullet `## Discussion` is enough.
- **Sandip wasn't in the meeting** (got the transcript secondhand): still file decisions and insights, but skip the TickTick task creation (he can decide what to action) and note in the report that he wasn't an attendee.

## Why this matters

A meeting with 3 decisions, 4 next steps, and 2 open questions that doesn't get processed becomes a 60-minute conversation that produced zero structured output. Multiply by 10 meetings a week and the loss is enormous. `/meeting` exists to make that loss impossible.
