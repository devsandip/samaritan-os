# Decisions

Architectural calls made while building, and why. Newest first.
Deviations from `docs/TECH-SPEC.md` are recorded here rather than by editing the
spec, so the spec stays the design record and this stays the build record.

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
