---
name: weekly
description: Generate a weekly digest of the past 7 days — what was worked on (from hourly log), decisions made, insights captured, what's stuck, what's next. Use whenever Sandip types `/weekly`, asks for a "weekly review", "weekly digest", "weekly rollup", "what did I do this week", or any phrase implying a 7-day synthesis. Also use when the Sunday 20:00 scheduled job fires. Writes a Markdown file to `Areas/Weekly/YYYY-Www.md` and pushes a condensed version to Telegram if Sandip wants.
---

# /weekly — Weekly Digest

Generate a synthesized view of the past 7 days. Time-allocate from the hourly log, surface decisions and insights, flag stuck projects, propose next-week focus. Write to Obsidian; optionally push to Telegram.

## Why this matters

Most PMs end the week with no clear answer to "what did I actually do?" — the calendar shows meetings, but not the substance. The weekly digest converts captured signal (hourly log entries, decisions filed, insights surfaced) into a real answer. Over time, it also becomes the input for monthly/quarterly reviews.

## System contract

- **Vault root:** `~/Documents/Obsidian/Samaritan/`
- **Output:** `Areas/Weekly/YYYY-Www.md` (ISO week number)
- **Inputs:**
  - `Areas/Daily/YYYY-MM-DD.md` for the past 7 days (or the requested range)
  - Notion Decisions, Insights, Projects filtered by date
  - TickTick completed tasks for the range
- **Full system contract:** `AGENT_OS.md`.

## Process

1. **Determine the week range.**
   - Default: the past 7 days from today (rolling).
   - If Sandip names a week ("week of May 19"), use ISO week containing that date.
   - If it's Sunday 20:00 (scheduled), the range is the week that just ended.

2. **Pull inputs.**
   - **Daily notes:** read each `Areas/Daily/YYYY-MM-DD.md` in range. Parse `## Hourly Log` for `### HH:00 [[Project]]` headings. Count hours per project.
   - **Decisions:** Notion query Decisions DB filter Decided On in range.
   - **Insights:** Notion query Insights DB filter Captured On in range.
   - **Projects:** Notion query Projects DB, sort by Last Updated, identify any with Status=blocked.
   - **Tasks:** TickTick completed tasks in range (`list_completed_tasks_by_date`).

3. **Compute time allocation.** From hourly log:
   - Total logged hours (treat each `### HH:00` entry as 1 hour, even if it's a fragment).
   - Per-project breakdown: sum hours by `[[Project]]` link.
   - Flag projects where hours don't match expected priority (Sandip will know what looks off).

4. **Identify stuck items.**
   - Projects in `blocked` status with no recent activity in hourly log → stuck.
   - Open questions (Insights tagged `open-question`) from earlier in the week with no Decision filed → still open.
   - Tasks overdue (TickTick due date < today, status open) → consider escalating.

5. **Propose next week.**
   - For each active project, suggest the next logical step based on what's in the hourly log + open Decisions/Insights.
   - Be brief — 1 line per project. Sandip will edit.

6. **Write the file** at `Areas/Weekly/YYYY-Www.md`:
   ```markdown
   ---
   type: weekly
   week: YYYY-Www
   range: YYYY-MM-DD to YYYY-MM-DD
   created: YYYY-MM-DD
   ---
   # Week YYYY-Www

   ## TL;DR
   <3-bullet summary of the week — what got shipped, what's stuck, what's the focus next week>

   ## Time allocation
   Total logged: <N>h across <M> projects.
   - [[Project A]] — <Xh> (<X%>)
   - [[Project B]] — <Yh> (<Y%>)
   - Meetings — <Zh> (logged with no project link)

   ## Decisions made (<count>)
   - DEC-<n> — <title> → [[Project]]
   - ...

   ## Insights captured (<count>)
   - INS-<n> — <title> (<tags>)
   - ...

   ## Shipped / Completed
   - <task or milestone> → [[Project]]
   - ...

   ## Stuck / Drifting
   - [[Project]] — <why stuck, since when>
   - INS-<n> — open question, no Decision in <N> days

   ## Next week focus
   - [[Project A]] — <proposed next step>
   - [[Project B]] — <proposed next step>

   ## Open questions for Sandip
   - <anything Claude couldn't determine — e.g., "no project link on 6h of hourly log entries — which projects?">
   ```

7. **Telegram condense (optional).** If Sandip asks `/weekly --telegram` or it's the scheduled run, push a 5-bullet summary to Telegram with the link to the full file.

8. **Project pulse pass.** For each active Project in Notion, update Last Updated and propose a Status flip if the data suggests:
   - active → blocked if no hourly log entries this week AND there's an open question.
   - active → shipped if a "shipped" decision was filed this week.
   - blocked → active if hours were logged unblocking it.
   Don't auto-change Status — propose in the report and let Sandip approve.

9. **Report back:**
   ```
   Week 2026-W22 digest written → Areas/Weekly/2026-W22.md
   - 31h logged across 4 projects ([[Onboarding]] 14h, [[Acme]] 8h, [[Audit]] 6h, [[Hiring]] 3h)
   - 5 decisions, 7 insights, 12 tasks completed
   - 2 stuck: [[Audit Pipeline]] (legal), [[API Migration]] (perf)
   - Status flip proposals: [[Onboarding Redesign]] active → shipped (DEC-12 filed)
   ```

## Examples

**Sandip:** `/weekly`

Pull last 7 days, write the digest, report.

**Sandip:** `/weekly week of May 12`

Use ISO week containing 2026-05-12 (= 2026-W20). Write to `Areas/Weekly/2026-W20.md` (or update if exists).

**Scheduled run (Sunday 20:00):** auto-fire with current week's range, write file, push 5-bullet Telegram summary.

## Edge cases

- **Hourly log was sparse this week** (< 10 entries): note in `## Open questions for Sandip` — synthesis quality scales with capture density. Don't fabricate.
- **No daily notes for some days** (Sandip didn't `/log` at all): use TickTick completions + Notion activity + calendar as a fallback signal.
- **Weekly already exists for this week:** if `/weekly` is run again same week, regenerate the file (don't append). Note in the report: `Overwrote prior digest from <ts>.`
- **Sandip asks for a custom range** ("last 2 weeks"): expand the range, write to a `Custom-YYYY-MM-DD-to-YYYY-MM-DD.md` file rather than overwriting a week file.

## What this skill is NOT

Not a daily standup — that's the morning briefing (separate scheduled job).
Not a quarterly review — that needs a different lens (objectives vs. activity).
Not a status report for stakeholders — that's the `stakeholder-update` skill from the product-management plugin.

## Why this matters (again)

The weekly digest is the moment when captured signal converts to *thinking*. It's also the artifact Sandip will skim in two months when he's trying to reconstruct what happened in May. Don't write it for today; write it for future-Sandip.
