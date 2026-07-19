---
title: Samaritan — UI Specification
subtitle: Visual system, information architecture, and the render-schema mechanism for the Action Center
owner: Sandip Dev
status: Draft v0.1
date: 2026-07-19
companion_docs: [PRD.md, TECH-REQUIREMENTS.md, TECH-SPEC.md, PRFAQ.md]
source_of_truth: [samaritan-app.html, action-center-mockup.html]
---

# Samaritan — UI Specification

Samaritan's Action Center is the universal HITL layer and pluggable capability platform described in `PRD.md` — "one inbox for everything that needs Sandip." This document specifies its UI: the visual system, the information architecture, and — the part that makes it a platform rather than a screen — the **render-schema mechanism** that turns a capability's manifest into a rendered surface with zero bespoke UI code per capability. It is a companion to `PRD.md` (product & architecture), `TECH-REQUIREMENTS.md`, `TECH-SPEC.md`, and `PRFAQ.md`.

**Visual source of truth:** `samaritan-app.html` (the full five-view app shell — Dashboard, Inbox, Deferred, Completed, Settings) and `action-center-mockup.html` (a detailed, standalone exploration of the Inbox's four schema-driven detail surfaces). Every component, token, and state below traces back to markup in one or both of these files; where the two diverge, this document reconciles them into one buildable system and says so explicitly (§3.4). The mockups render only the *default, populated* state of each view — empty, loading, error, and confirmation states are specified here, using the same component vocabulary and tokens, so they feel native rather than bolted on.

---

## 1. Design principles

**At-a-glance command center.** Dashboard is the default view and answers "what's the state of my world" in one screenful, no scrolling: four stat tiles, the plugged-in-agents grid, "needs you now," and "handled automatically today" (`samaritan-app.html` `.tiles`, `.agents`, `.grid2`). If Sandip has to hunt for it, the dashboard has failed.

**Act fast.** Every surface that asks for a decision puts the allowed responses directly under the content, one click away — approve / edit / reject / defer / ask-more-info render as buttons (`.actions`), never buried in a menu. Batch approve exists for low-risk volume (checked rows in the meetings surface) so triage doesn't become its own chore.

**Schema-driven surfaces, not a generic form.** The Action Center never hand-builds UI per capability. A capability declares a `render` schema in its manifest (`PRD.md` §6); the Action Center maps it to one of four layout primitives (card / form / document / diff) and a fixed field-to-component table. This is what makes "the 20th capability costs almost nothing" true at the UI layer, not only the backend — see §4, the heart of this spec.

**Trust through visible work, not blind automation.** Every view that shows automation also shows its receipts: the Dashboard's "Handled automatically today" feed, the Completed audit trail, and a mode badge on every single item so Sandip always knows — before he clicks — whether a button executes something or only stages it.

**Local-first, calm, non-intrusive.** No shadows, no elevation, no motion-heavy chrome, no red unless something is actually urgent or broken. A flat visual language built from 1px borders and background layering (see §2.5) — infrastructure, not another app fighting for attention.

---

## 2. Design tokens

### 2.1 Color

| Token | Hex | Used for |
|---|---|---|
| `--core` (indigo) | `#4f46e5` | Brand mark, active nav item, "Guided" badge, priority dot (normal), why-now callout border, primary buttons |
| `--core-soft` | `#eef0fe` | Guided badge background, "Sent" decision-tag background |
| `--work` (blue) | `#2563eb` | Work-lane source tag |
| `--personal` (amber) | `#b45309` | Personal-lane source tag *(identical hex to `--assist` — see 2.6)* |
| `--coding` (cyan) | `#0e7490` | Coding-lane source tag |
| `--job` (violet) | `#7c3aed` | Job-search-lane source tag |
| `--assist` (amber) | `#b45309` | "Assisted" mode badge text |
| `--assist-soft` | `#fdf1e0` | Assisted badge background, "Edited" decision-tag background |
| `--auto` (green) | `#047857` | "Automated" mode badge, "good"/commit buttons, reversible tag, "Approved" decision tag, agent name in the auto-handled feed |
| `--auto-soft` | `#e2f6ee` | Automated badge background, reversible-tag background, Approved-tag background |
| `--guided` | `#4f46e5` | "Guided" mode badge text *(identical hex to `--core` — see 2.6)* |
| `--guided-soft` | `#eef0fe` | Guided badge background |
| `--urgent` / `--err` (red) | `#dc2626` | Urgent badge, alert stat tile, urgent priority dot, irreversible tag, error status dot |
| `--ok` (green) | `#059669` | Status dot, "active" — deliberately distinct from `--auto` green; a status dot answers "is it running," a badge answers "how does it act" |
| `--idle` (grey) | `#9aa3b2` | Status dot, "idle" |
| `--ink` | `#1a1d24` | Primary text |
| `--muted` | `#616b7a` | Secondary text, meta lines, timestamps |
| `--line` | `#e3e6ec` | 1px borders everywhere |
| `--line2` | `#f0f1f5` (app) / `#eef0f4` (mockup) | Hairline dividers, near-bg — nearly invisible, used for table row rules |
| `--bg` | `#eef0f4` | Page background |
| `--surface` | `#ffffff` | Card, panel, and item background |
| neutral tag bg | `#f0f1f4` | Default/neutral badges, "Dismissed"/"Rejected" decision tag |
| draft field bg | `#fffef8` | Editable textarea — a warm off-white that visually flags "provisional, yours to edit" |
| list-pane bg | `#f7f8fb` | Inbox list column, quote blocks, meeting-group header bars |
| alert tile bg / border | `#fef6f6` / `#f3c9c9` | Alert stat tile, error-state agent/connection card |
| sidebar bg | `#151a26` | Left nav |
| sidebar text | `#c7cdd9` | Default nav label |
| sidebar hover/panel | `#1f2637` | Nav hover, Ask-Samaritan box background |
| sidebar border | `#2a3145` | Ask-Samaritan box border, nav count-bubble background |
| sidebar footer text | `#6b7385` | Status footer line |

### 2.2 Typography

System stack, both mockups, unchanged: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`. Base body size `14px`.

| Role | Size / weight | Letter-spacing | Source |
|---|---|---|---|
| Dashboard greeting (H1) | 22px / 700 | −0.01em | `.h-greet` |
| Inbox detail title, full-fidelity | 21px / 700 | −0.01em | `.d-title` (`action-center-mockup.html`) |
| Inbox detail title, in-shell | 18px / 700 | normal | `.dt` (`samaritan-app.html`) |
| Brand wordmark | 15px / 600 | normal | `.brand b` |
| Card / section heading | 14px / 600 | +0.01em | `.card h2` |
| Item title (list row) | 13.5px / 650 | normal | `.item-title` / `.tt` |
| Stat tile value | 28px / 750 | normal | `.tile .v` |
| Button label | 12.5–13px / 600 | normal | `.btn` |
| Body / card paragraph | 13–13.5px / 400 | normal | `.sec li`, `p` |
| Meta / notes / mode-note | 11.5–12px / 400 | normal | `.note`, `.mode-note`, `.meta` |
| Uppercase section label | 11–11.5px / 600–700 | +0.04–0.05em | `.sec h5`, `.list-head`, `.daygrp`, `.tile .k` |
| Badge / tag | 10.5px / 600 | +0.03em (mockup) | `.badge`, `.src` |

### 2.3 Spacing & layout grid

- App shell: `230px` dark sidebar + `1fr` main content (`samaritan-app.html` `.app`).
- Inbox two-pane: `300px` list + `1fr` detail, both mockups.
- Main content padding: `24px 30px 60px`, scrollable, resets scroll-to-top on every view/item change.
- Card padding: `16px 18px` (cards), `15px 16px` (stat tiles), `20–24px` (detail panel outer padding).
- Grid gaps: `14–16px` between cards/tiles, `10px` between agent cards, `6–9px` between small chips.
- Base spacing unit is an informal 4–6px increment; nothing in the mockups uses a strict 8pt grid, so treat 4/6/8/10/12/14/16/18/20/24/30 as the working scale.

### 2.4 Radius

| Element | Radius |
|---|---|
| Badges, tags | 4–5px |
| Nav items, small buttons, inputs, drafts, quote blocks | 7–9px |
| Meeting/record group cards | 9–10px |
| Standard cards (`action-center-mockup.html`) | 12px |
| Top-level cards, stat tiles (`samaritan-app.html`) | 14px |
| Pills (nav count bubble, lane filter chips, integration pills) | 999px |

### 2.5 Elevation

**None.** Neither mockup uses `box-shadow` anywhere. Hierarchy is built entirely from 1px `--line` borders and background layering (`--bg` → `--surface` → tinted panels like the list pane or draft field). This is deliberate, not an oversight — it's principle 5 (§1): a calm, flat surface that doesn't compete for attention. Do not introduce drop shadows in implementation; use border + background contrast instead.

### 2.6 Status & mode color-coding rules

- **Color is never the only signal.** Every colored dot and badge ships with a text label next to or inside it (`Assisted`, `connected`, `error · auth expired`). Screen readers and colorblind users must never depend on hue alone.
- **Two intentional hex collisions to be aware of when composing a screen:**
  - `--personal` (Personal lane tag) and `--assist` (Assisted mode badge) are the identical amber `#b45309`. A Personal-lane item in Assisted mode will show two amber chips side by side — differentiate by label and position (lane tag is top-left, mode badge is in the meta row), never rely on the color to tell them apart.
  - `--guided` and `--core` are the identical indigo `#4f46e5`. The Guided badge intentionally reads as "brand-colored" — it is the default/baseline mode, requiring no special warning color the way urgent or error states do.
- **Status dot vs. mode badge green are different greens on purpose:** `--ok` (`#059669`) means "this agent/connection is alive"; `--auto` (`#047857`) means "this action executes without a human step." Don't conflate them in code — a capability can be status-`ok` while its actions are Guided, or vice versa mid-outage.

---

## 3. Information architecture & navigation

### 3.1 App shell

```
┌───────────────┬──────────────────────────────────────────────────┐
│  SIDEBAR       │  MAIN CONTENT (one active view)                  │
│  (dark, 230px) │  padding 24px 30px 60px, scrollable               │
│                │                                                    │
│  ● Samaritan   │   Dashboard | Inbox | Deferred | Completed | ...  │
│  ─────────────  │                                                    │
│  Dashboard     │                                                    │
│  Inbox    (4)  │                                                    │
│  Deferred (3)  │                                                    │
│  Completed     │                                                    │
│  Settings      │                                                    │
│                │                                                    │
│  [spacer]      │                                                    │
│  🔎 Ask         │                                                    │
│  Samaritan…    │                                                    │
│  ─────────────  │                                                    │
│  8 agents ·    │                                                    │
│  8 integrations│                                                    │
│  connected ·   │                                                    │
│  local-first   │                                                    │
└───────────────┴──────────────────────────────────────────────────┘
```
(`samaritan-app.html` `.app` = `grid-template-columns: 230px 1fr`)

### 3.2 Sidebar navigation

- **Brand block** — 24×24px indigo swatch + "Samaritan" in white, 15px/600.
- **Nav list**, five items in fixed order: Dashboard, Inbox, Deferred, Completed, Settings.
  - Default: `#c7cdd9` text, transparent background.
  - Hover: background `#1f2637`.
  - Active: background `--core`, text white; the active view's count bubble also inverts to translucent white (`rgba(255,255,255,.25)`).
  - **Live counts** appear only on Inbox (pending items) and Deferred (snoozed items) as a pill badge (`.nav .n`); Dashboard, Completed, and Settings never carry a count.
- **Ask-Samaritan box** (`.recall`) — a persistent entry point to the Ask-Samaritan RAG layer (`PRD.md` §15), styled as a dark inset panel with a two-line teaser ("🔎 Ask Samaritan… / 'why did we pick Vendor A?'"). Clicking focuses an inline query input in the same box; submitting opens a lightweight answer panel (drawer or inline expansion) showing the synthesized answer with citations to row IDs / file paths, without leaving the current view. This same mechanism powers the "Ask: why this decision?" response button inside Inbox items (§7) and the implied "why did we…?" link from Completed rows (§5.4).
- **Status footer** (`<small>`) — one live-updating line: `{n} agents · {n} integrations connected · local-first`. Sourced from the same data as the Settings → Connections grid; not a separate subsystem.

### 3.3 Deep-linking & routing

The mockups switch views with in-page JS (`nav()`, `showItem()`); a real build should back this with addressable routes so Telegram messages, browser history, and the Ask-Samaritan drawer can all target a specific screen:

| Route | Shows |
|---|---|
| `/dashboard` | Dashboard (default on load) |
| `/inbox` | Inbox, first/most-urgent item selected |
| `/inbox/:itemId` | Inbox, that item's detail pre-selected — this is the target of every Dashboard "needs you now" row and every Telegram deep link |
| `/deferred` | Deferred |
| `/completed` | Completed |
| `/settings#connections` | Settings, Connections section |
| `/settings#routing` | Settings, Routing table section |

View switches are instant, client-side, no full reload — consistent with "local web app served by a daemon" (`PRD.md` §13). Switching views or selecting a new inbox item always resets scroll position to the top of the main content / detail pane (mirrors `document.querySelector('.main').scrollTop=0` and `.detail.scrollTop=0` in both mockups).

### 3.4 Reconciling the two mockups

`action-center-mockup.html` is a zoomed-in, higher-fidelity exploration of just the Inbox — it renders as a standalone page with its own top bar (brand, an integrations pill row, a "N need you" count) rather than living inside the left sidebar. This spec treats it as authoritative for **detail-panel fidelity and the Inbox list's lane filtering**, folded into the one real IA defined by `samaritan-app.html`:

| In `action-center-mockup.html` | Lives in the unified IA as |
|---|---|
| Top-bar integrations pill row (Gmail, TickTick, Calendar, Slack, iMessage, Notion, Obsidian, Fireflies) | Summarized in the sidebar footer (`8 integrations connected`); full detail lives in Settings → Connections (§5.5) — not duplicated in Inbox |
| Top-bar "**4** need you" count | Already surfaced twice: the Inbox nav badge and the Dashboard "Needs you" stat tile — not repeated a third time |
| `.lanes` filter chips (All · 4, Work · 2, Coding · 1, Job · 0) | Adopted into the Inbox view's list-pane header, directly above "Waiting for you" (§5.2) |
| Richer detail typography (21px title, generous `.card`-sectioned bodies, `.comment` rows, `.meeting`/`.meeting-h`/`.meeting-b` structure) | **This is the canonical rendering for the Inbox detail pane** — the compact version embedded in `samaritan-app.html`'s `.idetail` (18px title, tighter padding) is the same component at a denser size for the in-shell context, not a different design |

Net effect: one Inbox, sidebar-navigated, with a lane-filterable list and a detail pane that renders at the fidelity shown in `action-center-mockup.html`.

---

## 4. The render-schema system

This is the platform mechanism — the reason adding a 20th capability costs almost nothing at the UI layer. `PRD.md` §6 defines a capability's manifest as declaring, per emitted action-item type, a `render` block (`layout`, `primary`, `secondary`, `badges`) plus a `custom_attributes` schema. This section specifies exactly how the Action Center turns that declaration into pixels — the mapping is a **superset** of the PRD's stub: if a capability declares only `primary`/`secondary`/`badges`, the Action Center infers the component from the JSON type of the value (per the table in 4.4); a capability that wants precise control tags each attribute with an explicit `component` hint.

### 4.1 Why this exists

Without a shared render mechanism, every new capability would need bespoke frontend code — exactly the "core code changes" the pluggability model (`PRD.md` §9) forbids. With it, `capabilities/<id>/manifest.yaml` is the only artifact a capability author writes; the Action Center discovers, validates, and renders it using the fixed vocabulary below. No capability ever ships its own UI.

### 4.2 The four layout primitives

| `layout` value | Structural pattern | Choose it when… | Demonstrated by |
|---|---|---|---|
| `document` | One `.card` containing multiple named `.sec` blocks (uppercase `h5` heading + bulleted list) | The output is a synthesized, read-mostly narrative organized into sections | WBR (`#wbr`) |
| `card` | One or more boxed `.card`/`.quote` blocks; may include an `editable` field rendered as a styled textarea | The output is a compact bundle of context (a summary, a quoted source, draft comments) — with or without something Sandip edits directly | Email (`#email`), PRD review (`#prd`) |
| `form` | One or more repeated groups (`.meeting`/record cards), each with a header and a body of checkbox/input rows, optionally sub-grouped by category | The output is a set of discrete, individually-approvable structured facts — the review *is* a set of editable/checkable fields | Meetings (`#mtg`) |
| `diff` | Per-field "old value → new value" rows inside the standard `.card` shell | The capability proposes changing something that **already exists** (not creating something new) | Not yet demonstrated — see 4.7 |

### 4.3 Anatomy of a rendered detail (shared chrome, every layout)

Every rendered item — regardless of layout — assembles the same five-part chrome, top to bottom. Only the middle "body" varies by layout type.

1. **Source line** (`.d-src` / `.dsrc`) — plain text, muted, built from three OS-contract fields: `capability_id` · `trigger` (mode + condition) · the integration(s) touched. E.g. `email-triage · trigger: event (email.received) · reads/sends: Gmail`.
2. **Title** (`.d-title` / `.dt`) — the item's headline, derived from `context.what_happened` or a capability-declared title field.
3. **Meta badge row** (`.d-meta` / `.dmeta`) — see 4.6.
4. **"Why now" callout** (`.d-why` / `.dwhy`) — renders `context.why_flagged`, always prefixed with a bold lead-in ("Why you're seeing this:" or "Why now:").
5. **Body** — the layout-specific render described in 4.2/4.4.
6. **Action buttons** (`.actions`) — one `.btn` per declared `responses[]` entry, in declared order.
7. **Mode note** (`.mode-note` / `.note`) — one caption line explaining what happens on approval, typically referencing `execution.mode` and `context.execution_surface` / `context.outcome_preview`.

### 4.4 Field → component mapping

| Schema field (type / tag) | Rendered component | CSS anchor | Mockup example |
|---|---|---|---|
| `string`, short | Inline text / paragraph | `.sec p`, `.comment` | PRD "Summary" paragraph |
| `string`, tagged `document` | Split into named `sections[]`, each `{heading, items}` | `.card` > `.sec` (h5 + ul) | WBR body |
| `string[]` | Bulleted list | `.sec ul li` | WBR "Shipped this week" |
| `string`, tagged `editable: true` | Editable `<textarea>`, warm-white background, preceded by an uppercase draft label | `.draft`, `.draftlabel` | Email drafted reply |
| `object {from, date, body}`, tagged `quote` | Quoted-source block with an attribution line | `.quote`, `.from` | Email — original message |
| `object[]`, tagged `record_group` | Repeated card: header bar (name + time) + body | `.meeting`/`.mtg`, `.meeting-h`/`.mh` | Meetings — 3 groups |
| `object[]`, tagged `checklist`, nested inside a `record_group`, sub-grouped by `category` | Real `<input type=checkbox>` rows grouped under an uppercase category label, each with an optional trailing tag (reversibility, or assignee + due) | `.chk`, `.rev`, `.due` | Meetings — decisions / action items |
| `string[]`, tagged `comments` | Sequential rows, dashed divider between | `.comment` | PRD — draft review comments |
| `float 0–1`, tagged `confidence` | Neutral badge, "confidence 0.86" | `.badge` | WBR meta row |
| `execution.mode` (shared) | Colored mode badge — always the first meta badge | `.badge.guided` / `.assist` / `.auto` | All four panels |
| `string`/`date`, tagged `due` or `deadline` | Urgent-colored badge if inside the escalation window, else neutral | `.badge.urgent` | "Due Thu," "Due tomorrow" |
| `context.why_flagged` (shared) | Callout box, bold lead-in | `.d-why`/`.dwhy` | All four panels |
| `responses[]` (shared) | Button row, one `.btn` per entry | `.actions` | All four panels |
| `context.outcome_preview` (shared) | Caption line below actions | `.mode-note`/`.note` | All four panels |
| `capability_id` + `trigger` + `source` (shared) | Detail header's source line | `.d-src`/`.dsrc` | All four panels |
| Any attribute listed in `render.badges` | Neutral grey badge chip appended to the meta row | `.badge` (default) | "3 sources," "14 journal entries," "#product · Arjun" |

### 4.5 Worked examples — how each of the four surfaces is produced

**WBR → `layout: document`**
```yaml
render:
  layout: document
  sections: [shipped, in_progress, blockers, next_week]
  badges: [entry_count, confidence]
custom_attributes:
  shipped: string[]
  in_progress: string[]
  blockers: string[]
  next_week: string[]
responses:
  - { id: approve, label: "Approve & save to Obsidian", outcome: execute }
  - { id: edit, label: "Edit draft", outcome: edit }
  - { id: regenerate, label: "Regenerate", outcome: retry }
  - { id: dismiss, label: "Dismiss", outcome: discard }
execution: { mode: assisted, capability: obsidian.note.write }
```
Renders as: header (source line, "Weekly Business Review — draft," badges `Assisted → Obsidian` / `14 journal entries` / `confidence 0.86`) → why-now callout → one `.card` with four `.sec` blocks, each a heading + bulleted list → 4 action buttons → mode note ("writes to Areas/Weekly/"). See `#wbr` in both mockups.

**Email reply → `layout: card`**
```yaml
render:
  layout: card
  blocks: [original_message, drafted_reply]
  badges: [deadline, sender]
custom_attributes:
  original_message: { from: string, date: string, body: string }   # tagged quote
  drafted_reply: { body: string, editable: true }
responses:
  - { id: approve_send, label: "Approve & send", outcome: execute }
  - { id: save_draft, label: "Save as Gmail draft", outcome: stage }
  - { id: edit, label: "Edit", outcome: edit }
  - { id: snooze, label: "Snooze 1 day", outcome: defer }
  - { id: decline, label: "Decline to answer", outcome: discard }
execution: { mode: assisted, capability: gmail.send }
```
Renders as: header → why-now → `.quote` block (Priya's original message, attributed) → draft label → editable `.draft` textarea → 5 action buttons → mode note ("sending is your call"). See `#email`.

**PRD review → `layout: card`**
```yaml
render:
  layout: card
  blocks: [summary, draft_comments]
  badges: [deadline, mention_source]
custom_attributes:
  summary: string
  draft_comments: string[]   # tagged comments
responses:
  - { id: post, label: "Post review to Slack thread", outcome: execute }
  - { id: edit, label: "Edit comments", outcome: edit }
  - { id: open, label: "Open in Slack", outcome: guided }
  - { id: defer, label: "Defer to tomorrow", outcome: defer }
execution: { mode: guided+assisted, capability: slack.thread.reply }
```
Renders as: header → why-now → two stacked `.card` blocks (Summary paragraph; "Your likely review comments" as sequential `.comment` rows) → 4 action buttons → mode note explaining the guided/assisted split. See `#prd`.

**Meetings → `layout: form`**
```yaml
render:
  layout: form
  repeat: meetings
  groups: [decisions, action_items]
  badges: [decision_count, task_count]
custom_attributes:
  meetings: object[]   # each: { name, time, decisions: checklist[], action_items: checklist[] }
responses:
  - { id: approve_checked, label: "Approve checked & file", outcome: execute }
  - { id: edit_item, label: "Edit an item", outcome: edit }
  - { id: ask_why, label: "Ask: why this decision?", outcome: ask_more_info }
  - { id: reject_all, label: "Reject all", outcome: discard }
execution: { mode: automated, capability: [notion.decision.create, ticktick.task.create] }
```
Renders as: header → why-now → one `.meeting` group per meeting (header bar with name + time; body split into "DECISIONS → Notion" and "ACTION ITEMS → TickTick" checklists, each row a real checkbox with a trailing reversibility or assignee/due tag) → **one** batch action row at the bottom (not per-group — this is the batch-approve pattern from `PRD.md` §8) → mode note ("checked items file; unchecked are dropped"). See `#mtg`.

### 4.6 Badges & responses derivation

- The **first** meta badge is always the execution-mode badge (`Guided` / `Assisted` / `Automated`), optionally suffixed with the execution surface (`Assisted → Obsidian`).
- Subsequent badges render in the order declared in `render.badges`, each defaulting to the neutral grey badge unless the field is tagged `urgent`/`deadline` (→ red) or `confidence` (→ neutral with a "confidence" label prefix).
- `responses[]` renders 1:1 into `.actions`, preserving declared order. Button variant is derived from `outcome`:

| `outcome` value | Button variant | Example |
|---|---|---|
| `execute` (commits something) | `.btn.good` (filled green) if the capability's action is reversible/low-risk, `.btn.primary` (filled indigo) if it's a "post/send"-style forward action that still needs a second, external step | "Approve & save to Obsidian," "Post review to Slack thread" |
| `stage`, `edit`, `guided`, `retry` | `.btn` default (outlined, white) | "Edit draft," "Save as Gmail draft," "Open in Slack" |
| `defer` | `.btn` default | "Snooze 1 day," "Defer to tomorrow" |
| `discard`, `ask_more_info` | `.btn` default | "Dismiss," "Reject all," "Ask: why this decision?" |

### 4.7 Fallback behavior & the `diff` layout

**`diff` (not demonstrated in the reference mockups — specified here since the manifest contract enumerates it as a valid `layout` value).** Use it when a capability proposes to *change* something that already exists rather than create something new — e.g., a `calendar` capability proposing to move a meeting, or `doc-review` proposing an edit to fields on an existing Notion row.
```yaml
render:
  layout: diff
  fields: [start_time, attendees]
```
Renders as: the standard header chrome, then one `.diff-row` per changed field inside the usual `.card` shell — old value muted/struck-through, new value in `--core` indigo, arranged as `{old} → {new}`. Visually consistent with the other three layouts (same card border/radius/padding), so it doesn't read as a bolted-on afterthought.

**Fallback for malformed or unrecognized schema.** A missing/unknown `layout`, or a `custom` field whose runtime value doesn't match its declared type, must never cause the item to be silently dropped — that breaks the "everything that needs Sandip lands in one inbox" guarantee. The shared header (source line, title, why-now) still renders, because those are OS-contract fields the Action Center owns directly. The body falls back to a pretty-printed key/value list of whatever `custom` attributes did arrive, and the action row collapses to a minimal universal set: `Dismiss`, `Ask Samaritan`, `Open raw`. See §9 for the visual treatment of this state.

---

### 4.8 Guided-mode loop closure & the `awaiting_confirmation` state

Guided actions — and assisted actions whose commit happens *outside* Samaritan (you click **Send** in Gmail, reply in Slack/WhatsApp) — finish off-system, so the OS can't observe completion. The UI is what closes that loop; without it these items hang forever. Three rules (they implement TECH-SPEC §5.3's `staged → awaiting_confirmation → executed` mapping):

1. **Every guided / assisted-external item carries a `Mark as done` / `Confirm sent` control, *alongside* the deep link — never instead of it.** The deep link (`Open in Slack`, a `mailto`/copy for a hand-sent reply) takes you out to do the thing; the confirm button is how you tell Samaritan you did it. Styling: the deep link is a default `.btn`; `Mark as done` is **also** a default outlined `.btn`, deliberately *not* `.good`/green — green (`--auto`) means "the OS executed this automatically," and this is a human confirming external work, not an automated execution. The `#prd` panel in `samaritan-app.html` shows the pattern (`Open in Slack` + `Mark as done`).

2. **A distinct `awaiting confirmation` item state, between dispatched and completed.** In the UI:
   - The item **stays in the Inbox** (it still needs you) but renders an amber `Awaiting your confirmation` chip (`.badge.assist` family) in the list row, plus a persistent banner in the detail — visually distinct from a fresh, un-acted item.
   - The primary action set collapses to **`Mark as done`** plus `Didn't do it` (re-opens to `pending`); the substantive approve/edit decision is already past.
   - A `Remind me` affordance (routes a Telegram nudge) is offered for items awaiting confirmation past a threshold, so off-system work isn't silently forgotten.

3. **Completed only *after* confirm.** A guided / assisted-external item appears in **Completed** only once `Mark as done` is clicked (decision tag `Sent` or `Done`, with where/when). Automated items, by contrast, land in Completed the instant execution succeeds. This is precisely why Completed is an honest audit trail — it records what actually happened, not what was merely handed off.

**UI-visible state summary:** `pending` → (approve / edit) → **automated:** `executed` → Completed · **guided / assisted-external:** `awaiting_confirmation` (remains in Inbox with the amber chip) → (`Mark as done`) → `executed` → Completed.

## 5. Per-view specifications

### 5.1 Dashboard

**Layout.** Greeting header → 4-column stat tile row → full-width "Plugged-in agents" card (3-column agent grid) → 2-column grid (1.25fr / 1fr): "Needs you now" (left) and "Handled automatically today" (right). (`samaritan-app.html` `#dash`.)

**Components.** Stat tile (§6.2) ×4 · Agent status card (§6.3) ×N in a 3-col grid · Priority queue row (§6.11) ×N · Feed row (§6.11) ×N.

**Content.**
- Greeting: `Good {time-of-day}, Sandip` + a subhead with the live date/time and a running summary: `"{n} things need you, {n} handled automatically today."`
- Stat tiles: **Needs you** (count + urgent/due-today sub-line; switches to the alert visual variant — red value, tinted background — whenever the urgent sub-count is > 0) · **Auto-handled today** (count + "no action needed") · **Deferred** (count + next resurface time) · **Agents** (`active / total` + a sub-line noting any that need reconnect).
- Agent grid: one card per capability — status dot, name, last-run time, pending count (in `--core` indigo) or auto-handled summary, and the integration it touches. An error-state card (e.g. `whatsapp-triage: auth expired`) uses the alert card variant with an inline "reconnect" link.
- "Needs you now": up to a handful of priority rows (urgent items first — red dot — then normal — indigo dot), each with title, a one-line why, and a right-aligned due/source tag. Clicking a row deep-links to `/inbox/:itemId` (§3.3, §7).
- "Handled automatically today": a reverse-chronological timeline of auto-completed actions, each `{time} · {what it did} · {agent name in green}`. Always paired with the trust note: *"Auto-handled = high-confidence, low-blast-radius, reversible. Everything else is escalated to your inbox."*

**States.**

| State | Behavior |
|---|---|
| Default | As above — populated tiles, agent grid, needs-you-now, feed |
| Empty (nothing needs Sandip) | "Needs you" tile shows `0` and drops the alert variant; "Needs you now" card shows a calm positive state — a checkmark glyph + "Nothing needs you right now." — instead of an empty list |
| Loading | Tiles, agent cards, and list rows render as skeleton blocks (same dimensions/radius, `--line2` fill, no shimmer needed at this data volume) while the daemon responds |
| Error (daemon unreachable) | A dismissible banner at the top of main content: "Can't reach the Samaritan daemon — retry." Tiles/cards show their last-known-good values, dimmed, rather than disappearing |
| Success / confirmation | A transient toast after acting on a deep-linked item ("Approved — filed to Notion"); counts update in place without a full reload |
| Quiet hours | A small muted note appended to the status footer or subhead, e.g. "Quiet hours until 7:00 AM — notifications paused, inbox still updating." Dashboard itself keeps live-updating; only Telegram push is held (§8) |

### 5.2 Inbox

**Layout.** Header (title + subhead) → two-pane `.inbox`/`.shell`: 300px list pane (lane filter chips → "Waiting for you" label → item rows) + 1fr detail pane (schema-driven surface, §4). (`samaritan-app.html` `#inbox` for the shell; `action-center-mockup.html` for detail fidelity, per §3.4.)

**Components.** Lane filter chip row (new — see 3.4) · Item card (§6.1) ×N · Detail header (§6.7) · one of the four layout bodies (§4) · Action buttons (§6.6).

**Content.**
- Subhead: `"{n} items need your decision. Each renders the surface its type needs."`
- Lane chips: `All · {n}`, `Work · {n}`, `Coding · {n}`, `Job · {n}` (extendable to any lane a capability declares); active chip filled indigo.
- List rows: source/lane tag, relative time, title, one-line why-flagged, badge row (mode badge first, then priority/due, then any declared extra badges).
- Detail pane: the full render-schema output for the selected item (§4.3–4.5). The four reference examples — WBR, email reply, PRD review, meeting extraction — are the concrete proof points; every future capability follows the same chrome.

**States.**

| State | Behavior |
|---|---|
| Default | List + detail as above, first/most-urgent item pre-selected |
| Empty ("Inbox zero") | List pane shows a calm empty message ("Nothing needs you. Samaritan will surface things here the moment they do."); detail pane is blank/hidden rather than showing a stale panel |
| Loading | Skeleton list rows (title-bar + two text-line placeholders); detail pane shows a skeleton header + body matching the selected item's expected layout |
| Error — item render failure | Header still renders (OS-contract fields); body falls back to the raw key/value card from §4.7, with a note: "This item's content couldn't be rendered — showing raw data." |
| Error — integration read failure | Inline error strip inside the relevant body block (e.g., "Couldn't load the Slack thread — retry") rather than failing the whole panel |
| Success / confirmation | On responding, the `.actions` row is replaced in place by a single confirmation line (checkmark + outcome + timestamp, e.g. "Approved — filed to Notion · 3:42 PM") for ~1–2 seconds, then the item leaves the list (count decrements) and the detail pane advances to the next item or the empty state |
| Quiet hours | Doesn't block the Inbox — it's always live. Items received overnight may carry a small "delivered quietly" note reflecting that push notification was held even though the item itself was ingested immediately |

### 5.3 Deferred

**Layout.** Header → flat list of `.lrow` rows. (`samaritan-app.html` `#deferred`.)

**Components.** Deferred row (a `.lrow` variant — body + resurface time + two buttons).

**Content.** Subhead: *"Snoozed — these resurface in your inbox at the time shown."* Each row: bold title, muted meta (`"You deferred this · from {source} · {capability}"`), right-aligned resurface time in indigo (`↩ Tomorrow 9:00 AM`, `↩ Monday`), and two actions: **Act now** (jumps to `/inbox/:itemId`) and **Drop** (discards without executing).

**States.**

| State | Behavior |
|---|---|
| Default | Rows sorted by soonest resurface time |
| Empty | "Nothing deferred — snoozed items will show up here." |
| Loading | Skeleton rows |
| Error | Inline banner: "Couldn't load deferred items — retry" |
| Success / confirmation | "Act now" navigates straight to the item's Inbox detail; "Drop" fades the row out with a small toast ("Dropped — removed from queue") |
| Quiet hours | Resurface times are already computed to skip quiet windows (a 2 AM snooze resolves to the next 7 AM); no special row state needed, just correct scheduling |

### 5.4 Completed

**Layout.** Header → day-grouped list (`.daygrp` label, then `.lrow` rows). (`samaritan-app.html` `#completed`.)

**Components.** Day group header (§6.11) · Completed row (a `.lrow` variant carrying a decision tag).

**Content.** Subhead: *"Every decision you made — the audit trail. Ask 'why did we…?' to trace any of these."* Grouped by day (`Today`, `Yesterday`, then calendar dates for older entries). Each row: a decision tag (`Approved` / `Edited` / `Dismissed` / `Sent`, colored per §2.1), bold description of what happened, muted meta line ("1 edited before filing · → Notion + TickTick"), and a right-aligned timestamp.

**States.**

| State | Behavior |
|---|---|
| Default | As above; newest actions animate into the top of "Today" the moment they complete, in real time, without a manual refresh |
| Empty | "No completed items yet — decisions you make in the Inbox will show up here." |
| Loading | Skeleton day-group + rows |
| Error | Inline banner: "Couldn't load history — retry" |
| Confirmation | N/A as a dedicated state (this view *is* the confirmation record); a completed row is itself the receipt |
| Quiet hours | N/A — actions taken during quiet hours still log normally; Completed is never itself throttled |

Every row is clickable and opens an Ask-Samaritan trace ("why did we…?") grounded in the item's provenance chain (`PRD.md` §7, §15) — same mechanism as the sidebar recall box (§3.2).

### 5.5 Settings

**Layout.** Header → "Connections" card (agent-style grid) → "Routing & defaults" card (table). (`samaritan-app.html` `#settings`.)

**Components.** Connection card (§6.10, visually identical to the agent status card) · Routing row (§6.9).

**Content.** Subhead: *"Connect apps once. Then set the default app for each action — and whether it runs guided, assisted, or automated."*
- Connections: one card per integration — status dot, app name, account/identity, and either "connected" or an error state ("auth expired · reconnect," red link).
- Routing table: columns Action (as `<code>`, e.g. `email.send`) · Default app · Account/target · Default mode (colored badge). A footnote states the hard policy lock: *"Money never moves automatically — `payment.make` is locked to Guided by policy, regardless of connected apps."*

**States.**

| State | Behavior |
|---|---|
| Default | All cards connected, full routing table |
| Empty / first-run | No connections yet — every card shows a neutral "not connected" variant (grey dot, no account line) with a **Connect** button in place of status text; see §9 for the full first-run sequence |
| Loading | Skeleton cards + skeleton table rows |
| Error | An individual connection card shows the err dot + reconnect CTA (this is a per-card state, not a whole-view error); a whole-view error (Settings data unreachable) uses the same top-of-content banner pattern as other views |
| Success / confirmation | After a successful reconnect, the dot flips err → ok in place, the meta line updates, and a toast confirms ("Gmail reconnected"); any capability that had auto-degraded to Guided mode for lack of that integration promotes back automatically (§7) |
| Quiet hours | N/A |

---

## 6. Component library

### 6.1 Item card (Inbox list row)
Props: `sourceLane` (work/personal/coding/job → tag color), `title`, `whyText`, `badges[]`, `timestamp`, `active` (bool), `onClick`.
Variants: default · hover (`background: #fafbff`) · active (white background + 3px indigo left bar via `::before`) · *(future)* read/dimmed once handled but still visible during its confirmation window.
Anchor: `.item` in both mockups.

### 6.2 Stat tile
Props: `label`, `value`, `subLabel`, `alert` (bool).
Variants: default (white surface) · alert (red-tinted background `#fef6f6`, border `#f3c9c9`, value rendered in `--urgent`).
Anchor: `.tile` / `.tile.alert`, `samaritan-app.html`.

### 6.3 Agent status card
Props: `name`, `statusDot` (ok/idle/err), `metaLine` (last run + pending/auto-handled count + integration), `errorMessage`, `reconnectHref`.
Variants: ok · idle · err (alert background + reconnect link). Reused verbatim as the **Connection card** in Settings (§6.10) — same component, `name` becomes the app name and `metaLine` becomes the account identity.
Anchor: `.agent` / `.agent.err`.

### 6.4 Badge (mode / priority / neutral)
Props: `label`, `variant`.
Variants: `guided` (indigo) · `assist` (amber) · `auto` (green) · `urgent` (red) · default/neutral (grey, for informational tags like "3 sources," "conf 0.86").
Anchor: `.badge` + modifier classes, both mockups.

### 6.5 Status dot
Props: `state` (ok/idle/err).
An 8px filled circle; ok = `#059669`, idle = `#9aa3b2`, err = `#dc2626` (§2.6 — deliberately distinct from the `auto` mode-badge green). Used standalone in agent cards, connection cards, and the integration pills.
Anchor: `.dot`.

### 6.6 Action buttons
Props: `label`, `variant` (default/primary/good), `onClick`.
Variants: default (white, bordered) · primary (indigo fill — a forward action still requiring an external step, e.g. "Post to Slack thread") · good (green fill — a direct commit, e.g. "Approve & save to Obsidian"). Always rendered as a row (`.actions`) at the foot of a detail panel, immediately followed by the mode note.
Anchor: `.btn` / `.btn.primary` / `.btn.good`.

### 6.7 Detail header (composite)
Props: `sourceLine`, `title`, `badges[]`, `whyText`.
Composed of four sub-elements rendered in fixed order: source line → title → meta badge row → why-now callout (§4.3, steps 1–4). Not independently reusable outside the Inbox detail context, but its four parts each have their own anchor: `.d-src`/`.dsrc`, `.d-title`/`.dt`, `.d-meta`/`.dmeta`, `.d-why`/`.dwhy`.

### 6.8 Checklist row
Props: `checked` (bool, mutable), `label`, `trailingTag` (either a reversibility tag `Reversible`/`Irreversible` or an assignee+due string), `category` (groups rows under an uppercase sub-heading like "DECISIONS → Notion").
Nested inside the **record group** component (a repeated card: header bar with name + time, body containing one or more categorized checklist blocks) — the two are always used together for the `form` layout (§4.2).
Anchor: `.chk`, `.rev`, `.due`; group anchors `.meeting`/`.mtg`, `.meeting-h`/`.mh`, `.meeting-b`/`.mb`.

### 6.9 Routing row
Props: `actionKey` (rendered as `<code>`), `defaultApp`, `accountTarget`, `defaultMode` (badge).
A plain table row; the mode column always renders via the Badge component (§6.4), never plain text, so routing and item badges stay visually consistent.
Anchor: `<tr>` inside the Settings routing `<table>`.

### 6.10 Connection card
See 6.3 — the Connection card *is* the Agent status card component, re-labeled: `name` = app/integration name, `metaLine` = account identity + connection status, `err` variant swaps "reconnect" for the agent-error copy.

### 6.11 Supporting components (not in the required-ten list, but load-bearing)
- **Priority queue row** (Dashboard "Needs you now") — priority dot (urgent/normal) + title + why-subtext + right-aligned due/source tag; click deep-links to `/inbox/:itemId`. Anchor: `.qrow`.
- **Feed row** (Dashboard "Handled automatically today") — timestamp + description + agent name in green. Anchor: `.frow`.
- **Deferred/Completed row** — shared `.lrow` shell; Deferred variant shows resurface time + Act now/Drop; Completed variant shows a decision tag + timestamp.
- **Day group header** — uppercase, muted, letter-spaced label grouping Completed rows by date. Anchor: `.daygrp`.
- **Quote block** — attributed source excerpt (used inside the `card` layout for email). Anchor: `.quote`, `.from`.
- **Draft field** — editable textarea, warm-white background, with an uppercase "Drafted … · editable" label above it. Anchor: `.draft`, `.draftlabel`.
- **Lane filter chip** — pill toggle in the Inbox list-pane header. Anchor: `.lane` / `.lane.active`.

---

## 7. Interaction patterns

1. **Approve.** Click the `good`/`primary` action button → button shows a brief pending state → on success, the actions row is replaced by an inline confirmation (§5.2 states) → item leaves the Inbox (count decrements everywhere it's shown: nav badge, Dashboard tile) → a new row appears at the top of Completed → "Today," tagged `Approved`.

2. **Edit-then-approve.** Click **Edit** (or the field is already editable, as with the email draft) → the relevant field(s) become in-place editable inputs → the primary action button's label adapts if needed (e.g. stays "Approve & send") → on commit, the Completed tag is `Edited` (amber) with a meta note like "reworded before filing."

3. **Reject / Decline / Dismiss.** Click the corresponding default-styled button → item leaves the Inbox immediately, nothing executes → appears in Completed tagged `Dismissed`/`Rejected` (grey).

4. **Defer.** Click a snooze-labeled button (e.g. "Snooze 1 day," "Defer to tomorrow") → item moves from Inbox to Deferred, computed resurface time shown (respecting quiet hours, §5.3) → disappears from the Inbox count, appears in the Deferred count.

5. **Ask-more-info.** Click "Ask: why this decision?" (or any response tagged `ask_more_info`) → routes to Ask-Samaritan using the item's provenance chain → the answer surfaces inline (an expandable panel beneath the why-now callout, or the same drawer the sidebar recall box uses), grounded in row IDs/file paths → item **stays pending**; Sandip then chooses another response.

6. **Batch actions.** For similar low-risk items — most concretely, the per-row checkboxes in the meeting extraction surface — a single bottom action ("Approve checked & file") commits every checked row across every group in one action; unchecked rows are silently dropped rather than filed. This is the mitigation for the "flood of individual approvals" failure mode named in `PRD.md` §8.

7. **Deep-link from Dashboard → Inbox item.** Clicking a "Needs you now" row (or an agent's pending count) switches the active view to Inbox **and** pre-selects that item's detail panel, scrolled to top — mirrors `nav('inbox',...); showItem(id)` in `samaritan-app.html`'s script, formalized as navigating to `/inbox/:itemId` (§3.3).

8. **Snooze/defer flow, from inside a detail panel.** Same trigger as pattern 4, initiated from the Inbox detail rather than a list — the item transitions straight to the Deferred view; no intermediate confirmation dialog is needed since Deferred itself offers "Act now"/"Drop" as an undo path.

9. **Reconnect flow.** Settings → Connections → an err-state card's "reconnect" link → OAuth handoff (system browser or in-app modal, provider-dependent) → on success: the card's dot flips err → ok, its meta line updates to "connected," a confirmation toast fires, and — critically — any action type that had auto-degraded to Guided mode for lack of that integration (`PRD.md` §9, "missing capability → auto-degrade to guided") **promotes back automatically**, and any Dashboard agent card showing that integration's error clears in the same render pass.

---

## 8. Notifications

Samaritan is also reachable via **Telegram** (`PRD.md` §13, §14) — the phone-native surface for urgent escalations and for acting when the local web app isn't open.

**Message anatomy for an escalation:**
```
🔔 Samaritan — needs you
Reply needed — "Q3 capacity numbers"
Priya asked for a decision · unanswered 2 days · due Thu

Draft ready (Assisted → Gmail). Nothing sends until you say so.

[ Approve & send ]  [ Edit ]  [ Snooze 1 day ]
[ Open in app → ]
```

- **Header line** — a bell for a true escalation (urgent priority or a new policy-triggered item); a lighter icon for a routine digest entry.
- **Title + why line** — the same `title` and `why_flagged` text rendered in the Inbox detail header (§4.3), kept short for a phone notification.
- **Mode line** — states the execution mode and surface plainly, so Sandip knows from the lock screen whether tapping a button commits something externally.
- **Inline buttons** — a safe subset (2–4, Telegram's practical inline-keyboard limit) of the item's `responses[]`, prioritizing the primary commit action, an edit/stage action, and defer; destructive/low-value responses (reject-all, ask-more-info) are left for the full app. **"Open in app →"** always appears last, deep-linking to `/inbox/:itemId` over the private tunnel (Tailscale/Cloudflare Tunnel per `PRD.md` §13) for anything that needs the full render surface (e.g., checking off individual meeting rows, editing a multi-paragraph draft).
- **Acting from the phone** — tapping a button posts that response back through the same ingest/response path the web UI uses; the web app updates in real time (the item disappears from Inbox, a Completed row appears) so the two surfaces never disagree about state.
- **Quiet hours** — urgent items bypass `quiet_hours` and still deliver immediately (an urgent, time-sensitive item held silently until morning would defeat the point of escalation); normal-priority items queue and are sent as a single digest message at the end of the quiet window instead of trickling in overnight.

---

## 9. Empty/first-run, error, and confirmation states

These are cross-cutting patterns; §5 gives the per-view copy, this section gives the shared visual rule for each.

**First-run.** Before any capability is plugged in and before any integration is connected: Dashboard stat tiles all read `0`, none in the alert variant; "Plugged-in agents" shows an empty-state card with guidance copy ("No capabilities yet — connect an integration in Settings or drop one into `capabilities/`") instead of a 3-column grid; Settings → Connections renders every card in the neutral "not connected" variant (grey dot, no account line, a **Connect** button replacing the status text) rather than showing errors — a not-yet-connected app is a neutral state, not a failure state. The suggested first-run path is Settings → Connections first, then Dashboard populates as capabilities start running.

**Empty (steady-state, nothing pending).** Always a calm, positive treatment — never a bare blank area. A short line of reassurance ("Nothing needs you right now") plus, where relevant, a small affirming glyph (a checkmark, not an illustration-heavy empty state — keeps with the flat, non-intrusive visual language of §1/§2.5).

**Loading.** Skeleton blocks matching the exact dimensions and radius of the real component (tile, agent card, list row, detail panel), filled with `--line2`. No spinners on primary content; a small inline spinner is reserved for button-level pending states (e.g., mid-approve).

**Error.** Two tiers:
- *View-level* (data for the whole view can't load): a dismissible banner pinned to the top of main content, plain language + a retry action, last-known-good content shown dimmed underneath where available rather than replaced by a blank state.
- *Component-level* (one card, one item, one integration read fails): the error lives inside that component only — an agent/connection card's alert variant, an inline error strip inside a detail body block, or the raw-data fallback card for a render-schema mismatch (§4.7). A component-level error never blanks the rest of the screen.
- *Execution failure post-approval* (`PRD.md` §8 "Confirm/fail" — e.g., the email bounces, the Notion write fails): the item does not vanish into Completed. It flips to a visible `failed` state — red tag, stays reachable — with **Retry** and a guided fallback ("Open Gmail directly") so Sandip is never left wondering whether something silently didn't happen.

**Confirmation.** The default pattern is inline, not a modal: the action row is replaced in place by a single checkmark line stating the outcome and a timestamp, held briefly, then the surrounding item/row transitions to its new location (Inbox → Completed, etc.). For actions with no dedicated detail panel (Deferred's "Drop," a Settings reconnect), a lightweight toast serves the same purpose. Nothing in this system uses a blocking "Are you sure?" modal — the two-step "approve" + "it's now sitting in Completed/Deferred, reversible by re-opening" pattern is the undo mechanism, consistent with treating irreversible actions (sending, paying) as their own explicitly-labeled, always-escalated response rather than needing a generic confirmation dialog.

---

## 10. Responsive & accessibility notes

**Responsive.** Both mockups define a breakpoint (`900px` in `samaritan-app.html`, `820px` in `action-center-mockup.html` — treat `900px` as the single build target):
- 4-column stat tiles and 3-column agent grids collapse to 2 columns.
- The Inbox two-pane layout collapses to a single column: the list pane caps its height (`max-height: 280px`, scrollable) and sits above the detail pane, rather than side-by-side.
- The dark sidebar reflows to a horizontal, wrapping bar rather than a fixed left column (`.side{flex-direction:row;flex-wrap:wrap}`).
- Below that, treat this as a desktop-first local web app (per `PRD.md` §13, it's served by a daemon on `localhost` and reached remotely over a private tunnel) — the responsive behavior exists so the UI is usable on a tablet/phone browser hitting the tunnel URL, not as a primary mobile design target. Telegram (§8) is the primary mobile-native surface; the responsive web layout is the fallback for "I need the full render surface from my phone."

**Accessibility.**
- **Never color-only.** Every status dot and mode/priority badge pairs its color with a text label (already true throughout both mockups — "Assisted," "connected," "error · auth expired" are always present as text, not implied by hue). Preserve this in implementation even under design pressure to "declutter."
- **Real form controls.** Meeting checklist rows must be actual `<input type="checkbox">` elements with an associated `<label>` (as already marked up in both mockups), not styled `<div>`s — required for keyboard operation and correct screen-reader announcement of checked state.
- **Labeled editable fields.** The `.draft` textarea's visual label (`.draftlabel`) must be programmatically associated (`<label for>` or `aria-label`), not purely visual — screen-reader users need to know a field is "Drafted reply · editable" before landing in it.
- **Keyboard navigation.** All interactive elements — sidebar nav items, Inbox list items (already `<button>`s), lane filter chips, action buttons, checklist rows — must be reachable and operable via keyboard with a visible focus state; the mockups define hover states but no focus states, which implementation must add (a 2px `--core` outline or equivalent is consistent with the existing indigo "active" language).
- **Contrast.** `--ink` (`#1a1d24`) on white/`--bg` passes comfortably. `--muted` (`#616b7a`) on white is the one combination worth explicitly verifying against WCAG AA at small sizes (11–12px meta text) before shipping, since it's used extensively for secondary text throughout every view.
- **Live regions.** Inline confirmation states (§9) and toasts should be announced via an `aria-live="polite"` region so a screen-reader user learns "Approved — filed to Notion" without having to re-discover it visually.
- **Non-visual channel.** Telegram (§8) is a fully text-based, independently accessible channel for every escalation — worth keeping in mind as a legitimate accessibility fallback, not just a convenience feature.

---

## Appendix A — Mockup anchor quick-reference

| Spec component | `samaritan-app.html` | `action-center-mockup.html` |
|---|---|---|
| App shell / sidebar | `.app`, `.side`, `.nav` | — (not present; top bar instead, see §3.4) |
| Stat tile | `.tiles`, `.tile`, `.tile.alert` | — |
| Agent / connection card | `.agents`, `.agent`, `.agent.err` | — |
| Priority queue row | `.qrow` | — |
| Auto-handled feed row | `.feed`, `.frow` | — |
| Inbox shell | `.inbox`, `.ilist`, `.idetail` | `.shell`, `.list`, `.detail` |
| Lane filter chips | — | `.lanes`, `.lane` |
| Item card | `.item` | `.item` |
| Detail header | `.dsrc`, `.dt`, `.dmeta`, `.dwhy` | `.d-src`, `.d-title`, `.d-meta`, `.d-why` |
| Document-layout body (WBR) | `#wbr` `.sec` | `#wbr` `.card` `.sec` |
| Card-layout body, quote+draft (Email) | `#email` `.quote`, `.draft` | `#email` `.quote`, `.draft` |
| Card-layout body, comments (PRD) | `#prd` `.sec` | `#prd` `.card`, `.comment` |
| Form-layout body (Meetings) | `#mtg` `.mtg`, `.chk` | `#mtg` `.meeting`, `.chk` |
| Action buttons | `.actions`, `.btn` | `.actions`, `.btn` |
| Deferred / Completed row | `.lrow`, `.did` | — |
| Day group header | `.daygrp` | — |
| Settings connections + routing | `#settings`, `.agents`, `<table>` | — |
