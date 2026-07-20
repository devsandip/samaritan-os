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

---

## 2026-07-20 — Fixed the deferred re-ingest duplicate, and picked the semantics for it

**Did:**
- Started in a worktree whose branch sat at main, while the defer/resurface code
  the task described lived on `claude/what-next-89afb8`. Confirmed the gap before
  writing anything and fast-forwarded onto that branch, which was a clean
  four-commit FF since this branch had no commits of its own.
- Reproduced the duplicate first. Wrote eleven tests against the intended
  behaviour and confirmed seven failed, including two pending rows in the Inbox
  after a single `resurface()`.
- Moved `deferred` from `SETTLED_STATUSES` to `UNSETTLED_STATUSES` and made
  ingest branch 2 hold the status and the window instead of rolling back to
  pending. Suppressed Delivery while a superseded row stays snoozed.
- Corrected `TECH-SPEC.md` 5.1, which listed `deferred` as settled and so
  described the bug as the design.
- Wrote the auto-complete escape hatch test with a real modified `wrap` manifest
  rather than a hand-rolled fixture, so it fails if the manifest schema drifts.

**State now:**
- One commit on `claude/heuristic-shirley-e076a9` (46e78a4), which strictly
  contains all four commits of `claude/what-next-89afb8`. 183 tests, typecheck
  clean.
- Nothing merged to main. Main is still at the v0 tip (3bd7df2).
- `claude/what-next-89afb8` is untouched at 53a5dd7, clean, still checked out in
  its own worktree. Its four commits are unmerged anywhere except inside my
  branch.
- Three of yesterday's four Next items are done, all on the what-next branch:
  deferred dead end, orphaned-capability dismiss, multi-status filtering.

**Next:**
- Decide what happens to `claude/what-next-89afb8`. It is a strict ancestor of
  this branch, so merging this branch to main carries all five commits and makes
  what-next fully merged and deletable. The only thing that breaks that is the
  other worktree committing new work on it, at which point they diverge.
- Check the live store for rows orphaned by the old behaviour:
  `SELECT id, dedupe_key, defer_until FROM action_items WHERE status = 'deferred'
  AND dedupe_key LIKE '%:superseded:%';`
- Week 29 weekly journal summary is due; week 30 started today.
- Then Recall, section 7, still the last unbuilt v0 piece.

**Decisions:**
- `deferred` is unsettled, and supersedes in place without losing the snooze. A
  re-ingest reports what the content is now; a defer says when I want to look at
  it. The two are orthogonal, so the content refreshes and the window holds. The
  alternative framings both lose something real: rolling back to pending lets any
  capability that re-emits each run cancel a snooze silently, and treating it as
  settled orphans the row and wakes it twice.
- Policy auto-complete may break through a snooze. That is the way out for
  something that has become urgent, and it is what makes holding the window safe
  rather than stubborn. Logged as an open question in the journal, because the
  opposite rule is defensible.
- Corrected the spec instead of logging a deviation in `DECISIONS.md`. That file
  is for build-time choices that depart from a spec that stays right. Section 5.1
  was wrong: following it as written produces the duplicate.
