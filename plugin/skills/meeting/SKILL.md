---
name: meeting
description: Process a meeting into a structured Obsidian note plus extracted items sent to the Action Center for review. Use whenever Sandip types `/meeting [topic]`, has a Fireflies transcript available, finishes a call, or wants to file something that just happened in a meeting. Also use when a Fireflies post-meeting sweep fires automatically. Decisions and next steps from meetings are the highest-yield structured items in the system — don't let them sit in transcripts.
---

# /meeting — Process a Meeting

Create an Obsidian meeting note, extract structured items, and send them to the Action Center. Sandip reviews each one in the Inbox and approves what gets filed.

## The review gate

**This skill no longer writes to Notion or TickTick.** It emits extracted items to the Action Center, which holds each one until Sandip approves it.

Meeting extraction carries more inference risk than any other input: it is a summary of a transcript of a conversation, often one Sandip was only half-present for. Gating it is the point.

The Obsidian meeting note is **not** gated. It is a local, reversible file, and writing it is what makes the extraction reviewable in the first place. Write it directly.

Do not call `notion-create-pages` or the TickTick MCP from this skill. If the Action Center is unreachable, say so and stop.

## System contract

- **Vault root:** `~/Documents/Obsidian/Samaritan/`
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

3. **Extract structured items and emit them.** Iterate through the transcript / notes and build one `meeting-item-review` item per thing found:

   **a. Decisions** → `kind: "decision"`. `evidence` = the discussion that led to it. A decision that was discussed but not finalized still goes in, with `detail` saying it is pending.

   **b. Next steps** → `kind: "task"`. Identify the owner; if unclear, ask rather than defaulting to Sandip. Emit tasks owned by other people too, with `owner` set to their name: the Action Center will surface them for review, and Sandip decides whether to track them. Do not create tasks in other people's systems.

   **c. Open questions** → `kind: "insight"` with `detail` carrying the full question and context.

   **d. Attendees** → `kind: "person"`, one per attendee who is new or has new context worth recording. Skip attendees with nothing new.

   Then pipe them all to `samaritan emit` in one call:

   ```bash
   cd ~/Developer/samaritan && cat <<'JSON' | pnpm -s emit
   {
     "capability_id": "meeting",
     "items": [
       {
         "type": "meeting-item-review",
         "context": {
           "what_happened": "Acme weekly sync, 2026-05-30",
           "source": { "kind": "meeting", "id": "fireflies-abc123", "link": "https://app.fireflies.ai/view/abc123" },
           "provenance": ["fireflies.transcript_ready", "meeting.run"],
           "why_flagged": "meeting extraction is always reviewed",
           "trigger_reason": "action_type",
           "confidence": 0.78,
           "decision_needed": "File this decision to Notion?",
           "decision_surface": "inbox",
           "execution_surface": "notion",
           "outcome_preview": "Creates a Decision row: \"Push GA to next Tuesday\""
         },
         "custom": {
           "kind": "decision",
           "title": "Push GA to next Tuesday",
           "detail": "Staging env had perf issues under load",
           "project": "Pricing rollout",
           "owner": "",
           "due": "",
           "evidence": "Priya raised p99 latency at 3x baseline; Raj confirmed",
           "meeting_topic": "Acme weekly sync",
           "meeting_date": "2026-05-30",
           "meeting_note_path": "Areas/Meetings/2026-05-30 - Acme weekly sync.md"
         },
         "dedupe_key": "meeting:fireflies-abc123:0"
       }
     ]
   }
   JSON
   ```

   Rules:
   - **Every `custom` field is required.** Send `""` for anything that does not apply. Omitting a key is rejected.
   - **`dedupe_key`** is `meeting:<transcript-or-meeting-id>:<index>`. Stable across re-runs of the same meeting, so re-processing updates rather than duplicates.
   - **`confidence`** should be genuinely lower for a transcript Sandip was not present for. Say why in `why_flagged`.
   - Set `meeting_note_path` on every item so the reviewer can jump back to the note.

4. **Leave the meeting note's links as placeholders.** Nothing has a Notion URL yet, because nothing is filed yet. Write `## Decisions` and `## Open Questions` as plain bullets and note at the top of the file: `Structured items are awaiting review in the Action Center.` They can be backfilled after approval; do not fabricate row IDs.

5. **Confirm in a short report:**
   ```
   Processed: Acme weekly sync (2026-05-30) — 8 items awaiting review
   - Meeting note → Areas/Meetings/2026-05-30 - Acme weekly sync.md
   - 2 decisions, 3 next steps, 1 open question, 2 people
   - Review and approve: http://127.0.0.1:4173
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

- **Action Center unreachable:** `samaritan emit` exits 1. Report it and stop. Do NOT fall back to writing to Notion directly. The meeting note is already written, so nothing is lost; tell Sandip to run `pnpm serve` and offer to re-emit.
- **No project clear from the topic:** ask once. Don't emit items against a wrong project.
- **Transcript references decisions that were _almost_ made but not finalized:** emit them with `evidence` = the discussion summary and `detail` noting they are pending. Lower the `confidence`.
- **Big meeting (>10 attendees):** still update People for each, but consider tagging the meeting note `large-meeting` so the weekly review can deprioritize it for People updates if noisy.
- **Recurring meeting (e.g., daily standup):** keep filing decisions and tasks, but the meeting note can be terser — sometimes a 3-bullet `## Discussion` is enough.
- **Sandip wasn't in the meeting** (got the transcript secondhand): still file decisions and insights, but skip the TickTick task creation (he can decide what to action) and note in the report that he wasn't an attendee.

## Why this matters

A meeting with 3 decisions, 4 next steps, and 2 open questions that doesn't get processed becomes a 60-minute conversation that produced zero structured output. Multiply by 10 meetings a week and the loss is enormous. `/meeting` exists to make that loss impossible.
