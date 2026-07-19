---
name: wrap
description: Session-close routine — scan the conversation for decisions, insights, people mentioned, next-step tasks, and file them all to Notion / TickTick / Obsidian. Use whenever Sandip types `/wrap`, says "we're done", "that's it for now", "thanks, let's wrap", "ok done", "alright, talk later", or any other session-ending phrase. Also auto-fire if a working session yields ≥3 structured items and Sandip is about to leave. Silent approval — file everything, then report. This is the single highest-leverage habit in the system.
---

# /wrap — Session Close

The most important skill in the PM OS. At the end of any work session, scan everything that was discussed, extract structured items, and file them everywhere they belong. Silent approval — no per-item prompts, just file and report.

## Why this matters

Without `/wrap`, every Claude conversation produces useful structured residue that disappears when the session ends. With `/wrap`, that residue automatically lands in Notion / TickTick / Obsidian where Sandip can find it later. The habit is worth ~80% of the system's value. Fire it eagerly — over-wrapping is recoverable, under-wrapping is data loss.

## System contract

- **Vault root:** `/Users/sandipdev/Documents/Obsidian/Samaritan/`
- **Today's daily note:** `Areas/Daily/YYYY-MM-DD.md`
- **Notion DBs:** Decisions `<decisions-db-id>`, Insights `<insights-db-id>`, People `<people-db-id>`, Projects `<projects-db-id>`
- **TickTick MCP namespace:** `mcp__<ticktick-mcp-server-id>__*`
- **Full system contract:** `AGENT_OS.md`.

## Process

1. **Scan the conversation.** Look for:
   - **Decisions** — statements where Sandip resolved or finalized a choice. Phrases like "we're going with", "decided to", "the call is", "ok, X it is", "shipping option B".
   - **Insights** — observations from research, analysis, customer/user feedback, competitive notes, things worth remembering as reference. Anything Sandip discovered or surfaced, not just acted on.
   - **Next-step tasks** — concrete actions someone needs to do. "I need to update the docs", "Sarah will run the test", "follow up with X by Friday".
   - **People** — anyone named who isn't already in the People DB or who has new context to record.
   - **Project touches** — any project mentioned. If a project doesn't exist in Notion yet but came up substantively, propose creating it.
   - **Hourly log gap** — if Sandip hasn't `/log`'d this hour, this conversation is itself a log entry.

2. **Apply routing rules** from `AGENT_OS.md`'s "Routing rules" section. Specifically:
   - Decision with no clear rationale → leave Status=pending, put what's known in Evidence. Don't invent rationale.
   - Next step with no owner → don't default to Sandip silently; either ask in the report or skip the task.
   - Insight with no clear project → file with Project blank, Tags=[unsorted].
   - New person → create People row first, then file the rest with the relation set.

3. **Write everything in parallel.** Don't ask permission per item — that's the explicit-approval flow, not /wrap.
   - Notion rows via `notion-create-pages`.
   - TickTick tasks via the TickTick MCP, in the appropriate project's TickTick project.
   - Obsidian: append a `## Session` entry to today's daily note summarizing what was filed.
   - If `/log` was missed for the current hour: write a reconstructed entry under `## Hourly Log` (use the conversation as the basis).

4. **Track the wrap.** Keep a record of every row, task, and file write in this wrap session so "undo last wrap" can reverse them. Append to `.samaritan/wrap-log.jsonl` in the vault root (create the file if missing):
   ```json
   {"wrap_id": "wrap-<timestamp>", "ts": "...", "decisions": [...], "insights": [...], "tasks": [...], "people": [...], "daily_note_appended": "..."}
   ```

5. **Report back** in a compact block. Be specific — link IDs and paths so Sandip can audit:
   ```
   Wrapped session-2026-05-30-14:32

   Decisions (2)
   - DEC-12 — Side-by-side pricing layout → [[Onboarding]]
   - DEC-13 — Deprecate v1 API by Q3 → [[API Migration]]

   Insights (1)
   - INS-44 — EU customers cite GDPR friction in step 3 (unsorted)

   Tasks (3)
   - Update release notes by Mon → TickTick [Onboarding]
   - Re-run load test → TickTick [Onboarding]
   - Follow up with Tomás re: SaaStr conversation → TickTick [Inbox]

   People (2)
   - Tomás García (new) — infra lead, Acme
   - Priya — Last Interaction → today

   Daily note: appended ## Session block + 14:00 [[Onboarding]] hourly log entry

   Say "undo last wrap" to reverse.
   ```

## Triggers (auto-fire conditions)

The slash command `/wrap` is explicit. The skill should ALSO fire silently when Sandip ends a session via natural language:
- "we're done", "that's it for now", "ok thanks", "alright I'm out", "thanks Claude", "later", "talk soon", "let's wrap"
- After ≥20 minutes of idle if structured items have been discussed
- When Sandip switches topic abruptly after a substantive work session

When auto-firing, still report the same compact block so Sandip knows what got filed.

## Undo

If Sandip says "undo last wrap", "revert that wrap", "scrap the wrap":
1. Read `.samaritan/wrap-log.jsonl`, find the most recent entry.
2. Delete the Notion rows (set in trash via `notion-update-page` → in_trash if supported, or note in the report that manual cleanup is needed for any rows that can't be auto-deleted).
3. Delete the TickTick tasks via `mcp__<ticktick-mcp-server-id>__delete_task`.
4. Remove the `## Session` block from today's daily note.
5. Remove the reconstructed hourly log entry.
6. Mark the wrap entry as `undone: true` in `wrap-log.jsonl`.
7. Confirm: `Undone. <N> rows + <M> tasks reversed.`

## Edge cases

- **Empty session** (just chitchat, no structured items): reply `Nothing to wrap.` Don't write empty rows.
- **Sandip explicitly says "don't file X"** during the session: respect it. Skip that item in the wrap.
- **Conflicting decisions** (Sandip went back and forth): file the final position only. Note the earlier one in Evidence if useful.
- **Sandip is mid-thought** but says "wrap": file what's clear, leave a note in the report: `2 items unclear, left unfiled. Mention if you want them filed: <brief>.`
- **Session crossed midnight:** use the session-start date for the daily note, not the wrap-fire date.
- **`/wrap` after another `/wrap` in same session:** file only items added since the last wrap.

## Why this matters (again)

The system fails if capture doesn't happen. Of all the capture skills, `/wrap` is the only one that requires zero discipline from Sandip — it picks up the residue automatically. Treat it as load-bearing.
