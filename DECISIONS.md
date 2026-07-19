# Decisions

Architectural calls made while building, and why. Newest first.
Deviations from `docs/TECH-SPEC.md` are recorded here rather than by editing the
spec, so the spec stays the design record and this stays the build record.

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
