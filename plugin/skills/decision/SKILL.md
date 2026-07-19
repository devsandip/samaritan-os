---
name: decision
description: File a structured Decision row to Notion with rationale, project link, and reversibility classification. Use whenever Sandip types `/decision [what + why]`, or describes a decision he just made or is finalizing (e.g., "we decided to go with X because Y", "ok, going with X", "we're shipping option B", "final call - ship X"). Also use when finalizing a previously pending decision. Critical for the audit trail — decisions made and not filed are decisions lost.
---

# /decision — File a Structured Decision

Write a Decision row to Notion with full context: what was decided, why, which project, who decided, and reversibility. Also append a one-liner to the project's Obsidian file under `## Decisions`. If next steps fall out of the decision, propose TickTick tasks before exiting.

## System contract

- **Notion Decisions DB:** data source id `<decisions-db-id>`
- **Notion Projects DB:** data source id `<projects-db-id>`
- **Notion People DB:** data source id `<people-db-id>`
- **Vault root:** `~/Documents/Obsidian/Samaritan/`
- **TickTick:** use the MCP namespace `mcp__<ticktick-mcp-server-id>__*`
- **Full system contract:** `AGENT_OS.md` at vault root.

## Required fields per Decision

| Field | Source |
|---|---|
| Decision (title) | What was decided — one sentence |
| Rationale | Why — the reasoning, not just the choice |
| Project (relation) | Which project this affects |
| Decided By (relation → People) | Who made the call (default: Sandip) |
| Decided On (date) | Today, unless Sandip specifies otherwise |
| Reversibility | one-way / two-way (Bezos framing) |
| Source (URL) | Conversation, meeting note, email — best link available |
| Status | resolved (default) / pending (if still finalizing) |
| Evidence | Optional — only if there's specific evidence to cite |

## Process

1. **Parse the decision.** From Sandip's message extract: what was decided, the rationale, the project.

2. **Identify the project.**
   - If named, search Notion Projects DB for an exact or close match.
   - If matched, use that row's relation.
   - If not matched, **stop and ask**: "Is this a new project, or did you mean <closest match>?" Don't silently invent.
   - If genuinely no project applies, ask Sandip if this is a cross-cutting decision (rare — most decisions have a home).

3. **Identify "Decided By."**
   - Default to Sandip (Notion user, look up via `notion-get-users` if you don't have his ID cached).
   - If the message attributes the decision to someone else ("Priya decided"), search People DB. If not found, create the People row first.

4. **Identify rationale.**
   - If clearly provided, use it.
   - If absent ("we're going with X" with no why): **ask once** — "What was the reasoning?" Do not invent rationale.

5. **Classify reversibility.**
   - `two-way` (reversible — can be undone in <1 week with minimal cost): default for most product/process decisions.
   - `one-way` (hard to reverse — public commitments, hires, architectural choices that cascade): when stated as such or when the decision clearly has lasting downstream effects.
   - When ambiguous, default to `two-way` and note in Evidence that classification is uncertain.

6. **Write the Notion row** via `notion-create-pages` with parent `data_source_id: <decisions-db-id>`. Set all required fields. Capture the created row's URL.

7. **Append to the project's Obsidian file.**
   - Locate the project file: `Projects/<Project Name>/<Project Name>.md` or the project's main file.
   - Under `## Decisions` (create the section if missing), append:
     ```
     - YYYY-MM-DD — <one-line summary> ([DEC-N](notion-url))
     ```
   - If the project file doesn't exist yet, skip the Obsidian append and note it in the reply ("Project file not yet created — Notion row filed, link in /recall when ready").

8. **Detect next steps.** Scan the decision message for action items ("...and we need to update the docs by Friday"). For each:
   - If owner=Sandip, create a TickTick task in the project's TickTick project (look up via the Projects row's `TickTick Project ID` field).
   - If owner=someone else, note in the Obsidian append line but don't task-create.

9. **Confirm in one short block:**
   ```
   Filed: <Decision title> (DEC-N, two-way) → [[Project]]
   + 2 tasks added to TickTick
   ```

## Examples

**Sandip:** `/decision we're going with the side-by-side comparison layout for the pricing page because user tests showed lower decision fatigue vs the stacked layout. Project is Onboarding Redesign. Two-way.`

- Decision: "Side-by-side comparison for pricing page"
- Rationale: "User tests showed lower decision fatigue vs the stacked layout"
- Project: search → Onboarding Redesign found
- Decided By: Sandip
- Reversibility: two-way
- Source: this conversation URL (or leave blank)

Reply:
```
Filed: Side-by-side pricing layout (DEC-12, two-way) → [[Onboarding Redesign]]
```

**Sandip:** `/decision Decided to deprecate the v1 API by Q3.`

(No rationale.)
Ask: "What's driving the Q3 timeline — usage drop-off, maintenance load, or a customer commitment?"

After Sandip answers, file with rationale + reversibility=one-way (deprecation announcements are hard to walk back).

## Edge cases

- **Pending decision** (Sandip is still deciding): file with Status=pending, leave Decided By blank, populate Evidence with what's known so far. The `/file evidence` flow can update it later as more evidence accumulates.
- **Decision overturns a prior decision:** find the prior Decision row, set its Status=`reversed`, link to the new one in Evidence.
- **Sandip lists multiple decisions in one message:** file each separately. Reply with all DEC-Ns.
- **Decision with no project at all** (Sandip insists it's cross-cutting): file with Project blank, tag the row in a way the weekly review will surface.

## Why this matters

Decisions made and not filed are the #1 source of "wait, why did we do that?" three months later. The audit trail isn't bureaucracy — it's the answer to "should we reverse this?" when the context has faded.
