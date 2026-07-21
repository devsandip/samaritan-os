# Decisions

Architectural calls made while building, and why. Newest first.
Deviations from `docs/TECH-SPEC.md` are recorded here rather than by editing the
spec, so the spec stays the design record and this stays the build record.

---

## 2026-07-21 — The Fireflies webhook: the bus's first inbound listener

**Context:** §12 step 18's remaining listeners were the inbound webhooks. Where
the Gmail poller reaches *out* on a timer, a webhook is reached *into* — Fireflies
posts to a URL when a meeting transcript is ready — which makes it the more
fully verifiable of the two: the whole path is a request I can sign and curl,
with no outbound call to a service I can't reach from here.

**Raw body, in an encapsulated plugin.** A webhook signature is an HMAC over the
*exact bytes* the sender posted; re-serialising the parsed JSON reorders keys and
drops whitespace and breaks the check. So the route needs the raw body, which
means a `parseAs: "string"` content-type parser — and that parser must not become
the whole server's, or every other route's `request.body` changes shape. Fastify's
content-type parsers are per-plugin, so the fix is to register the webhooks in
their own `server.register(...)`: the raw-body parser is scoped to them, and the
rest of the API keeps the default JSON parser untouched. A test asserts exactly
that — an ordinary route still parses normally with the webhook plugin loaded.

**Signature required when a secret is set, unverified allowed without one.** §9's
trust model is "loopback, no auth in v0, but a check before any tunnel." A webhook
is inbound by definition and only reaches the daemon through a tunnel — the exact
case §9 names. So when a signing secret is configured the signature is required
and a mismatch is a 401; without one the route still works for local testing but
logs that it is unverified. Fail-closed on the signature itself: a missing or
wrong-length header is rejected, constant-time, never throwing.

**The event is the notice, not the transcript.** A Fireflies webhook carries a
`meetingId`, not the transcript — fetching that is a separate authenticated call.
So the listener publishes `meeting.transcribed` as an *announcement*, and a
consumer that pulls the transcript and runs the extraction is deliberately the
follow-up. This is the same honest split the Gmail PR made with its refresh-token
flow: build the half that is verifiable now, name the half that isn't. Today
nothing subscribes to `meeting.transcribed` — `meeting` is manual — so the event
is inert on arrival, which is fine and documented: the webhook's job is to get a
real, authenticated meeting event onto the bus, and it does.

**A non-transcript event is a 202, not an error.** Fireflies fires other event
types too, and it retries on a non-2xx. So an event we deliberately ignore
(anything but "transcription completed") returns 202 `{ignored:true}` rather than
a 4xx, so Fireflies does not hammer the endpoint re-sending something we chose not
to act on.

---

## 2026-07-21 — The Gmail listener: the bus's first networked front end

**Context:** §12 step 18 named three networked listeners still missing — a Gmail
poller, a Fireflies webhook, a Slack route — so mail and meeting events reached
the Event Bus only by a hand `emit-event`. The Gmail poller is the one with a
live subscriber already waiting: `email-triage` (no filter) and
`newsletter-digest` (`from_in`) both take `email.received`, so a real inbox
completes a path that already existed from the capability end.

**The same pure-core / thin-shell split as the vault watch.** `gmailMessageToEvent`
is pure — a normalised Gmail message becomes the exact `email.received` payload
the two capabilities read — and `GmailPoller` drives the loop against an injected
`GmailSource`. So the decisions (how a `From` splits, what the event id is, which
query to send, how a raw MIME tree collapses to a body) are tested without a
network, and the messy half (OAuth, REST, base64) is swappable for a fake. Only
the socket to `googleapis.com` is genuinely untestable, and the request-building
and response-parsing around it are covered against an injected `fetch`.

**The checkpoint is an optimisation, not the correctness mechanism.** A poll can
re-see a message (Gmail's `after:` is second-granular, and a boundary message
reappears). What keeps it from being filed twice is the Event Bus dedup on the
stable `gmail:<id>`, exactly as for the vault watch — so the high-water checkpoint
only exists to avoid *refetching* what we've handled. Losing it costs a refetch,
which the dedup absorbs, never a double-file. That let me ship the poll engine
with an in-memory checkpoint first and add the store-backed one (migration 7,
`poll_state`) without a correctness gap.

**A failed publish holds the mark back.** The high-water only advances over
messages that published *and* are older than any that failed, so a message the bus
rejected is refetched next poll rather than stranded behind a mark that jumped past
it. This is the one place the checkpoint has to be careful, and it is careful in
the pure loop where a test can pin it.

**v0 carries a bearer token; the refresh flow is deferred.** The Gmail secret is
an access token (`gmail:<account>`), and a 401 surfaces as "reauthorise" rather
than being swallowed — the same shape as TickTick's OAuth gap in v0. A full
refresh-token dance is real work with no way to verify it here, so it waits.

**What the sandbox could and could not verify.** With the listener enabled and a
token present, a live daemon started the poller, the source made a *real* request
to `googleapis.com`, the bad token came back 401 and surfaced as "reauthorise",
and the failed poll was isolated — the daemon stayed healthy. The one path a
sandbox cannot reach is a valid-token 200, so the successful-fetch branch is
covered by the injected-`fetch` unit test and left for a real inbox to confirm.

---

## 2026-07-21 — Action Center triage v1: batch-approve gated on what a batch commits

**Context:** §12 step 23 — "triage in the Action Center: priority/deadline
sorting, batch-approve for similar low-risk items, ttl-based auto-expiry." Two of
the three already existed: ttl auto-expiry (the `expiresAt()` → `expire()` sweep,
wired into the API's interval) and priority sorting. The new work is batch-approve
and making the sort deadline-aware.

**The gate is on the response's *commitment*, not on the item.** A batch applies
one response to many items. The risk is that convenience lets a high-stakes item
ride through unseen — but only if the response *does* something irreversible. So
the gate keys off the response outcome: a committing response (`execute` /
`guided`) is allowed only on items the risk check clears, while a non-committing
one (`discard`, `defer`) is never gated, because rejecting a hundred newsletters
in one click commits nothing to the world and cannot be got wrong. This is the
same principle as the money-lock — guard the *effect*, not the paperwork — applied
one level out.

**The gate reuses §9's risk axis, not §9's predicates.** `assessBatchRisk` mirrors
`evaluate()`'s money → irreversible → value rules (money absolute, the other two
honouring the same per-type overrides), but deliberately omits the predicate rules
(`escalate_when`, `confidence`, `auto_complete_when`). Every batched item is
already `pending` — it was escalated on purpose — so the question is not "should
this have been escalated" but "is this item's stake low enough to wave through
alongside its neighbours". A separate pure function makes that a different question
with its own tests, rather than an overload of the engine.

**A batch is confined to one type.** "Similar items" is the same `(capability,
type)`: they share responses, a render surface and an execution shape, so one
response id is meaningful across all of them and the UI can find the type's
"approve". Mixing types would mean guessing which response each item meant. The
constraint lives in the UI (the picker locks to the first-selected type); the
service itself is per-item and would honour a heterogeneous set, but nothing asks
it to.

**Applied means the identical single-approve path.** `batchRespond` calls the same
`respond()` each item would go through alone — same transition, same execution,
same audit rows — so a batch is a shortcut for the *input*, never a different code
path for the *effect*. Verified live: the applied items showed
`pending → approved (sandip) → executed/failed` in their audit trail exactly as a
one-at-a-time approve, and a skipped high-value item showed only its original
ingest event, untouched.

**Deadline sorting is real now but forward-looking.** The list order gained a
deadline key (soonest first, no-deadline last) as a secondary sort under priority.
No capability populates `deadline` yet — like `priority` and `ttl` it is a
capability-supplied field — so the change is inert today and correct the day one
does, which is the right time to get the ordering right rather than after a
deadline silently sorts wrong. It is backward-compatible: with every deadline
null, the NULL-guard leaves today's priority-then-newest order unchanged.

---

## 2026-07-21 — Policy Engine v1: reversibility and value as overridable risk rules

**Context:** §12 step 19 — "full confidence/reversibility/value rules, per-type
overrides, hardcoded money-lock (§9)". The v0 engine had confidence and the money-
lock; this adds the other two dimensions §5.6 names, and settles how absolute they
are.

**Reversibility and value are context, not custom attributes.** They could have
lived in each capability's `custom` block and been read by convention, but that
would make them capability-defined strings the OS reads by magic name. Putting
them on `ActionItemContext` makes them OS-defined concepts: they join
`CONTEXT_VARIABLE_NAMES`, so a capability cannot declare a custom attribute that
shadows them, and they flow into the predicate scope like every other context
field. The cost is a contract change, but it is backward-compatible (both
optional) and it is the same call the project keeps making — a shared concept
belongs in the shared shape.

**Absent is silence, not a safety claim.** A missing `reversibility` is treated as
reversible and a missing `value` as zero, so the two new rules fire only on a
stated signal. This is what keeps the change backward-compatible in behavior as
well as in schema: every existing item, which has neither, evaluates exactly as it
did in v0. A rule that escalated on the *absence* of a signal would turn every
silent capability into a flood of review items overnight.

**The money-lock is absolute; reversibility and value are overridable.** This is
the load-bearing distinction. §9 makes money non-negotiable — no manifest can
touch it. Reversibility and value are strong defaults with an escape hatch: a type
sets `allow_irreversible: true` or its own `value_threshold` to take
responsibility for an action it knows is safe. The reasoning: money is a bright
line the OS can draw for everyone, but "how much is too much" and "is this
undo-able enough" are judgments that vary by capability, so the OS sets the
default and lets the capability author, who knows the specific action, bend it —
while never letting silence bend it.

**Precedence: money → reversibility → escalate_when → confidence → value →
auto_complete → default.** Both new rules sit *before* `auto_complete_when`, so a
permissive `auto_complete_when: "true"` can't wave through an irreversible or
high-value item — exactly the property the money-lock has, one level softer. The
value rule sits after confidence so the reported `matched_rule` reads in
increasing specificity, but since every escalate rule short-circuits, order among
them changes only which reason is surfaced, never the outcome.

**Global thresholds in config, passed into a pure engine.** `evaluate()` stays a
pure function: the `policy` config block (`value_threshold`, `escalate_irreversible`)
is threaded in through `EvaluateOptions.policyConfig`, defaulted to mirror the
config when absent so a unit test needs no config. The Action Center reads the
block and hands it to the engine at ingest. Verified live that a value-50 item
escalates and a value-10 item auto-completes purely by the configured threshold.

**Grounded in subscription-watch, not left as dead infrastructure.** Each renewal
now records `reversibility: "hard"` and `value: <amount>` — honest data (a charge
is hard to reverse and worth its amount). The money-lock is still the operative
rule (trigger_reason stays `action_type`), so behavior is unchanged, but the
stakes are first-class now and would escalate the item on their own if it were not
already money-locked.

---

## 2026-07-21 — Recall query v1: the semantic path only, extractive by default

**Context:** §12 step 22 is Recall v1 — "sqlite-vec + chunker + hybrid retrieval
pipeline (§7)". The chunker, embedder and index stores already existed; this
entry is the retrieval → synthesis → API → UI path built on top, and where it
departs from §7's full sketch.

**`retrieval_path` is always `"semantic"`; the structured SQL path is not built.**
§7 classifies a question and may run a structured path (parameterised queries over
`notion_decisions`, `ticktick_tasks`, …) and/or the semantic RAG path, labelling
the answer `structured` / `semantic` / `hybrid`. The mirror tables exist but no
poller fills them, and NL-to-templates is its own step, so only the semantic path
runs. Labelling an answer `hybrid` would name a path that never executed, so the
service returns `semantic` unconditionally. When the structured path lands, the
label starts telling the truth again — it is not faked in the meantime.

**Synthesis defaults to `none` (extractive), and that is a privacy default, not a
quality one.** §7 step 4 synthesises an answer with an LLM. Doing so sends the
retrieved slices of the vault, journals and audit trail to a third party, which
§9 says is a conscious choice. So `recall.synthesis` defaults to `none`: retrieval
and citation still happen, and the "answer" is the passages themselves, laid out
and cited — nothing leaves the machine. `anthropic` is opt-in and, with no key,
degrades back to `none` rather than erroring. Both paths pass through one
`validateCitations` guardrail that strips any citation whose ref was not actually
retrieved — the check that keeps a synthesised answer from inventing a source.

**RRF fuses on rank, not score.** The semantic path runs a vector kNN and a BM25
keyword search over the same chunks, and their scores share no scale (a cosine
similarity vs an FTS5 rank). Reciprocal Rank Fusion throws the scores away and
fuses on rank position, so a passage both retrievers agree on outranks a lone
strong hit, and neither retriever needs to know the other's units. `k = 60`, the
value from the RRF paper.

**The index is filled by a job, and kept fresh by the daemon.** There is no
push-on-write indexing yet; `samaritan index` (`pnpm index`) walks the vault,
journals and audit trail, and the daemon runs the same reindex once on boot and
every 15 minutes after `listen()`. It is idempotent by content hash, so a re-run
only touches what changed, and deletion is by absence — a source the walk no
longer turns up is pruned. §7's near-real-time chokidar indexing is a later step;
a 15-minute reconcile is the pragmatic stand-in and matches the poller cadence §7
already uses for the networked sources.

**Citation `kind` uses the `SourceKind` taxonomy, not §5.5's enum.** §5.5 sketches
`kind` as `notion_row | obsidian_file | ticktick_task | audit_event |
calendar_event`. The index was built around `obsidian | journal | action_item |
audit` (`index-store.ts`), which is the taxonomy actually indexed, so citations
carry those values. The `ref` still follows §5.5 — a file path (+ `#heading`) or
the source's own id.

**sqlite-vec must load through `createRequire`, or it silently never loads.** This
one is a bug the live daemon caught and the tests hid. `index-store.ts` loaded the
extension with a bare `require("sqlite-vec")`, but the project is `"type":
"module"` — there is no ambient `require` in ESM. vitest happens to provide one, so
the extension loaded in tests and `vector_index` read `true`; the real daemon (and
`pnpm index`) threw "require is not defined", caught it, and fell back to the JS
scan every time. The scan returns correct results, so nothing failed — the native
index the extension exists for was just dead. `createRequire(import.meta.url)` is
the ESM-correct load and works under tsx, `node dist/` and vitest alike. This is
the "tests catch logic errors; only the real system catches integration errors"
hypothesis paying out again — the assertion was about a column, the defect was in
what production actually ran.

---

## 2026-07-21 — Boot reconciliation runs before the socket opens, and fails every pending row

**Context:** §11 (and §12 step 16's daemon) calls for a reconciliation pass on
boot: (1) any `approved` item with no matching `executions` row is resubmitted
under its idempotency key; (2) any `executions` row stuck `pending` past a 5-min
staleness threshold is treated as failed-and-retried; (3) missed scheduled
triggers are logged and skipped, with a `catch_up` opt-in. Part (3) is the
Scheduler's own catch-up, already built. Parts (1) and (2) are this entry, and
two of the spec's details are settled differently than written.

**Reconcile runs *before* `listen()`, not after — the opposite of the sweeps.**
The ttl/resurface sweeps run after the server is listening, deliberately, so it
answers requests before any catch-up starts. Boot reconciliation cannot: it
re-drives `approved` items through `execute()` and treats every `pending`
execution row as a dead attempt, and both are only sound while nothing else
dispatches. Once the socket is open a `respond()` can be mid-`execute()`, with a
live `approved` item and a genuinely in-flight `pending` row, and reconcile would
mistake that live work for a crash remnant. Running it before the socket opens —
scheduler and watcher still stopped — makes "every such row is a remnant" true by
construction, the same claim-a-quiescent-moment logic the scheduler uses. The
cost is a little startup latency bounded by the number of interrupted items,
which at single-user scale is ~0.

**No 5-min staleness threshold: at boot, every `pending` row is orphaned.** The
spec's threshold makes sense only if the pass can run while executions are
legitimately in flight — then a young `pending` row might be alive. Run strictly
at boot, before the socket opens, nothing is dispatching, so a threshold could
only *miss* a fresh orphan after a fast launchd restart (the crash was 3 seconds
ago, not 5 minutes). So `reconcileStalePending()` fails every `pending` row
outright. The threshold is the thing to reach for if this ever also runs
periodically on a live daemon; it does not today.

**Residual double-execution window, unchanged from the spec.** Re-driving is safe
because a settled attempt (`succeeded`/`staged`) replays under the same derived
dispatch key. The one gap is a crash *after* a provider committed but *before*
the registry recorded it: the row is still `pending`, so the re-drive runs the
adapter again. This is inherent to at-least-once and is what the spec means by
"failed-and-retried"; the adapter's own check-or-create (§7) is the backstop. Not
a deviation, noted so it is not mistaken for one.

**The plist points at `dist/cli/serve.js`, not the spec's `dist/daemon.js`.** §6's
plist illustrates the entry as `dist/daemon.js`. This repo's built daemon entry
is `dist/cli/serve.js` — `serve.ts`'s `start()` is already the whole daemon
(scheduler + Event Bus + vault watch + sweeps + API in one process, §6's
monolith), and `pnpm start` runs exactly that. `install-daemon` also points node
at `process.execPath` (the node in hand) rather than hardcoding
`/usr/local/bin/node`, so the agent runs the same runtime that generated it.

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
