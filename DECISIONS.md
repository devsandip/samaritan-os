# Decisions

Architectural calls made while building, and why. Newest first.
Deviations from `docs/TECH-SPEC.md` are recorded here rather than by editing the
spec, so the spec stays the design record and this stays the build record.

---

## 2026-07-21 — The vault watch: one root now, a subscriber shipped with it

**Context:** §2.2 and §12 step 18 name a `chokidar` filesystem watch on the vault
and `~/Developer/*/journal`, normalising changes into `note.created` /
`journal.updated` events. chokidar is already in §3's key-libraries list, so using
it is not a deviation. Three under-specified points the build had to settle are.

**The mapping is one rule, not two.** `fileChangeToEvent` (the pure core, split
out the way the Scheduler's cron matcher was) reads a watched root's `kind` and
emits `<kind>.created` on an add and `<kind>.updated` on a change. The vault is
`kind: note`, so it yields the `note.created` the spec names; a journal root
would be `kind: journal` and yield `journal.updated`. One rule produces both spec
examples plus their natural siblings, and keeps the decision in a function tested
without a disk — the source id is `file:<abs path>@<mtime>`, the "file path +
mtime" §2.2 names as the dedup key, so a doubled event or a later reconcile
re-reading a file fires once.

**One root now: the vault, not `~/Developer/*/journal`.** chokidar 5 dropped glob
support, so `*/journal/**/*.md` can no longer be a watch pattern — it would mean
enumerating every `~/Developer/<repo>/journal` directory and watching each, a
macOS-specific concern with no test surface in this environment. `WatchRoot[]` is
built to take that second root the day it is wired; the vault watch alone is a
complete, testable slice, so it ships and the journal root waits.

**A publisher with no subscriber is the same dead text as a subscription with no
publisher.** The scheduler and bus entries both turned on making a declaration
real; a listener that emits `note.created` into a bus nothing listens to would be
the same gap inverted. So the watch shipped with `note-capture`, a capability
that answers `note.created` filtered to `Inbox/` and turns a captured note into a
reviewable task candidate. Verified live: a file written to `vault/Inbox/`
becomes a pending item; one written to `vault/Areas/` does not.

**Known cost:** `seen_events` gains a row per vault write and is never pruned. At
single-user scale that is a few thousand rows a year — fine — but §2.2 calls the
seen-set "short-lived", so a pruning sweep (drop ids older than the longest
redelivery window) is a future item, noted here so it is not forgotten.

---

## 2026-07-21 — Event Bus: a mechanical filter DSL, and dedup that claims before it dispatches

**Context:** §4.1 gives `trigger.filter` as a free-form `Record<string, unknown>`
and §2.2 requires source-level dedup, but neither pins down the filter's
semantics or the dedup's ordering. Both are choices, recorded here.

**The filter is three operators, not a predicate language.** `newsletter-digest`
declares `filter: { from_in: ["@newsletters"] }`. Rather than reach for the
expr-eval predicate engine the Policy Engine uses, `src/events/filter.ts` reads
the key as `<field>_<op>` and supports exactly `_in`, `_contains`, and `_eq`
(the default), ANDed together. A filter selects an event by shape; it is not a
place for arithmetic or boolean logic, and keeping it mechanical means a manifest
author can read a filter at a glance and it can never throw. It **fails closed**,
the same rule as the Policy predicates (a filter naming a field the payload lacks
does not match), so a capability is never fired on an event it could not have
evaluated.

The value `@newsletters` is a label, not a literal from-address; resolving it to
real senders is the Gmail connector's job (not yet built). The matcher is honest
about this — it compares `payload.from` to the literal — so a demo event carries
`from: "@newsletters"` and a real one will carry whatever the connector tags.

**Dedup claims before it dispatches.** `publish()` records the event id with
`INSERT OR IGNORE` and only dispatches if the insert won (`changes === 1`). This
is the Scheduler's claim-before-fire again: the id is marked seen before the run
starts, so two concurrent deliveries of the same source id (an overlapping
webhook and poll) cannot both get through. The symmetric cost is the same too —
a crash between the claim and the dispatch loses that one event — and acceptable
for the same reason: firing the capability (and its eventual model call) twice is
the outcome the dedup exists to prevent, so "at most once" beats "at least once"
here. Ingest's `dedupe_key` is a second net under it, collapsing a double-dispatch
to one item even if one ever slips through.

**Not a deviation, an addition:** `trigger.catch_up` (scheduler) and this filter
DSL are both under-specified points the spec left to the build, filled in the
direction the rest of the system already leans — fail-closed, claim-first,
mechanical over clever.

---

## 2026-07-21 — Scheduler: a self-contained cron matcher, not `node-cron`

**Spec says:** §2.2, §3 and §12 step 17 name `node-cron` for the in-process
scheduler.

**What we did:** Wrote a five-field cron parser and next-fire calculator in
`src/scheduler/cron.ts` (Vixie semantics, local time, day-of-month/day-of-week
OR), and drive the scheduler off a persisted `next_fire_at` rather than a
library timer.

**Why:** three things the library cannot give, all of which the spec's own
design already asks for.

1. **`next_fire_at`.** The `triggers` table has had this column since migration
   1 and nothing filled it. node-cron schedules an opaque callback and never
   exposes when it will next run, so §8's staleness check ("a row that hasn't
   pushed within its expected interval is greyed") and the Dashboard's "next
   run in 3h" would have nothing to read. Computing it ourselves fills the
   column that was always meant to hold it.
2. **Catch-up across a restart (§11).** node-cron's timer dies with the process,
   so a digest missed while the Mac slept is simply gone. A persisted next-fire
   time turns "were we down when this was due?" into a comparison, which is the
   entire mechanism behind `catch_up: run_once`.
3. **Deterministic tests.** Every time-based component here injects its clock and
   asserts exact behaviour. A matcher that is a pure function of `(schedule,
   date)` fits that; an internal wall-clock timer does not. The matcher and the
   scheduler have 35 cases between them, none of which sleep.

**Cost / how to revert:** the matcher is one leaf module with no project imports,
and the scheduler consumes it through three functions (`parseCron`, `matches`,
`nextFireAfter`). Swapping in node-cron for the firing while keeping the matcher
for `next_fire_at` is possible, but there is no reason to: the tick loop is a
dozen lines and shares the sweep's proven interval pattern.

**Knock-on:** `trigger.catch_up` (`skip` | `run_once`) added to the manifest,
and the `cron` field now validates as a real five-field expression at load, so a
malformed cron fails at registration rather than silently never firing.

---

## 2026-07-19 — One action-item type per anchor capability, dispatched by `kind`

**Spec says:** §12 step 10 names the types `wrap-item-review` and
`meeting-item-review`, singular. But a wrap produces decisions, insights, tasks
and people, and each belongs in a different system.

**What we did:** Kept one type per capability, with `kind` as a declared custom
attribute, and made its execution target a dispatching adapter
(`pm-os.item.file`) that routes on `kind` to the real adapter.

The adapter **translates** rather than forwards. That was not the first design:
passing the item payload straight through failed the moment a live run hit it,
because Notion wants `rationale`, TickTick wants `due`, and Obsidian wants a
`path` and `content` the item does not carry. `payloadFor()` in
`src/execution/adapters/pm-os.ts` owns that mapping, so a capability declares one
uniform reviewable shape and never carries per-destination fields.

**Cost:** One indirection between manifest and adapter. Worth it: the alternative
was four near-identical action-item types per capability, and a review UI that
had to special-case each.

---

## 2026-07-19 — Every declared `custom_attribute` is required

**Why:** §5.6 evaluates policy predicates over the declared attributes, and a
predicate cannot read a variable that is not on the item. Optional attributes
would evaluate as `undefined` inside expr-eval, which is where quiet wrong
answers come from.

Undeclared keys are **rejected**, not stripped. A capability that drifts from its
manifest fails loudly into the `rejected[]` array of the ingest response. This
caught a real bug during the first live run rather than silently dropping data.

Consequence for the anchor skills: they send `""` for fields that do not apply to
a given kind. Both SKILL.md files say so explicitly.

---

## 2026-07-19 — Secrets via `/usr/bin/security`, not keytar

**Spec says:** §3 names `keytar`.

**What we did:** `src/secrets.ts` shells out to macOS's built-in `security`
command, checking environment variables first.

**Why:** keytar is archived and needs a native build, which is the same problem
that took out better-sqlite3 on Node 26. `security` ships with the OS. Same
Keychain, same service/account layout §6 specifies, zero dependencies.

---

## 2026-07-19 — TickTick is guided-only in v0

**Why:** TickTick has no official Node SDK and its Open API is OAuth-only with no
long-lived token to put in the Keychain. Rather than block the anchor on building
that flow, `ticktick.task.create` declares `guided` only: it stages the task as
copy-ready text and reports `staged`, so the item sits in
`awaiting_confirmation` until Sandip says he made it.

This is §1's rule working as intended ("every action type must have a working
guided path before it is promoted"). The manifest still declares `automated`;
§10 degrades it at load and will restore it automatically once an
automated-capable adapter registers under the same id. No manifest edit needed.

---

## 2026-07-19 — Two small manifest/routing additions the spec implies but does not define

**`execution.action_type`** on an emit spec (optional). §11(b) resolves routing
for `email.send` on an item whose execution capability is `gmail.draft.create`,
so a mapping from item type to abstract action type has to exist somewhere. It is
optional: when absent, the declared capability and mode are used directly, which
is what both anchor capabilities do.

**`execution_capability`** on a routing entry (optional, keyed by mode). §2.2 puts
the action-type-to-registry-id translation in the routing resolver, and one
abstract action maps to different adapters depending on autonomy level
(`gmail.draft.create` assisted vs `gmail.message.send` automated). Without this
the translation had no data to work from.

---

## 2026-07-19 — Policy predicates: allowlist the expr-eval sandbox, don't denylist

**Why:** TECH-SPEC §5.6 requires a sandboxed evaluator and forbids
`eval`/`new Function`. Using `expr-eval` gets you most of the way, but clearing
`parser.functions` is not enough. expr-eval spreads built-ins across three
tables, and `sqrt`, `abs`, `sin` and friends are registered as *unary operators*
rather than functions, so `sqrt(4) == 2` still parsed and evaluated after
`functions` was emptied. A test caught it.

`src/policy/predicate.ts` now rebuilds `unaryOps` from an explicit allowlist
(`-`, `+`, `not`), empties `functions`, and reduces `consts` to `true`/`false`.
Assignment and function definition are off at the parser-options level.

Two other load-time guards worth keeping: a predicate must resolve to a boolean,
and every variable it references must be declared on the item. The second turns
§5.6's "a predicate can only reference variables actually persisted on the item"
into a manifest-load failure instead of a silent `undefined` at ingest.

Related: `custom_attributes` may not shadow a context variable name. Otherwise a
capability could declare its own `confidence` and make it ambiguous which value
`confidence_threshold` compares against.

---

## 2026-07-19 — Policy predicates fail closed

**Why:** If a predicate throws (bad syntax, missing variable, non-boolean
result), `evaluate()` returns `escalate`, not `auto_complete`. Escalating a
low-risk item costs Sandip ten seconds. Auto-completing something the engine
failed to reason about costs trust, which is the whole currency of the earn-
autonomy loop in the backlog.

---

## 2026-07-19 — SQLite driver: `node:sqlite` instead of `better-sqlite3`

**Spec says:** TECH-SPEC §3 names `better-sqlite3`.

**What we did:** Used Node's built-in `node:sqlite` (`DatabaseSync`).

**Why:** `better-sqlite3` publishes no prebuilt binary for Node 26 (ABI
node-v147), which is what's installed on this machine, so it would have to
compile from source on every install. `node:sqlite` is built into the runtime,
is synchronous with the same ergonomics, ships SQLite 3.53.3 with FTS5, and
exposes `loadExtension` so the sqlite-vec path in §7 stays open. Every property
§3's rationale actually asked for (single file, zero ops, ACID, synchronous, no
connection-pool ceremony) holds.

**Cost / how to revert:** The driver is behind one wrapper, `src/store/db.ts`.
Nothing else in the codebase imports a SQLite driver. Swapping back is a change
to that file alone.

**Knock-on:** `engines.node` moved from `>=20` to `>=24`. The launchd plist in
§6 points at `/usr/local/bin/node`, so that binary has to be 24 or newer before
the daemon ships in v1.

---

## 2026-07-19 — Transactions use IMMEDIATE, nesting uses SAVEPOINT

**Why:** Two processes will write the same database file (the API server, and
the CLI that Claude scheduled tasks shell out to per §12 step 14). `BEGIN
IMMEDIATE` takes the write lock at the start rather than on first write, so
contention fails fast at BEGIN instead of deadlocking partway through. WAL plus
a 5s `busy_timeout` absorbs the normal overlap.

Nested `transaction()` calls use SAVEPOINTs so an inner rollback undoes only the
inner scope. This matters for §5.1's settled-item upsert, which has to rewrite a
dedupe key and insert a replacement row in one atomic unit.
