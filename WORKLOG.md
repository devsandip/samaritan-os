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

## 2026-07-21 (morning) — The brief as given, and the map of what is not built

**The brief (verbatim intent, kept because the artifacts should record what was
asked, not only what was done):**

What I wanted to achieve:
1. Agents posting stuff to the Inbox.
2. Agents created for that purpose.
3. A demo of: adding/registering an agent, an agent posting to the Inbox, me
   acting on it.

The job I set:
1. Figure out what those agents need to be.
2. Figure out how to populate the Inbox with items from those agents on day one,
   so there is a full Inbox to demo.
3. Figure out how agents are added, discovered and plugged into Samaritan.

Added mid-build: a tool that turns a Claude scheduled task into an agent that
runs on Samaritan. Drop in the instructions, get an agent that is ready.

Constraints: comprehensive build plan first, split into chunks of roughly 200
lines or less, build each chunk and merge, compact after each merge. End state:
a demo-ready Samaritan.

**Did:**
- Answered all three questions in `docs/features/demo-agents.md`, after finding
  that all three depended on the same missing piece: there was no Run Layer.
- Built it, plus the run CLI and route, the scaffolder, four agents, the seed,
  the Dashboard telemetry, the importer and the runbook. Twelve commits, merged
  and pushed.
- Wrote `docs/DEMO.md` and `test/agents.test.ts`, which is the same runbook in
  executable form.

**State now:**
- 330 tests, typecheck clean. Main is at `6da6b89`.
- `d580d5c` (WORKLOG plus the journal entry for that work) is still unmerged.
  The main working tree has uncommitted work from another session, including an
  edit to `journal/INDEX.md` that collides with mine. Mechanical to resolve, but
  it is someone else's uncommitted work, so it waits.

**Not built, by area (this is the useful list now):**
- *Scheduler and daemon (§12 steps 16, 17).* Nothing fires on a cadence. Six
  agents declare crons; every one is a declaration. No launchd plist, no
  scheduler-sync adapter for tasks still tagged in Claude's scheduler.
- *Event Bus and listeners (step 18).* No Fireflies webhook, Gmail poller, Slack
  Events, or chokidar watch. `newsletter-digest` and `email-triage` are
  event-mode agents with no events.
- *Recall v1 (step 22).* Chunker, embedder and sqlite-vec index store exist. No
  RRF fusion, no indexer job, no query API. Ask Samaritan is a placeholder and
  `ctx.memory.recall` throws an explanatory error rather than answering.
- *Assisted execution adapters (step 20).* No `gmail.draft.create`, no calendar
  tentative-hold. `email-triage` degrades to guided at load, correctly and
  visibly, which means the demo's assisted beat is the assisted state machine
  over a guided adapter.
- *Connections grid in Settings (step 24).* Routing is real and editable; the
  per-integration connection status is a comment saying v0 has none.
- *Policy Engine v1 (step 19).* Predicates plus a confidence threshold, plus the
  hardcoded money lock. No reversibility or value rules, no per-type overrides.
- *Triage (step 23).* The ttl sweep works. Priority and deadline sorting and
  batch-approve for similar low-risk items do not exist.
- *Remaining v1 capabilities (step 21).* calendar-from-screenshot and job-search
  were named in the spec and are not built.

**Known bugs carried, not fixed:**
- The `failed` re-ingest bug (spawned as `task_cf07a5a2`).
- The `approved` race, which needs the startup reconciliation sweep first.
- No "Remind me" affordance (UI-SPEC §4.8 rule 2).
- A held event is invisible to an already-open detail pane.
- `dailyNotePath()` in `src/execution/adapters/obsidian.ts` uses the UTC date, so
  a note written after local midnight lands in the previous day's daily note
  (spawned as `task_e3781b7c`).

**Next:**
- Resolve the `journal/INDEX.md` collision and merge `d580d5c`.
- Then the scheduler (§12 step 17). It is not the most interesting thing left,
  but it is the one whose absence makes a sentence in the demo untrue.

## 2026-07-21 (08:43) — Merged the session notes, and unblocked them without touching someone else's work

**Did:**
- Merged `d580d5c` and `3fe9615` into main and pushed. `main` and `origin/main`
  are both at `3fe9615`.
- Unblocked the fast-forward the narrow way. Backed up all five of the other
  session's files first, then stashed only `journal/INDEX.md`, which was the one
  file in the way. `docs/PRFAQ.md`, `docs/README.md` and both untracked files
  were never touched, since these commits do not go near them.
- Re-applied the other session's INDEX contribution by hand onto the rewritten
  INDEX: their `2026-07-20-1330` bullet, verbatim, slotted between the two
  07-21 entries and `1055`. Their header edit was superseded by mine, which is
  newer.
- Wrote `resume/RESUME_2026-07-21-0815.md` and bumped the pointer, then
  superseded it with the 08:43 file once the merge landed.

**State now:**
- Main at `3fe9615`, pushed. 330 tests, typecheck clean. The merge was
  docs-only.
- The main working tree is back to the exact five-file shape it was found in.
  The other session's work is still uncommitted, and two of those files are
  untracked, so they are one bad `clean` away from gone.
- `stash@{0}` is still there. Its content is now fully represented in the
  working tree, so it is redundant, but it holds someone else's work and was not
  mine to drop.

**Decisions:**
- Stash one file rather than all five. `git checkout --` on their INDEX would
  have been simpler and would have discarded their edit; the stash keeps it
  recoverable, and the backup keeps it recoverable twice.
- Do not commit the other session's files, even the untracked ones that look
  finished. Flagged instead.

**Next:**
- The scheduler (§12 step 17). Six agents declare crons and nothing fires them,
  which is the only remaining gap that makes a sentence in the demo untrue.

## 2026-07-21 — The scheduler: crons that fire, and a restart that catches up

**Did:**
- Built the scheduler (§12 step 17), the gap the last three entries all pointed
  at. Two scheduled agents declared crons that no clock ever read; now the serve
  process fires them on cadence.
- Wrote a self-contained cron matcher (`src/scheduler/cron.ts`) instead of taking
  `node-cron`, because the column that has held `next_fire_at` since migration 1,
  §11's catch-up, and this codebase's injected-clock test bar all want a pure
  `(schedule, date)` function the library does not expose. Logged in DECISIONS.md.
- Built the `Scheduler` (`src/scheduler/index.ts`) around three properties: §8
  ownership (a trigger Claude still fires is skipped), claim-before-fire (advance
  `next_fire_at` before the run, so an overlap or a slow run cannot double-fire),
  and §11 catch-up (a boot that finds `next_fire_at` in the past knows a run was
  missed and applies the manifest's `catch_up` once).
- Added `trigger.catch_up` to the manifest and made `weekly-digest` the worked
  `run_once` example; validated `cron` as a real five-field expression at load.
- Hosted it in the API server's `start()` alongside the sweeps — the daemon
  skeleton §6 describes — and put `next_fire_at` on `GET /api/capabilities`, read
  from the persisted trigger row so it shows whether or not a daemon is up.

**State now:**
- 367 tests (up from 330: 17 cron, 18 scheduler incl. two end-to-end through the
  real Run Layer, 2 API), typecheck clean. Four commits on
  `claude/continue-building-0uer2e`.
- Verified against a live daemon: on boot the scheduler armed `subscription-watch`
  to the next 08:00 and `weekly-digest` to the next Sunday 20:00; event and manual
  capabilities stayed null. The demo sentence is now true.
- Still not built: the launchd plist (so the daemon survives a reboot), the Event
  Bus (step 18) so event-mode agents fire on real events, and Recall's query path
  (step 22).

**Next:**
- The launchd plist and a `daemon` entrypoint, so step 16 is fully done and the
  scheduler survives a reboot rather than living only as long as `pnpm serve`.
- Then the Event Bus (step 18): `email-triage` and `newsletter-digest` are
  event-mode agents with no events, the mirror of the gap just closed.
- Recall's query path (step 22), still the last v0-shaped piece of the UI that is
  a placeholder.

**Decisions:**
- Claim before firing, not after. Advancing `next_fire_at` before the run means a
  crash mid-run loses that one slot; `catch_up: run_once` is the recovery for the
  runs where that matters. The alternative (advance after) risks a double-fire on
  an overlapping tick, and while ingest dedupes by `dedupe_key` so it would be
  mostly harmless, "each slot fires at most once" is the cleaner contract.
- A missed run coalesces to one. `next_fire_at` advances to the next occurrence
  after *now*, not the next after the missed slot, so a daemon down for three days
  fires a daily agent once on return, not three times.
- `next_fire_at` on the API reads the persisted trigger row, not the live
  Scheduler object. The Dashboard then shows what will fire even from a CLI
  `createApp` that never starts a scheduler, and there is no second source of
  truth to drift.
- A disabled scheduled capability is armed forward without firing, so
  re-enabling it does not trigger a catch-up for every slot it slept through.

## 2026-07-21 — Merged the scheduler, then built the other clock: the Event Bus

**Did:**
- Merged PR #1 (the scheduler) to main, then restarted the branch from the merged
  main to keep the follow-up as a fresh change rather than stacking on merged
  history.
- Built the Event Bus (§12 step 18), the counterpart to the scheduler: where the
  scheduler fires on a clock, the bus fires on something happening. `email-triage`
  and `newsletter-digest` had event triggers nothing delivered an event for.
- `src/events/filter.ts`: a small mechanical `trigger.filter` DSL (`_in`,
  `_contains`, `_eq`, ANDed, fail-closed), so `newsletter-digest`'s
  `from_in: ["@newsletters"]` narrows the same `email.received` `email-triage`
  takes unfiltered.
- `src/events/index.ts`: `EventBus.publish()` — dedup by source id via
  `INSERT OR IGNORE` (claim-before-dispatch, migration 6 `seen_events`), then run
  every matching enabled event-mode capability through the Run Layer, isolating
  one subscriber's failure from the rest.
- Wired the bus into `createApp` (a webhook route needs `publish()` at request
  time), added `POST /api/events` and `samaritan emit-event`, so an event reaches
  the agents before any real listener exists.

**State now:**
- 389 tests (up from 367: 8 filter, 10 bus, 4 API route), typecheck clean. Three
  commits on `claude/continue-building-0uer2e`, restarted from the merged main.
- Verified against a live daemon: a newsletter event dispatched to both event
  agents and landed one `newsletter-digest` item; the same id again deduped with
  no second run; ordinary mail routed to `email-triage` alone.
- Both clocks now real. What the bus lacks is real listeners (Gmail poller,
  Fireflies webhook, chokidar watch); events arrive by the route/CLI, not on
  their own.

**Next:**
- A real listener — the chokidar filesystem watch is the most testable in this
  environment (watch the vault / journals → `note.created` / `journal.updated`),
  and needs no API key or network.
- The launchd plist, so the daemon survives a reboot (the rest of step 16).
- Recall's query path (step 22), still the last placeholder in the UI.

**Decisions:**
- The filter is a mechanical three-operator DSL, not the expr-eval predicate
  engine. A filter selects an event by shape; it should read at a glance and
  never throw. Fails closed like the policy predicates: a filter naming a missing
  field does not match.
- Dedup claims before it dispatches, the scheduler's shape again. Marking the id
  seen before the run means two concurrent deliveries cannot both fire; the
  symmetric cost (a crash between claim and dispatch loses that event) is
  acceptable because "at most once" is what the dedup is for, and ingest's
  `dedupe_key` is a second net under it.
- The bus lives on the App, not just the daemon. A webhook route calls straight
  into `publish()`, so the bus has to be reachable wherever the app is, the way
  `actionCenter` is — the listeners are the daemon-only part, and they are not
  built yet.
- Restarted the branch from merged main rather than stacking. A merged PR is
  finished; the Event Bus is a new change and will be its own PR.

---

## 2026-07-21 — The vault watch: the Event Bus's first real listener, with a subscriber to prove it

**Did:**
- Built the chokidar vault watch (TECH-SPEC §12 step 18). Split it the way the
  scheduler was: a pure `fileChangeToEvent` (path + mtime → `SamaritanEvent`, or
  null for a non-markdown / hidden / out-of-root change) tested without a disk,
  and a thin `VaultWatcher` shell around chokidar that starts and stops with the
  API server. `awaitWriteFinish` so a chunked write never fires a partial note,
  `ignoreInitial` so the existing vault is not replayed on boot, hidden trees
  (`.obsidian`, `.git`, `.trash`) skipped, a missing vault root skipped not fatal.
- Shipped `note-capture` with it, so the listener drives something: it answers
  `note.created` filtered to `Inbox/` and turns a captured note into a reviewable
  task candidate (kind `task`, staged through `pm-os.item.file`). Always
  escalates — the OS sees a note appeared, not what it is.
- Verified live against a real daemon, not only in tests. Wrote a note to
  `vault/Inbox/` and a `note-capture-review` item landed `pending` with an honest
  audit trail (`null -> pending`, actor `capability`); the daemon logged
  `note.created dispatched: ["note-capture"]`. Wrote one to `vault/Areas/` and it
  dispatched to `[]` — the filter, live.

**State now:**
- 409 tests (was 389): +9 `file-event`, +4 `vault-watch` (real chokidar over a
  temp dir), +6 `note-capture` (pure + end-to-end through the bus). Typecheck
  clean. Seven capabilities load with zero problems.
- The bus has one real listener. A note written to the vault fires an agent with
  no curl. The networked listeners (Gmail poll, Fireflies/Slack webhooks) still
  do not exist, so mail and meeting events arrive by `emit-event` or HTTP.
- chokidar added as a dependency — it was already in §3's key-libraries list, so
  not a deviation.

**Next:**
- The launchd plist, so the daemon survives a reboot (the rest of step 16), and
  the §11 boot reconciliation sweep, which also clears the `approved` race.
- Recall's query path (step 22), still the last placeholder in the UI.
- The networked listeners, which need credentials and a network this environment
  does not have — writable but unverifiable here.

**Decisions:**
- One mapping rule, driven by a root's `kind`: `<kind>.created` on add,
  `<kind>.updated` on change. The vault is `note`, yielding the `note.created`
  the spec names; a journal root would be `journal` and yield `journal.updated`.
- One root now (the vault), not `~/Developer/*/journal`. chokidar 5 dropped glob
  support, so that root means enumerating `*/journal` dirs — a macOS concern with
  no test surface here. `WatchRoot[]` is ready for it; it waits.
- A publisher with no subscriber is the same dead text as a subscription with no
  publisher, so the watch shipped with `note-capture` rather than alone.
- `seen_events` grows one row per vault write and is not pruned. Fine at
  single-user scale; a pruning sweep is a noted future item.

---

## 2026-07-21 — Boot reconciliation, and the launchd plist that makes it matter

Merged the Event Bus + vault-watch PR (#2), restarted the branch from the fresh
main, then built the two pieces that finish the daemon: recovery from a crash,
and the supervision that turns a crash into a restart worth recovering from.

**Did:**
- Closed the `approved` race. `execute()` writes `approved`, awaits the adapter,
  then writes the outcome; a process that died in that await left the item
  stranded in `approved` — not in the Inbox, not settled, nothing to move it.
  `ActionCenter.reconcile()` now re-drives every `approved` item through
  `execute()` on boot. Safe by construction: the dispatch key is derived, so a
  settled attempt replays its recorded result (no second Notion row, no second
  draft) and one that never settled runs once more.
- `Registry.reconcileStalePending()` first fails the orphaned `pending` execution
  rows the same crash left behind, so the re-drive opens a clean attempt rather
  than stacking on one that claims to still be running.
- Ran it before `listen()`, deliberately — the opposite of the ttl/resurface
  sweeps. It treats every `approved` item and `pending` row as a crash remnant,
  which is only true while nothing else dispatches; before the socket opens, with
  scheduler and watcher still stopped, it is true by construction.
- Built the launchd plist (rest of step 16). `pnpm install-daemon` writes an
  agent with `RunAtLoad` + `KeepAlive`, so the daemon starts at login and
  restarts if it exits — the restart reconcile() cleans up after. Same
  pure-core/thin-shell split as the scheduler and the watch: `renderPlist()` is
  pure text tested without disk; the CLI resolves this machine's real paths and
  writes `~/Library/LaunchAgents/`. `--print` previews anywhere; non-macOS
  refuses rather than writing a plist that cannot load.
- Verified live. Stranded an item in `approved` in a throwaway store, started the
  real daemon, and it was `awaiting_confirmation` before `/healthz` answered —
  true trail (`approved -> awaiting_confirmation`, actor `system`), reconcile log
  lines present. The server answers only after reconcile finishes, which is the
  entire point of running it before listen.

**State now:**
- 420 tests (was 409): +5 `reconcile` (the three crash cases, the no-op on
  non-approved items, the re-drive count), +6 `plist` (structure, argv order, env
  order, XML escaping). Typecheck clean.
- Step 16 is done: one process hosts the scheduler, the bus, the sweeps and now
  boot reconciliation, and a launchd plist supervises it. §11's `approved` race
  is closed.

**Next:**
- Recall's query path (step 22) — the last placeholder still in the UI.
- Policy Engine v1 (step 19).
- The networked listeners (Gmail poll, Fireflies/Slack webhooks), which need
  credentials and a network this environment does not have.

**Decisions:**
- reconcile() runs before listen(), the opposite of the sweeps, so every
  `approved`/`pending` row it sees is a genuine crash remnant, not live work a
  request is in the middle of.
- No 5-min staleness threshold at boot: nothing is dispatching, so every
  `pending` row is orphaned; a threshold would only miss a fresh orphan after a
  fast restart.
- The plist points at `dist/cli/serve.js` — this repo's built daemon entry, what
  `pnpm start` runs — not the spec's illustrative `dist/daemon.js`.

---

## 2026-07-21 — Recall query v1: Ask-Samaritan answers, and the vector index that never loaded

**Did:**
- Built the retrieval → synthesis → API → UI path on top of the chunker, embedder
  and index stores that already existed (step 22). Seven green chunks, each tests
  and typecheck before commit.
- RRF fusion (`fuse.ts`), pure: a vector kNN and a BM25 keyword search over the
  same chunks fuse on rank, not score, so a passage both retrievers agree on wins
  and neither has to know the other's scale.
- The retrieval path (`retrieve.ts`): embed the question, dual-search, fuse,
  hydrate into cited passages. Degrades on every axis — no vectors leaves keyword
  search carrying it, an all-stopword question leaves the vector search, empty
  index returns nothing.
- Synthesis (`synthesize.ts`) with one guardrail: `none` (default, extractive,
  nothing leaves the machine) and `anthropic` (opt-in prose), both through
  `validateCitations`, which strips any citation whose ref was not retrieved.
- The indexer (`indexer.ts`) + `pnpm index`: walks the vault, journals and audit
  trail, idempotent by content hash, deletion by absence. The daemon reindexes on
  boot and every 15 min, reusing the query embedder so the model loads once.
- The API (`POST /api/recall/query`, `GET /api/recall/stats`) and the UI: the
  sidebar placeholder is a real search now, navigating to an addressable `/ask`
  page that renders the answer with its cited sources.
- Verified live over a real socket against a demo vault. The queries came back
  cited to the right notes — and the run surfaced a bug 465 green tests hid.

**State now:**
- 465 tests (was 420): +48 across fuse, retrieve, synthesize, service, indexer,
  audit and the API route. Typecheck clean, `pnpm build:ui` clean.
- Recall is queryable end to end. Step 22 is done. The last placeholder in the UI
  is gone.
- The embedding model download (HuggingFace) is blocked by this environment's
  proxy, so the real local embedder is the one piece not exercised here; the whole
  path was verified live with the deterministic hash embedder swapped in, which
  proves everything except the model bytes themselves.

**Next:**
- Policy Engine v1 (step 19).
- The networked listeners (Gmail poll, Fireflies/Slack webhooks), which need
  credentials and a network this environment does not have.
- Recall's structured SQL path and near-real-time chokidar indexing, both §7
  steps left for later.

**Decisions:**
- `retrieval_path` is always `"semantic"`: the structured SQL path is not built,
  and labelling an answer `hybrid` would name a path that never ran.
- Synthesis defaults to `none` — a privacy default (§9), not a quality one; the
  extractive answer is the cited passages themselves.
- sqlite-vec was loaded with a bare `require()`, which only exists under vitest.
  In the real ESM daemon it threw "require is not defined" and fell back to the JS
  scan every time — the native index never loaded in production. Fixed with
  `createRequire(import.meta.url)`. Found by a live query, not a test: the scan
  returns correct results, so nothing failed; the index was just dead.
