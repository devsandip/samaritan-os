# Samaritan

Sandip's local-first personal agentic OS. The centerpiece is the **Action
Center**: one inbox for everything that needs Sandip, and a pluggable platform
that any agent can join by dropping a folder into `capabilities/`.

Design docs live in [`docs/`](docs/README.md). Start with `docs/PRFAQ.md` for the
why, `docs/TECH-SPEC.md` for how it is built. Build decisions and deviations from
the spec are in [`DECISIONS.md`](DECISIONS.md).

## Status: v0

The v0 anchor is working. `wrap` and `meeting` no longer write to Notion or
TickTick directly. They extract as before, emit to the Action Center, and
nothing is filed until Sandip approves it.

| TECH-SPEC §12 step | State |
|---|---|
| 1-9 Contracts, store, registry, policy, routing, execution, ingest | Done |
| 10 The anchor: wrap and meeting behind the review gate | Done |
| 12 Telegram delivery with quiet-hours queueing | Done |
| 11 Inbox web UI | Done |
| 13-15 Audit endpoint, emit CLI, end-to-end smoke | Done |
| 17 Scheduler: scheduled-mode agents fire on their cron, in-process, with catch-up | Done |
| 18 Event Bus: event-mode agents fire on a published event, deduped by source id | Done (bus + chokidar vault-watch listener; Gmail/Fireflies/Slack pending) |
| 16 Daemon: one process hosts the scheduler, bus and sweeps; boot reconciliation (§11); launchd plist | Done |
| 22 Recall query: hybrid retrieval (vector + BM25 → RRF), cited, with an indexer and the Ask box | Done |
| 19 Policy Engine v1: confidence + reversibility + value rules, per-type overrides, money-lock (§9) | Done |
| 23 Triage: priority/deadline sorting, batch-approve for similar low-risk items, ttl auto-expiry | Done |

v0 is functionally complete. The serve process is the daemon: it hosts the
scheduler, so scheduled-mode agents (`weekly-digest`, `subscription-watch`) fire
on their declared cron with catch-up across a restart; and the Event Bus, so
event-mode agents (`email-triage`, `newsletter-digest`) fire on an
`email.received` event published to `POST /api/events`, deduped by source id and
narrowed by each manifest's `trigger.filter`. The bus has its first real
listener: a chokidar watch on the vault publishes `note.created` when a note
lands, and `note-capture` answers one — drop a file into `Inbox/` and a review
item appears, no curl.

The daemon recovers from its own restarts. On boot, before it accepts a request,
it re-drives any item a crash left mid-execution — an `approved` item is the one
frame the OS is dispatching, so a process death there would otherwise strand it
invisibly — and the re-drive is safe because the idempotency key that guards a
retry guards a restart. `pnpm install-daemon` writes a launchd agent
(`RunAtLoad` + `KeepAlive`) so the process starts at login and comes back after a
reboot, which is the restart the reconciliation cleans up after.

Ask-Samaritan answers now. The sidebar box is a real search: a question is
embedded locally, retrieved against the vault, journals and audit trail by a
vector kNN and a BM25 keyword search fused with Reciprocal Rank Fusion, and
answered with every claim cited back to the note it came from. Retrieval never
leaves the machine; whether the answer is prose over the passages or the passages
themselves is the `recall.synthesis` setting, which defaults to off. `pnpm index`
fills the index, and the daemon keeps it current on a 15-minute reconcile.

The Policy Engine now weighs all three risk dimensions, not just confidence. An
action marked irreversible, or one whose stated `value` crosses a threshold,
escalates to review before any `auto_complete_when` can wave it through — the same
shape as the money-lock, one level softer, because these two are overridable
per-type (`allow_irreversible`, `value_threshold`) where money never is. The
global thresholds live in `config.yaml`'s `policy` block, so the line between
"file it silently" and "ask me first" is Sandip's to set.

The Inbox can clear a run of similar items in one decision. A "Select" mode
locks to a single type — items that share a review surface and a response set —
and approves the whole selection at once. The convenience is gated on what the
response commits: an approve (which files or dispatches) only lands on items the
risk check clears, so anything money-locked, irreversible, or above the value
threshold is held back for its own look, while a bulk discard is never gated
because it commits nothing. Each approved item takes the identical path a
one-at-a-time approve would, audit trail and all; the batch is a shortcut for the
input, not a different route for the effect. The list itself is triaged urgent
first, then by soonest deadline, and anything past its `ttl` is swept to expired.

The listeners still missing are the networked ones — a Gmail poller, a Fireflies
webhook, a Slack Events route — so those events still arrive by `samaritan
emit-event` or the HTTP route.

## Quick start

Requires Node 24 or newer (the store uses the built-in `node:sqlite`; see
DECISIONS.md) and pnpm.

```bash
pnpm install
pnpm migrate      # creates ~/.samaritan/samaritan.db and ~/.samaritan/config.yaml
pnpm build:ui     # builds the Inbox SPA into ui/dist
pnpm index        # fills the Recall index (first run downloads the embed model)
pnpm serve        # http://127.0.0.1:4173, serves the API and the SPA
```

`pnpm index` walks the vault, journals and audit trail into the Recall index so
Ask-Samaritan has something to answer from; it is idempotent, and the daemon
re-runs it on a schedule, so it is a one-time bootstrap rather than a chore.

`pnpm -C ui dev` runs the UI on `localhost:5173` with `/api` proxied, if you
want hot reload while working on the frontend.

Emit some items and review them:

```bash
cat <<'JSON' | pnpm -s emit
{ "capability_id": "wrap", "items": [ { "type": "wrap-item-review", ... } ] }
JSON

curl -s '127.0.0.1:4173/api/actions?status=pending'
curl -s -X POST 127.0.0.1:4173/api/actions/<id>/respond \
  -H 'content-type: application/json' -d '{"response_id":"approve"}'
curl -s 127.0.0.1:4173/api/actions/<id>/audit
```

## How the review gate works

```
capability          Policy Engine        Action Center       Execution Registry
  emit()      ->    evaluate()     ->    Inbox         ->    adapter
                         |                  |
                         |                  +-- Sandip approves / edits / rejects
                         |
                         +-- auto_complete skips the Inbox (never for money, §9)
```

Both anchor capabilities declare `escalate_when: "true"`, so every extracted
item is reviewed. An approval is attributable: the audit trail records who moved
the item, when, and what they changed.

Three properties are enforced structurally rather than by convention:

- **A status change with no audit row is not representable.** `transition()` in
  `src/store/action-items.ts` writes both in one transaction, and SQLite triggers
  abort any `UPDATE` or `DELETE` on `action_item_events`.
- **Money never moves automatically.** Checked in three independent places that
  must all agree: the Policy Engine (before any manifest rule, and not
  overridable), the routing lock, and the Execution Registry, which throws at
  load time if an adapter claims `automated` for a money-namespaced id.
- **Irreversible and high-value actions escalate by default.** A softer echo of
  the money-lock: the Policy Engine sends anything marked `irreversible`, or above
  the `value` threshold, to review before it can auto-complete. Unlike money these
  are overridable per-type, so a capability can take responsibility for one it
  knows is safe — but silence is never taken as safe.
- **A batch cannot commit what a single approve would not.** Batch-approve applies
  one response to many items, but a committing response (`execute`/`guided`) only
  lands on items that clear the same money/irreversible/value gate; the rest are
  held back for individual review. The same three checks guard the shortcut as
  guard the one-at-a-time path, so bulk buys speed, never a lower bar.
- **Nothing has no fallback.** An adapter that is missing, or that cannot do the
  mode it was asked for, degrades to `guided.fallback`, which renders the action
  as copy-ready text. The work still gets done, by hand.

## Adding a capability

Drop a folder in `capabilities/`. No core code changes, ever. If adding one
requires touching the Action Center, that is a bug.

```
capabilities/<id>/
  manifest.yaml    # the contract: trigger, emitted types, policy, execution
  index.ts         # optional in v0; the anchor capabilities are Claude skills
```

`capabilities/wrap/manifest.yaml` is the worked example. The manifest is
validated on load, and a bad one fails loudly with the reason rather than being
skipped: a policy predicate referencing an undeclared field, a render spec
pointing at a field that does not exist, or an execution target missing from
`requires_capabilities` all fail at load, not at 2am.

## Layout

```
src/
  types/          the five contracts of §4, as zod schemas with types inferred
  store/          Action Store: migrations, and the only path that mutates items
  policy/         Policy Engine and the sandboxed predicate evaluator
  registry/       capability discovery, validation, registration
  routing/        abstract action type -> provider, account, mode
  execution/      the registry and its adapters
  action-center/  ingest, lifecycle, execute, confirm
  recall/         Ask-Samaritan: chunk, embed, index, fuse, retrieve, synthesise
  delivery/       Telegram, quiet hours
  api/            Fastify server
  cli/            migrate, serve, emit, index
capabilities/     wrap, meeting
plugin/           the 8 Claude skills, vendored (this is what runs today)
docs/             design suite
```

## Configuration

`~/.samaritan/config.yaml` holds non-secret settings only, and is written with
defaults on first run.

**Notion database ids are not in the repo.** They identify one specific private
workspace, so they are local configuration. Set them before anything can file to
Notion; an unset id fails with a clear message rather than writing somewhere
unexpected.

These are *database* ids, which is what the REST API's `parent.database_id`
takes. Notion issues a separate *data source* id for the same table, which is
what the Notion MCP tool wants. They are different values, they are not
interchangeable, and using one where the other belongs returns a 404. The
reliable way to get the right one is to ask the API rather than read it out of a
doc:

```bash
curl -s -X POST https://api.notion.com/v1/search \
  -H "Authorization: Bearer $TOKEN" -H 'Notion-Version: 2022-06-28' \
  -H 'content-type: application/json' \
  -d '{"filter":{"property":"object","value":"database"}}' \
  | jq -r '.results[] | "\(.title[0].plain_text)\t\(.id)"'
```

```yaml
notion:
  account: pm-os-workspace
  databases:
    decisions: "..."
    insights: "..."
    people: "..."
    projects: "..."
```

The schema those adapters write to is documented in the vault's own
`AGENT_OS.md`: Decisions uses `Decision` as its title property, Insights uses
`Insight`, `Status` is pending/resolved, and `Project` is a relation rather than
text.

Secrets live in the macOS Keychain under service `samaritan`, never in config,
never in the store, never in logs. Filing to Notion needs a token:

```bash
security add-generic-password -s samaritan -a notion:pm-os-workspace -w
```

Without it, `notion.*` adapters report `not_configured` and any item routed to
them fails loudly rather than silently appearing to succeed. TickTick is
guided-only in v0 (no OAuth flow yet), so tasks stage for confirmation instead of
being created.

Any secret can be overridden by an environment variable for a single run, for
example `SAMARITAN_NOTION_PM_OS_WORKSPACE`.

## Tests

```bash
pnpm test        # 502 tests
pnpm typecheck
```

`test/anchor.test.ts` is the one that matters: it is the executable form of the
v0 success criterion, that no wrap or meeting row reaches Notion without an
explicit approve or edit-then-approve.
