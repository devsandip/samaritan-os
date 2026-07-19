---
name: file
description: Explicitly file a typed structured row to Notion with no extraction or inference. Use whenever Sandip types `/file [type] [content]` where type is one of decision / insight / person / project. Bypass the conversational flow — Sandip has decided exactly what he wants written. Also use when Sandip says "just file it as X" or "skip the questions, write this as a Y row".
---

# /file — Direct Notion Filing

Explicit, no-magic write to Notion. Sandip specifies the type, you write the row. No inference, no clarifying questions unless a required field is genuinely missing.

## System contract

| Type | Notion data source ID |
|---|---|
| decision | `<decisions-db-id>` |
| insight | `<insights-db-id>` |
| person | `<people-db-id>` |
| project | `<projects-db-id>` |

Full system contract: `AGENT_OS.md`.

## Syntax

`/file <type> <content>` — content can be free-text or include key:value pairs to populate specific fields.

Examples:
- `/file decision Switched to PostgreSQL for the audit log. Project: Audit Pipeline. Reversibility: one-way.`
- `/file insight Customers in EU consistently mention GDPR friction in onboarding step 3.`
- `/file person Tomás García, infra lead at Acme, met at SaaStr.`
- `/file project Onboarding Redesign — owner: me, area: product, status: active`

## Process

1. **Parse the type.** Must be one of `decision`, `insight`, `person`, `project`. If not, reply: "Type must be decision, insight, person, or project. What did you mean?"

2. **Parse the content.**
   - Extract any explicit `key: value` pairs.
   - Use the remaining text as the title or main field.

3. **Identify required fields.** Per type:
   - **decision** — required: Decision (title), Project. Optional: Rationale, Reversibility, Decided By.
   - **insight** — required: Insight (title). Optional: Detail, Project, Tags, Source.
   - **person** — required: Name. Optional: Role / Org, Relationship Context, Projects.
   - **project** — required: Name. Optional: Status (default: planning), Owner, Area, Obsidian Link, TickTick Project ID.

4. **If a required field is missing, ask exactly once.** Don't do an interrogation. If Sandip used `/file` he wants this fast.

5. **For relations** (Project, Decided By, Projects):
   - Search the relevant DB.
   - If matched, use the relation.
   - If not matched, ask: "<X> not found in <DB>. Create it, or did you mean <closest match>?"

6. **Write the row** via `notion-create-pages`.

7. **One-line confirm.** `Filed insight INS-44 (cross-cutting).`

## Examples

**Sandip:** `/file decision Switched to PostgreSQL for the audit log. Project: Audit Pipeline. Reversibility: one-way.`

Parse: type=decision, title="Switched to PostgreSQL for the audit log", Project="Audit Pipeline", Reversibility="one-way". No rationale — ask once, then file.

**Sandip:** `/file insight Customers in EU consistently mention GDPR friction in onboarding step 3.`

Parse: type=insight, title=full text. No project specified → file with Project blank, Tags=[unsorted]. The nightly review will tag it.

Reply: `Filed INS-44 (unsorted). The Sunday review will retag if it fits a project.`

**Sandip:** `/file person Tomás García, infra lead at Acme, met at SaaStr.`

Parse: type=person, Name="Tomás García", Role / Org="infra lead at Acme", Relationship Context="met at SaaStr".

Reply: `Filed Tomás García (people).`

**Sandip:** `/file project Onboarding Redesign — owner: me, area: product, status: active`

Parse: type=project, Name="Onboarding Redesign", Owner=Sandip, Area="product", Status="active". Also: create the matching Obsidian folder at `Projects/Onboarding Redesign/` and a stub `Onboarding Redesign.md` with project frontmatter. Note the Obsidian Link in the Notion row.

Reply: `Filed PRJ-7 (Onboarding Redesign). Created vault folder + stub file. Want me to create a TickTick project too?`

## Edge cases

- **Ambiguous type abbreviation** (`/file d ...`): ask, don't guess.
- **Sandip uses `/file` for something that fits a higher-level skill** (e.g., `/file meeting ...`): redirect to `/meeting`. Meetings aren't a Notion type; they're a workflow.
- **Multiple rows in one `/file`** ("file these three insights..."): file each, return all IDs in the confirm.

## Why this skill exists

Sometimes Sandip has done the thinking already and wants the system to just write the damn row. `/decision`, `/meeting`, etc. have inference logic that's useful most of the time but is friction when he just wants to file. `/file` is the bypass.
