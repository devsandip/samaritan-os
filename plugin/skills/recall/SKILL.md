---
name: recall
description: Answer a question by querying the PM OS — Notion DBs first, then Obsidian files for prose context. Use whenever Sandip types `/recall [question]`, or asks questions like "what did we decide about X?", "who owns Y?", "remind me what we said about Z", "what's the status of [project]?", "what did I work on this week?". Ground every answer in row IDs and file paths so the source is auditable.
---

# /recall — Grounded Lookup Across the PM OS

Answer Sandip's question by querying Notion DBs and Obsidian files. Every claim should be sourced to a row ID, a file path, or both. If you can't ground a claim, say so.

## System contract

- **Notion DBs:** Projects `<projects-db-id>`, Decisions `<decisions-db-id>`, People `<people-db-id>`, Insights `<insights-db-id>`
- **Vault root:** `~/Documents/Obsidian/Samaritan/`
- **TickTick MCP** (for task questions): `mcp__<ticktick-mcp-server-id>__*`
- **Full system contract:** `AGENT_OS.md`.

## Query taxonomy → where to look first

| Question shape | First place to query |
|---|---|
| "what did we decide about X" | Notion Decisions, filter by Project = X or text search Rationale |
| "why did we decide X" | Notion Decisions row → read Rationale + Evidence |
| "who owns X" | Notion Projects → Owner; or Decisions → Decided By |
| "what's the status of X" | Notion Projects → Status, Last Updated |
| "what did I work on last week" | Obsidian Areas/Daily/ + Areas/Weekly/ + completed TickTick tasks |
| "what's stuck" | Notion Projects filter Status=blocked; weekly digest stalled section |
| "did I capture anything about X" | Obsidian search across daily Inbox + Notion Insights text search |
| "open questions on X" | Notion Insights filter Tags contains 'open-question' |
| "tell me about <person>" | Notion People row → Relationship Context + linked Projects |

## Process

1. **Classify the question.** Map to the taxonomy above. If ambiguous, ask one clarifying question.

2. **Query Notion first.** Structured data is faster and more reliable than searching prose. Use `notion-search` with `data_source_url` set to the relevant DB. For specific lookups (e.g., a known Decision ID), use `notion-fetch`.

3. **Follow links to prose.** For each Notion row that's relevant, check its Obsidian Link or follow the wikilink to the project file. Read the relevant prose context.

4. **For time-range questions** ("this week", "last quarter"): read the Obsidian daily/weekly notes in the range, plus filter Notion rows by date.

5. **Synthesize the answer.** Lead with the answer, then ground:
   ```
   <Answer in one or two sentences.>

   Sources:
   - DEC-12 (2026-05-20) — Side-by-side pricing layout
   - DEC-17 (2026-05-28) — Bumped to 4-week dev cycle after Q3 scope discussion
   - Areas/Daily/2026-05-25.md (## Hourly Log 14:00)
   ```

6. **If you can't find it:** say so explicitly. Don't fabricate.
   ```
   No matching decision found in Notion. The closest item is INS-44 (a pending open-question about pricing tier behavior). Either I'm searching wrong terms — want to give me a more specific query — or this wasn't captured.
   ```

## Examples

**Sandip:** `/recall why did we pick side-by-side over stacked for pricing`

1. Search Decisions for "side-by-side pricing".
2. Find DEC-12.
3. Read its Rationale + linked Obsidian note.

Reply:
```
We chose side-by-side because the user tests showed lower decision fatigue vs the stacked layout (Priya ran the test 2026-05-18).

Sources:
- DEC-12 (2026-05-20) — Side-by-side pricing layout → [[Onboarding Redesign]]
- Projects/Onboarding Redesign/User Tests 2026-05-18.md
```

**Sandip:** `/recall what's stuck this week`

1. Notion Projects filter Status=blocked.
2. Read each blocked project's last hourly log entries to see what the blocker is.

Reply:
```
3 projects blocked:
- [[Audit Pipeline]] — waiting on legal sign-off on retention policy (since 2026-05-22)
- [[Onboarding Redesign]] — blocked on copy review (Marketing owns)
- [[API Migration]] — blocked on staging perf issues

Sources:
- PRJ-3, PRJ-7, PRJ-11 (Notion)
- Areas/Weekly/2026-W21.md (## Stuck)
```

**Sandip:** `/recall what did I work on Tuesday`

1. Read Areas/Daily/2026-05-26.md (last Tuesday).
2. Parse `## Hourly Log` for project allocation.

Reply:
```
Tuesday (2026-05-26):
- 09:00–11:00 [[Onboarding]] — drafted pricing comparison
- 11:00–12:00 — meeting blocks (Acme sync, hiring)
- 13:00–15:00 [[Audit Pipeline]] — legal review prep
- 15:00–16:00 [[Onboarding]] — incorporating Priya's feedback

Source: Areas/Daily/2026-05-26.md
```

## Edge cases

- **Question references something Sandip mentioned earlier in *this* session:** include the conversation context as a source, e.g., `Source: this session, ~30 min ago`.
- **Question about something that was just `/wrap`'d:** fine to use the wrap-log if the row IDs aren't propagating fast enough.
- **Synthesized answer would require reading >20 files:** don't read all of them — search Notion for structured hits, sample a few Obsidian files, then say "based on a sample; full sweep available if you want."
- **Question is exploratory** ("anything interesting about pricing lately?"): expand the query — Decisions + Insights + recent dailies — and lead with a 3-bullet synthesis, not a single sentence.

## Why this matters

`/recall` is the payoff for everything the capture skills do. The whole system is worth nothing if it can't answer "what did we decide" three weeks later. Grounding every claim in row IDs and file paths means the user can audit — and means Claude can't bullshit.
