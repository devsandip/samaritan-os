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

## 2026-07-20 — Merged to main, restarted the daemon, and the defer feature ran for the first time

**Did:**
- Rebased `claude/what-next-89afb8` onto main. Nothing to replay: all four of its
  commits were already in main via the `heuristic-shirley` merge, which was built
  on top of this branch rather than beside it. Pure fast-forward, no conflicts.
- Verified the merge independently before touching anything, rather than trusting
  the handoff: confirmed each of the four commits is an ancestor of main, that the
  branch had nothing unique, and that the tree was clean.
- Restarted the daemon. It had been up 13.5 hours, not in watch mode, running
  pre-merge code. The restart applied migration 3, so `defer_until` and
  `idx_action_items_defer_until` now exist in the live store.
- Ran the full suite against the merged state here: 183 passing, typecheck clean.
- Wrote the week 30 journal entry and a postscript on the W29 summary.

**State now:**
- Main at `eb40f95`, pushed. `claude/what-next-89afb8` is identical to it.
  `claude/heuristic-shirley-e076a9` and its worktree are gone.
- Daemon live on 127.0.0.1:4173 from the main worktree, pids 16032/16057/16063,
  stdout appending to `~/Library/Logs/samaritan/serve-stdout.log`. Health green,
  2 capabilities, 0 problems.
- Live store on migration 3. `action_items` still empty, so nothing has exercised
  the sweep with real rows yet.
- Recall is still the last unbuilt v0 piece.

**Next:**
- Recall, section 7. Unblocks Ask-Samaritan, which is a placeholder in the UI.
- Consider making the merged-versus-running gap visible: either a restart step
  next to the merge, or have `/healthz` report schema version and build commit.
  Nothing surfaced that the daemon was 13 hours behind main.
- Cross-read `awaiting_confirmation` and the reopen path for the same failure
  mode that produced the deferred bug, per the other session's note: TECH-SPEC
  and UI-SPEC disagreeing about one status.

**Decisions:**
- Appended a postscript to the W29 weekly summary instead of editing its body.
  Two of its claims went stale within a day, but they were true when written and
  the summaries are meant to be frozen. A dated addendum corrects the record
  without rewriting what I believed at the time.
- Corrected yesterday's claim that the tilde bug was live via `logging.dir`.
  Nothing reads that key, so it could never have fired. The bug needed a config
  that omits the `paths` section, and the real one does not. Blast radius on this
  machine was zero. The fix and its regression test still stand, since a trimmed
  config is a reasonable thing for a future install to have.

## 2026-07-20 (afternoon) — Found the deferred bug's sibling, then found two bugs in my own fix for it

**Did:**
- Cross-read `awaiting_confirmation` against TECH-SPEC, UI-SPEC and the code.
  §5.1 called it "nothing external has been committed yet" while §2.2 and §5.3
  say the OS has already dispatched. The code implemented §5.1.
- Added §5.1 branch 2a: a dispatched row is held untouched on re-ingest and the
  re-emission is recorded as an event whose from and to are the same status.
- Scoped the §10 idempotency key to `<item id>:<dispatch generation>`, where the
  generation counts prior `awaiting_confirmation -> pending` events.
- Persisted `guided_link`/`guided_instructions` on the executions table
  (migration 4) so the registry's replay returns them.
- Fixed three smaller things the review found: `samaritan emit` printed a held
  item under "auto-completed by policy", the held `payload_diff` used a shape the
  trail's renderer cannot read, and the audit copy promised something false.
- 201 tests, up from 197. `test/confirm.test.ts` is new, 18 cases.

**State now:**
- Branch `claude/what-next-89afb8` at 5 commits ahead of main, clean.
- Live store still on migration 3. Migration 4 has not been applied, so the
  executions table has neither new column yet.
- Daemon still running `eb40f95`, which predates all of this.
- Recall still not started.

**Next:**
- Recall, section 7. Still the last unbuilt v0 piece.
- The `failed` re-ingest bug, logged not fixed. It is on main today and needs no
  unusual conditions: a superseded `failed` row stays visible and approvable, and
  approving it files the stale content. Reproduced.
- The `approved` race, logged not fixed. Needs the §878 startup reconciliation
  sweep first, because the obvious fix removes the only rescue for a wedged row.

**Decisions:**
- Held the dispatched row rather than moving `awaiting_confirmation` to
  `SETTLED_STATUSES`. Moving it would have forked a fresh row, minting a new
  idempotency key, missing the registry's replay guard, and dispatching a second
  time for real. That was the duplicate I had claimed the change would prevent.
  My original recommendation would have caused the bug I described.
- Kept the generation counter tied to `reopen` alone. A retry after a failure is
  the same approval and must keep replaying; a reopen is me saying the handoff is
  void, which is the only thing that should re-arm a dispatch.
- Did not take the review's advice to hold `approved` the same way. It removes
  the only rescue for a row wedged by a crash mid-dispatch, and the sweep that
  would replace that rescue does not exist. Bounded and pre-existing, so it waits.
- Commit `f9cb4be` must not ship without `9c50ce6`. Alone it makes the stale
  dispatch worse: the replay returns a link and instructions for the wrong task
  where previously the action bar was merely empty.

## 2026-07-21 — Agents that can actually run: Run Layer, six agents, seed, importer

**Did:**
- Built the Run Layer (`src/run-layer/`), the `run-capability` CLI that
  `package.json` had pointed at a nonexistent file since the scaffold, and
  `POST /api/capabilities/:id/run`. Entrypoints import as TypeScript with no
  build step, since Node 26 strips types natively.
- Added four agents chosen to span the platform: `newsletter-digest` (policy
  decides between two outcomes), `email-triage` (the assisted loop plus §10
  degradation), `weekly-digest` (auto-completes, never seen), and
  `subscription-watch` (exists to be refused by the money lock). Gave `wrap` and
  `meeting` the entrypoints they had always declared.
- `samaritan new-capability` scaffolder, and `samaritan seed`, which fills the
  Inbox by running every agent against a fixture through the real ingest path.
- `samaritan import-task` plus a Claude skill: paste a scheduled task's
  instructions, get an LLM-backed agent whose output lands in the Inbox.
- Dashboard on real run telemetry with a "Run now" button, Settings rescan
  without a restart, and `docs/DEMO.md`.

**State now:**
- 330 tests, typecheck clean, everything merged to main and pushed.
- Seeded store: 9 pending, 1 awaiting confirmation, 2 executed, 1 deferred,
  1 rejected. Every audit trail genuine.
- Still not built and named as such in the runbook: no daemon (crons are
  declarations), no Event Bus, Recall indexed but not queryable.

**Next:**
- Walk `docs/DEMO.md` end to end once on the machine you will present from.
- The scheduler (§12 step 17) is the next real gap: six agents declare triggers
  and nothing fires them.

**Decisions:**
- The four new agents are deterministic, with the model call marked as a seam
  and not made. A demo agent that needs a network round-trip and an API key has
  a failure mode on stage testing does not remove. `wrap`, `meeting` and
  imported tasks are the LLM half.
- The seed drives the real API and only ever defers, dismisses, or approves
  guided items. It is not entitled to file to Notion on Sandip's behalf, which
  is the point of the thing being demoed.
- `seed --clear` resolves rather than deletes: the audit trail is append-only
  behind a trigger, so erasing it is impossible and would be wrong anyway.
- Ingest now resolves routing for the item's stored mode. The Inbox was showing
  a money-locked renewal as "Automated — on approve, this is filed directly",
  promising exactly what §9 exists to refuse.

**Found while building:**
- `647af8f` committed `pnpm-workspace.yaml` with unresolved placeholders, so
  `pnpm install` failed and both test and typecheck were broken on the branch.
  That commit was not green as reported.
- `vitest.config.ts` pointed `SAMARITAN_CONFIG` at a path without writing a
  config there, so `loadConfig` fell back to the real vault path. The first
  file-writing test would have written into the actual Obsidian vault.
- Re-seeding forked new items and re-executed auto-completing agents, appending
  the weekly digest to the vault twice. Correct branch 3 behaviour for a real
  capability, wrong for a seed replaying a fixture.
- The registry reported every directory without a manifest as a capability that
  failed to load, raising a red banner for a `node_modules` or a scratch folder.
- The card renderer drew its container from the unfiltered field count and then
  dropped blanks inside it, leaving an empty box on most wrap notes.
