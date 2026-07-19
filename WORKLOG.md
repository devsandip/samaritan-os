# Worklog

Append-only session archive. Newest at the bottom.

---

## 2026-07-19 — Built Samaritan v0 end to end, from design docs to a public repo

**Did:**
- Worked TECH-SPEC §12's fifteen-step v0 build order in order: contracts as zod
  schemas, Action Store with a migration runner, store CRUD, Policy Engine,
  capability registry, routing, execution registry with adapters, ingest API.
- Wired the anchor. `wrap` and `meeting` now emit to the Action Center instead
  of writing to Notion and TickTick directly, and both declare
  `escalate_when: "true"` so every extracted item is reviewed.
- Vendored the 8-skill plugin into the repo first, unmodified, so the rewiring
  reads as a diff against what actually runs. It existed only in session-scoped
  directories under Application Support that can be garbage-collected.
- Delegated the Inbox SPA to a subagent (Vite + React, renderers dispatched off
  `render.layout`) and built Telegram delivery with quiet-hours queueing myself
  in parallel.
- Published to github.com/devsandip/samaritan-os after scrubbing private
  workspace identifiers out of all nine commits, not just HEAD.

**State now:**
- v0 complete. 119 tests. Ten commits, pushed. Full loop verified against the
  real Notion workspace: emit, escalate, approve, write, archive.
- Notion live: token authenticates, four databases connected, ids correct,
  property names verified against real rows including the Project relation.
- Telegram written, tested, parked. Disabled by default.
- Recall not started. `src/recall/` is empty, so Ask-Samaritan renders as a
  placeholder in the UI.
- Four server-side gaps open, listed under Next.

**Next:**
- Fix the deferred dead end. `deferred -> approved/rejected` are illegal in
  `src/store/action-items.ts` and nothing sweeps deferred back to pending, so
  "act now" on a deferred item 409s on every response. Most visible gap.
- Fix orphaned items. If a capability is unloaded after ingest, `respond`
  returns `response_unknown` for every response id. UI-SPEC §4.7 promises a
  `Dismiss` fallback but no universal response id exists that the server accepts.
- Let `GET /api/actions` take multiple statuses. `listActionItems` already
  accepts an array; the endpoint takes one, so every multi-status view fans out
  client-side.
- Then Recall (§7), which unblocks Ask-Samaritan in the UI.

**Decisions:**
- `node:sqlite` instead of `better-sqlite3`. No prebuilt binary for Node 26 and
  pnpm will not run its build script. Isolated behind `src/store/db.ts` so
  reverting is one file. Bumped `engines.node` to >=24.
- `/usr/bin/security` instead of `keytar` for secrets. keytar is archived and
  needs a native build; macOS already ships the tool.
- One action-item type per anchor capability with `kind` as a discriminator,
  dispatched by `pm-os.item.file`. The adapter translates per kind rather than
  forwarding, because Notion wants `rationale` and Obsidian wants `path` and
  `content` and no single shape serves both.
- Every declared `custom_attribute` is required and undeclared keys are
  rejected. Policy predicates can only read variables that are actually on the
  item, and loud rejection caught two real shape mismatches today.
- Policy predicates fail closed. Anything unevaluable escalates rather than
  auto-completing.
- Rewrote git history before publishing rather than scrubbing only HEAD. The
  vendored plugin commit still had the real ids in its tree, so a HEAD-only
  scrub would have looked thorough and been cosmetic.
