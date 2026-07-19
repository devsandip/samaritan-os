---
name: wrap
description: Session-close routine — scan the conversation for decisions, insights, people mentioned, next-step tasks, and send them to the Action Center for review. Use whenever Sandip types `/wrap`, says "we're done", "that's it for now", "thanks, let's wrap", "ok done", "alright, talk later", or any other session-ending phrase. Also auto-fire if a working session yields ≥3 structured items and Sandip is about to leave. Extract everything, emit it, then report. This is the single highest-leverage habit in the system.
---

# /wrap — Session Close

The most important skill in the PM OS. At the end of any work session, scan everything that was discussed, extract structured items, and send them to the Action Center. Sandip reviews each one in the Inbox and approves what gets filed.

## Why this matters

Without `/wrap`, every Claude conversation produces useful structured residue that disappears when the session ends. With `/wrap`, that residue reliably reaches the Action Center, and from there Notion / TickTick / Obsidian. The habit is worth ~80% of the system's value. Fire it eagerly — over-wrapping is recoverable, under-wrapping is data loss.

## The review gate

**This skill no longer writes to Notion or TickTick.** It emits extracted items to the Action Center, which holds each one in the Inbox until Sandip approves it. He can approve, edit-then-approve, discard, or defer per item, and the Action Center performs the actual write.

Extraction is inference over a conversation, which is the least certain input in the system. Gating it is the point, not an inconvenience. Over-extract if unsure: a wrong item costs one click to discard, a missed one is gone.

Do not call `notion-create-pages`, the TickTick MCP, or any other filing tool from this skill. If the Action Center is unreachable, say so and stop — do not fall back to writing directly.

## System contract

- **Vault root:** `~/Documents/Obsidian/Samaritan/`
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

3. **Emit every extracted item to the Action Center.** One `wrap-item-review` item per thing you found. Build a JSON payload and pipe it to `samaritan emit`:

   ```bash
   cd ~/Developer/samaritan && cat <<'JSON' | pnpm -s emit
   {
     "capability_id": "wrap",
     "items": [
       {
         "type": "wrap-item-review",
         "context": {
           "what_happened": "Wrapped a session on the storage layer",
           "source": { "kind": "session", "id": "sess-2026-07-19-1432" },
           "provenance": ["wrap.run"],
           "why_flagged": "session extraction is always reviewed",
           "trigger_reason": "action_type",
           "confidence": 0.9,
           "decision_needed": "File this decision to Notion?",
           "decision_surface": "inbox",
           "execution_surface": "notion",
           "outcome_preview": "Creates a Decision row: \"Use node:sqlite\""
         },
         "custom": {
           "kind": "decision",
           "title": "Use node:sqlite instead of better-sqlite3",
           "detail": "No prebuilt binary for Node 26",
           "project": "Samaritan",
           "owner": "",
           "due": "",
           "evidence": "pnpm refused to run the build script"
         },
         "dedupe_key": "wrap:sess-2026-07-19-1432:0"
       }
     ]
   }
   JSON
   ```

   Rules for building items:
   - **`custom.kind`** is one of `decision`, `insight`, `task`, `person`, `note`. It decides where the item is filed after approval.
   - **Every `custom` field is required.** Send `""` for anything that does not apply to that kind. Omitting a key is rejected.
   - **`dedupe_key`** must be stable for the same logical item and unique across items: `wrap:<session-id>:<index>` works. Re-running `/wrap` with the same key updates the pending item rather than creating a duplicate.
   - **`confidence`** is your genuine 0..1 confidence in the extraction. It is recorded and shown at review time.
   - **`outcome_preview`** is what Sandip reads to decide. Make it concrete: name the database and quote the title.

4. **Write the Obsidian side directly.** The vault is local and reversible, so it is not gated:
   - Append a `## Session` entry to today's daily note summarizing what was extracted.
   - If `/log` was missed for the current hour, write a reconstructed entry under `## Hourly Log`.

5. **Report back** what is waiting for review. Be specific, and give the count:
   ```
   Wrapped session-2026-05-30-14:32 — 8 items awaiting review

   Decisions (2)
   - Side-by-side pricing layout → [[Onboarding]]
   - Deprecate v1 API by Q3 → [[API Migration]]

   Insights (1)
   - EU customers cite GDPR friction in step 3 (unsorted)

   Tasks (3)
   - Update release notes by Mon → [Onboarding]
   - Re-run load test → [Onboarding]
   - Follow up with Tomás re: SaaStr conversation → [Inbox]

   People (2)
   - Tomás García (new) — infra lead, Acme
   - Priya — Last Interaction → today

   Daily note: appended ## Session block + 14:00 [[Onboarding]] hourly log entry

   Review and approve: http://127.0.0.1:4173
   ```

## Triggers (auto-fire conditions)

The slash command `/wrap` is explicit. The skill should ALSO fire silently when Sandip ends a session via natural language:
- "we're done", "that's it for now", "ok thanks", "alright I'm out", "thanks Claude", "later", "talk soon", "let's wrap"
- After ≥20 minutes of idle if structured items have been discussed
- When Sandip switches topic abruptly after a substantive work session

When auto-firing, still report the same compact block so Sandip knows what got filed.

## Undo

Undo is mostly obsolete now: nothing is filed until Sandip approves it, so a bad wrap is discarded in the Inbox rather than reversed after the fact.

If Sandip says "undo last wrap", "revert that wrap", "scrap the wrap":
1. Reject the still-pending items from this wrap. They share a `dedupe_key` prefix, so list them and reject each:
   ```bash
   curl -s '127.0.0.1:4173/api/actions?capability_id=wrap&status=pending'
   curl -s -X POST 127.0.0.1:4173/api/actions/<id>/respond \
     -H 'content-type: application/json' -d '{"response_id":"reject"}'
   ```
2. Remove the `## Session` block from today's daily note.
3. Remove the reconstructed hourly log entry.
4. Confirm: `Undone. <N> pending items rejected.`

Anything Sandip already approved has been filed and is **not** reversible from here. Say so plainly and point at the Notion row, rather than implying it was undone.

## Edge cases

- **Empty session** (just chitchat, no structured items): reply `Nothing to wrap.` Don't emit empty items.
- **Action Center unreachable:** `samaritan emit` exits 1 with a message. Report it and stop. Do NOT fall back to writing to Notion directly — that would defeat the gate. Tell Sandip to run `pnpm serve` in `~/Developer/samaritan`, and offer to re-run `/wrap` after.
- **Some items rejected** (exit code 2): the accepted ones are already in the Inbox. Report which were rejected and why; fix the payload and re-emit only those.
- **Sandip explicitly says "don't file X"** during the session: respect it. Don't emit that item at all.
- **Conflicting decisions** (Sandip went back and forth): emit the final position only. Note the earlier one in `evidence`.
- **Sandip is mid-thought** but says "wrap": emit what's clear, and say what you held back: `2 items unclear, not emitted. Mention if you want them: <brief>.`
- **Session crossed midnight:** use the session-start date for the daily note and for the `dedupe_key`, not the wrap-fire date.
- **`/wrap` after another `/wrap` in same session:** emit only items added since the last wrap. Reusing a `dedupe_key` from the earlier wrap updates that item in place if it is still pending, which is the desired behaviour when an extraction is being corrected.

## Why this matters (again)

The system fails if capture doesn't happen. Of all the capture skills, `/wrap` is the only one that requires zero discipline from Sandip — it picks up the residue automatically. Treat it as load-bearing.
