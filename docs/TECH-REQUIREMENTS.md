---
title: Samaritan Action Center — Technical Requirements Document
subtitle: Enumerated, testable requirements for the HITL layer and pluggable capability platform
part_of_suite: PRD.md, TECH-SPEC.md, UI-SPEC.md, PRFAQ.md
owner: Sandip Dev
status: Draft v0.1
date: 2026-07-19
---

# Samaritan Action Center — Technical Requirements Document

## 1. Purpose & Scope

This document enumerates the functional and non-functional requirements that the Samaritan Action Center platform must satisfy. It operationalizes the goals and architecture in `PRD.md` into atomic, verifiable requirements; `TECH-SPEC.md` owns the detailed data models, APIs, and implementation design that satisfy them, and `UI-SPEC.md` owns the exact surface specs for the views referenced in §3.7.

**In scope:** the Run Layer, Policy Engine, Action Center (inbox/lifecycle/rendering), Execution Registry & Routing, Ask-Samaritan (RAG), Dashboard & Views, Delivery, the local daemon/runtime, and the auto-plug-in mechanism that makes adding a capability cheap. **Anchor use case for v0:** `wrap` and `meeting` gated by a mandatory review before any Notion/TickTick write.

**Audience:** Sandip, as sole author, builder, and user of the system (single-user platform; see §5).

**Notation:** requirement keywords SHALL / SHOULD / MAY follow RFC 2119 usage — SHALL denotes a mandatory, testable requirement; SHOULD a strong recommendation with a documented exception path; MAY an optional, capability-level choice. Each requirement carries a stable ID (`FR-<area>-<n>` / `NFR-<n>`) for traceability from code, tests, and PRs back to this document.

## 2. Definitions & Glossary

| Term | Definition |
|---|---|
| **Capability** | A unit of vertical domain logic (skill, agent, or scheduled task) that plugs into the OS via a manifest + standard entrypoint. Owns *what*, never *how*. |
| **Manifest** | The thick, declarative contract a capability ships: identity, trigger, context needs, emitted action-item types, required capabilities, delivery, and audit settings. |
| **Trigger** | The condition (scheduled / event / manual / continuous) that causes the Run Layer to invoke a capability. |
| **Run mode** | One of `scheduled` (cron), `event` (fires on a subscribed event type), `manual` (fires on a bound command), `continuous` (persistent watch, implemented as frequent polling / event subscription). |
| **Run Layer** | The service that fires capabilities per their declared trigger and injects declared context before invocation. |
| **Policy Engine** | The rule layer that decides **auto-complete vs. escalate** for a result, based on confidence, reversibility/blast-radius, value, and action-type. |
| **Escalate** | Route an action item to the Action Center inbox for a human decision, instead of auto-completing it. |
| **Auto-complete** | Dispatch an action item straight to execution without human review, per policy. |
| **Confidence** | A 0–1 score (model/extraction confidence) attached to an action item; a policy input. |
| **Blast radius / reversibility** | How much damage an action could do and how hard it is to undo; a policy input independent of confidence. |
| **Action Item** | The standardized unit a capability emits describing a proposed action: shared attributes + capability-declared custom attributes + render schema + allowed responses + execution block. The lingua franca between capabilities and the Action Center. |
| **Dedupe key** | An optional, capability-declared identifier that, paired with `capability_id`, is the idempotency key the ingest path uses to upsert a re-emitted item instead of duplicating it (FR-AC-11). |
| **Decision surface** | Where Sandip reviews an action item (e.g., inbox, Telegram). |
| **Execution surface** | The system where the action ultimately lands (e.g., Notion, Gmail). |
| **Provenance** | The ordered path an action item travelled from trigger to decision (e.g., `email.received → newsletter-digest.run → policy.escalate`), used for audit and recall. |
| **Execution mode** | **Guided** (agent gives content + link, human executes entirely), **assisted** (agent stages, human commits — e.g., Gmail draft), or **automated** (agent completes on approval — e.g., files a Notion row). |
| **Execution Registry** | The catalogue of abstract action types (e.g., `email.send`) mapped to connected providers, accounts, and supported/default execution modes. |
| **Routing** | Config resolving an abstract action type → concrete provider + account + default mode, editable in Settings without touching capability code. |
| **Connection** | An OAuth-authenticated link to a third-party provider (Gmail, Notion, TickTick, …), tracked with live status in Settings. |
| **Degrade (to guided)** | Automatic fallback when a capability requires an action type with no connected provider — the action still surfaces, in guided mode, with a warning, rather than the run failing. |
| **Lifecycle state** | One of `pending`, `in_review`, `approved`, `rejected`, `deferred`, `awaiting_confirmation`, `executed`, `failed`, `expired`. `awaiting_confirmation` covers guided items, and assisted items after their external commit, pending Sandip's explicit confirmation (FR-AC-10). See §3.4. |
| **TTL** | Time-to-live declared on an action-item type; an item unactioned past its TTL auto-transitions to `expired`. |
| **Ask-Samaritan / recall** | The RAG layer answering questions by querying structured sources (Notion, TickTick, calendar, audit log) first and falling back to semantic search over unstructured sources (Obsidian, email, Slack, transcripts), citing row IDs / file paths. |
| **Daemon** | The persistent local background process (scheduler + event listeners + Action Center services + local web UI + Telegram push) managed by launchd/systemd/pm2. |

## 3. Functional Requirements

### 3.1 Capabilities & Manifest (FR-CAP)

**FR-CAP-1 — Manifest required fields.** The system SHALL define a manifest schema (YAML) with required fields: `id`, `name`, `description`, `version`, `owner`, `enabled`, `trigger`, `emits`, `requires_capabilities`.
- A manifest missing any required field is rejected at load time with an error naming the missing field.
- A manifest containing only required fields (no optional blocks) loads successfully.

**FR-CAP-2 — Validation on load.** The system SHALL validate every manifest against the schema before registering the capability.
- Malformed YAML (parse error) is rejected with the file path and line reference logged.
- A manifest with an unknown `trigger.mode` value is rejected with a descriptive error, not silently skipped.

**FR-CAP-3 — Emitted type declarations.** Each entry in `emits` SHALL declare a render schema, `custom_attributes`, allowed `responses`, an `execution` block (mode + capability), and a `policy` block.
- An emits entry missing `render.layout` fails validation.
- An emits entry missing `execution.mode` or `execution.capability` fails validation.
- `render.layout` SHALL be one of `{card, form, document, diff}`; any other value fails validation.

**FR-CAP-4 — Standard entrypoint.** A capability SHALL expose a single entrypoint `run(context) -> {action_items[], execution_requests[], status, logs[]}`.
- Calling `run()` with a valid context returns an object matching this shape, or a caught exception is converted to `status: "error"` with the exception message in `logs`.
- `action_items` returned by `run()` that do not match the type's declared `custom_attributes` schema are rejected by ingest (FR-AC-1), not silently accepted.

**FR-CAP-5 — Registry state tracking.** The Capability Registry SHALL track, per capability, at minimum: id, version, enabled/disabled state, and last-run status.
- Setting `enabled: false` prevents the Run Layer from triggering that capability on its next scheduling pass.
- Querying the registry for a capability returns its last-run status and timestamp.

**FR-CAP-6 — Hot-reload, zero core changes.** The system SHALL support enable/disable and hot-reload of a capability on manifest change without editing core code.
- Editing a capability's `manifest.yaml` (e.g., changing a cron schedule) takes effect without modifying any file outside `capabilities/<id>/`.
- Adding a new capability directory requires no changes to Run Layer, Action Center, or Execution Registry source files.

### 3.2 Run Layer (FR-RUN)

**FR-RUN-1 — Four trigger modes.** The Run Layer SHALL support exactly four trigger modes: `scheduled`, `event`, `manual`, `continuous`.
- A `scheduled` capability with a cron expression fires within ±60s of the scheduled time.
- A `manual` capability fires on receipt of its bound command from any registered input surface (in-session chat or Telegram).
- A `continuous` capability is implemented as polling or event subscription at a manifest-declared interval — no dedicated persistent process is required.

**FR-RUN-2 — Event mode filtering.** For `event` mode, the Run Layer SHALL fire a capability when a subscribed event type occurs and the manifest's `filter` predicate (if present) evaluates true.
- An event that does not match `filter` does not trigger a run (verified by absence of an invocation log entry).
- An event matching `filter` triggers exactly one run per event (no duplicate firing).

**FR-RUN-3 — Context injection.** The Run Layer SHALL inject the declared `context.requires` / `context.inputs` / `context.memory` into a capability's `run()` call before invocation.
- A capability declaring `context.requires: [projects.active]` receives that data in its context argument without querying it itself.
- A `run()` invocation with an unavailable required context source aborts before domain logic executes and is logged as `status: error` (fails closed, never proceeds with partial context).

**FR-RUN-4 — Run logging.** Every capability run SHALL be recorded with start time, end time, trigger reason, and status (`ok`/`error`) in the Run Layer's execution log.
- Querying the log by `capability_id` returns the most recent run's status and duration.
- A crashed run (uncaught exception) is recorded as `status: error`, never silently dropped.

### 3.3 Policy Engine (FR-POL)

**FR-POL-1 — Auto-complete vs. escalate gate.** The Policy Engine SHALL evaluate every action item against auto-complete vs. escalate rules before it can reach the Action Center inbox.
- An item whose type's `auto_complete_when` evaluates true is routed straight to execution and never appears in the "Needs you" queue.
- An item with no matching auto-complete rule defaults to escalate (fail-safe default).

**FR-POL-2 — Four policy inputs.** Policy evaluation SHALL consider, at minimum: confidence score, reversibility/blast-radius, value/amount, and action-type.
- An item with confidence below the type's `confidence_threshold` is escalated even if other rules would otherwise auto-complete it.
- An action-type flagged "always escalate" (e.g., `payment.make`, external `email.send`) is escalated regardless of confidence.

**FR-POL-3 — Per-type override.** The Policy Engine SHALL support per-emitted-type overrides of default policy via the manifest's `policy` block.
- Two `emits` types in the same capability can carry different `escalate_when` expressions and are evaluated independently.

**FR-POL-4 — Mode locking.** Policy SHALL support locking an execution mode independent of confidence/risk scoring (e.g., `payment.make` forced to guided).
- A locked-mode action type is never dispatched in automated mode, even when policy would otherwise auto-complete it.
- An attempt to override a locked mode via routing config is rejected with an explicit error, not silently ignored.

**FR-POL-5 — Policy decision logging.** Every policy decision (auto-complete or escalate) SHALL be logged with the rule(s) that fired.
- Querying the audit log for a given action item returns which policy rule produced its auto-complete/escalate outcome.

### 3.4 Action Center & Lifecycle (FR-AC)

**FR-AC-1 — Ingest & validate.** The Action Center SHALL provide a single ingest path that accepts action items from any capability and validates each against its type's declared schema before acceptance.
- An item with a custom attribute absent from the type's declared `custom_attributes` schema is rejected with a validation error.
- A valid item is assigned a UUID and `status: pending` on ingest.

**FR-AC-2 — Lifecycle state graph.** Action items SHALL follow `pending → in_review → (approved | rejected | deferred) → (awaiting_confirmation | executed | failed | expired)`, with `awaiting_confirmation → (executed | expired)`, and SHALL NOT transition outside this graph.
- A direct `pending → executed` transition is rejected unless the item was auto-completed by policy (FR-POL-1).
- A `rejected` or `expired` item can never transition to `executed`.
- A guided item, and an assisted item after its external commit, transitions to `awaiting_confirmation` rather than directly to `executed` (FR-AC-10).

**FR-AC-3 — Shared attribute completeness.** Every action item SHALL carry the full shared-attribute set: `what_happened`, `source`, `provenance`, `why_flagged`, `trigger_reason`, `confidence`, `decision_needed`, `decision_surface`, `execution_surface`, `outcome_preview`.
- Ingest rejects an item missing any shared attribute.
- `provenance` is an ordered list capturing at minimum the triggering event and the capability id.

**FR-AC-4 — Schema-driven rendering.** The Action Center SHALL render each item using the `layout` declared in its type's render schema (`card` / `form` / `document` / `diff`).
- An item declaring `layout: diff` renders a before/after comparison, not a generic card.
- An unrecognized layout value falls back to `card` rather than failing to render.

**FR-AC-5 — Response set.** The Action Center SHALL present only the responses declared in the item type's `responses` list, plus the universal affordances `defer` and `ask-more-info`.
- A response not declared for that type is not selectable in the UI and is rejected if submitted via API.
- `defer` and `ask-more-info` are available on every item type regardless of its declared `responses`, unless the type explicitly opts out.

**FR-AC-6 — Edit-then-approve.** Selecting edit-then-approve SHALL let Sandip modify the execution payload before dispatch, and the edited payload — not the original — SHALL be what executes.
- Editing a field and approving results in the executed payload reflecting the edit, verified in the systems-of-record and audit log.
- The original agent-proposed payload is retained in the audit trail alongside the edited version.

**FR-AC-7 — Ask-more-info routes to recall.** Selecting ask-more-info SHALL route the query to Ask-Samaritan and return a cited answer inline, without leaving the Action Center.
- The returned answer references at least one row ID or file path from its underlying source.
- The action item remains in `in_review` while ask-more-info is used (no lifecycle transition).

**FR-AC-8 — TTL / expiry.** Items past their declared `ttl` SHALL auto-transition to `expired` per the type's expiry rule and SHALL leave the "Needs you now" active queue.
- An item with `ttl: "24h"` transitions to `expired` within 60s of the 24-hour mark if unactioned.
- Expired items remain queryable in Completed; they are never deleted.

**FR-AC-9 — Batch response.** The Action Center SHALL support a single batch response (e.g., approve-all, dismiss-all) across multiple items of the same type.
- Selecting 5 same-type items and choosing "approve all" transitions all 5 to `approved` and dispatches 5 execution requests.
- Batch approval is not offered for item types whose execution mode is policy-locked (FR-POL-4).

**FR-AC-10 — Guided/assisted confirmation required for closure.** For guided items, and for assisted items after their external commit (e.g., a staged Gmail draft is sent), the Action Center SHALL require an explicit user confirmation action ("Mark as done" / "Confirm sent") to transition the item from `awaiting_confirmation` to `executed`; automated items are unaffected and continue transitioning directly to `executed` on successful dispatch.
- A dispatched guided item, or a staged assisted item once its external commit is detected/self-reported, enters `awaiting_confirmation` — not `executed` — until Sandip explicitly confirms.
- An item in `awaiting_confirmation` never auto-appears in the Completed view (FR-UI-6) and is not counted as resolved in any Dashboard tally until confirmed; past a configurable reminder interval it triggers a reminder via its declared delivery channels (FR-DEL-1, FR-DEL-4).
- Selecting "Mark as done" / "Confirm sent" transitions the item to `executed` and records the confirmation timestamp in the execution audit record (FR-EXEC-7).

**FR-AC-11 — Ingest idempotency (upsert on re-ingest).** The shared ingest path (FR-AC-1, invoked via `samaritan.emit()` per FR-PLUG-3) SHALL treat `(capability_id, dedupe_key)` as an idempotency key: re-ingesting the same key while a matching item is `pending` or `in_review` SHALL upsert that item — updating its context/payload and superseding the stale draft, without changing its UUID or lifecycle state — rather than creating a duplicate; re-ingesting when the only matching item is already `executed` SHALL create a fresh item.
- Re-ingesting the same `(capability_id, dedupe_key)` while the existing item is `pending`/`in_review` updates that item in place (payload/context and `updated_at` only); the Inbox shows exactly one item for that key, never two, and the superseded payload remains in the audit trail.
- Re-ingesting the same key when the prior matching item is already `executed` creates a new item with a new UUID and `status: pending`.
- A capability that declares no `dedupe_key` for a given emitted type is exempt from upsert behavior; every ingest for that type creates a new item.

### 3.5 Execution & Routing (FR-EXEC)

**FR-EXEC-1 — Execution Registry catalogue.** The Execution Registry SHALL maintain a catalogue of abstract action types (e.g., `email.send`, `message.work.send`, `task.create`) mapped to connected providers and their supported modes.
- Querying the registry for `email.send` returns at least one provider and its supported modes.
- An abstract action type with zero connected providers is marked unavailable, not silently omitted from the catalogue.

**FR-EXEC-2 — Routing resolution.** Routing config SHALL resolve each abstract action type to a concrete provider + account + default execution mode, editable in Settings without touching capability code.
- Changing an action type's default mode in Settings changes behavior for every capability requesting that type, with zero capability-level change.
- A capability requesting an abstract action with no routing entry defaults to `guided` (fail-safe).

**FR-EXEC-3 — Three execution mode contracts.** The system SHALL support exactly three execution modes — guided, assisted, automated — each with a distinct dispatch contract.
- A guided dispatch returns content + a deep link and makes no external write/API call.
- An assisted dispatch stages content in the target system (e.g., a Gmail draft) and stops short of the final commit.
- An automated dispatch performs the full write and returns a confirmation reference (row ID / URL).

**FR-EXEC-4 — Degrade to guided.** If a capability's `requires_capabilities` includes an action type with no connected provider, the Execution Registry SHALL degrade that action to guided mode and surface a warning rather than failing the run.
- A capability requesting `whatsapp.send` with no WhatsApp connection produces a guided-mode action item, not a failed run.
- The degrade event is logged and visible on the capability's status in the Dashboard agents panel.

**FR-EXEC-5 — Failure handling.** Execution failures (bounce, decline, API error) SHALL set the item to `failed`, notify Sandip, and offer retry or guided fallback.
- A simulated API error on an automated dispatch results in `status: failed`, never a silently stuck `approved` item.
- A failed item offers at least one recovery response (retry, or hand off as guided).

**FR-EXEC-6 — Locked, irreversible actions.** `payment.make` and any other capability-declared irreversible/high-value action type SHALL be routing-locked to guided mode, and the lock SHALL NOT be overridable by policy or routing config.
- No code path can dispatch `payment.make` in automated or assisted mode; attempting to do so raises a hard error, not a warning.

**FR-EXEC-7 — Execution audit record.** Every dispatched execution SHALL record capability id, action type, mode, provider/account, pre- and post-edit payload, and result reference in the audit log.
- Given an executed item's id, the audit log returns the exact payload sent and the resulting system-of-record reference (e.g., a Notion row URL).

### 3.6 Ask-Samaritan / RAG (FR-RAG)

**FR-RAG-1 — Structured-first retrieval.** Ask-Samaritan SHALL classify each query and route factual/structured questions ("who owns X," "status of Y") to direct queries against Notion/TickTick/calendar/audit log before falling back to semantic search.
- A query matching a known structured pattern returns an answer sourced from a direct DB query, not vector search, when the structured source has the answer.
- If the structured query returns no result, the system falls back to semantic search rather than returning "not found" immediately.

**FR-RAG-2 — Semantic search for rationale.** For "why"/rationale questions, Ask-Samaritan SHALL perform semantic/vector search over unstructured sources (Obsidian vault, email, Slack, transcripts).
- A "why did we choose X over Y" query returns a synthesized answer drawing on at least one unstructured source when structured data alone is insufficient.

**FR-RAG-3 — Mandatory citations.** Every Ask-Samaritan answer SHALL be grounded with citations to a row ID (structured) or file path + location (unstructured); uncited claims SHALL NOT be presented as fact.
- Every factual claim in a recall answer carries or links to a citation.
- If no source supports a claim, the system states it cannot find a source rather than asserting the claim uncited.

**FR-RAG-4 — Consistent dual entrypoint.** Ask-Samaritan SHALL be queryable both standalone (`/recall`) and inline via an item's ask-more-info (FR-AC-7), using the same retrieval pipeline.
- The same question asked via `/recall` and via ask-more-info returns a consistent answer citing the same sources.

**FR-RAG-5 — Incremental local index.** The system SHALL maintain a local vector index over unstructured sources, incrementally updated as new content is captured.
- A note captured via `capture` or filed via `wrap` becomes semantically retrievable within one indexing cycle (target: 15 minutes; see NFR-3).
- The vector index persists across daemon restarts; it is not rebuilt from scratch each time.

**FR-RAG-6 — Notion mirror sync (incremental, write-through).** The system SHALL maintain a local mirror of subscribed Notion databases/pages backing Ask-Samaritan's structured retrieval (FR-RAG-1), synced incrementally by each page's `last_edited_time` with exponential backoff on API errors/rate limits, and updated write-through immediately after any Samaritan-initiated Notion execution (FR-EXEC-7) — never by polling the full workspace.
- A sync cycle requests only pages with `last_edited_time` after the last successful sync cursor, not a full-workspace query.
- On a Notion API rate-limit response, the sync backs off exponentially and retries on a later cycle rather than failing the run or issuing an immediate retry storm.
- An automated execution that writes a Notion row (e.g., via `wrap`/`decision`) updates the local mirror for that row immediately, so a subsequent Ask-Samaritan query reflects it without waiting for the next poll cycle.
- The sync cursor persists across daemon restarts (ties to NFR-4); a restart resumes incremental sync rather than triggering a full re-sync.

### 3.7 Dashboard & Views (FR-UI)

**FR-UI-1 — Stat tiles.** The Dashboard SHALL display four live stat tiles: Needs you, Auto-handled today, Deferred, Agents.
- "Needs you" equals the count of items in `pending`/`in_review` at page load.
- "Agents" shows `active/total` and flags at least one issue if any capability's last run was `status: error` or a connection expired.

**FR-UI-2 — Agents panel.** The Dashboard SHALL show a plugged-in agents panel listing every registered capability with a status dot (`active` / `idle` / `error`).
- A capability whose last run errored shows an `error` dot within one polling cycle of the failure.
- A disabled capability (FR-CAP-6) never shows as `active`.

**FR-UI-3 — Needs-you-now & handled feed.** The Dashboard SHALL show a "Needs you now" preview and a "Handled automatically today" feed, each linking to its full view.
- Clicking a "Needs you now" preview item opens it in the Inbox, in review mode.
- The "Handled automatically" feed shows only items auto-completed by Policy (FR-POL-1), never items still pending.

**FR-UI-4 — Inbox view.** The Inbox SHALL render all `pending`/`in_review` items using each item's declared render schema, filterable by capability, type, and priority.
- Filtering by capability shows only that capability's emitted types.
- An empty inbox renders an explicit empty state, not a blank screen.

**FR-UI-5 — Deferred view & resurfacing.** The Deferred view SHALL list `deferred` items with their resurface time and SHALL move an item back to `in_review` automatically at that time.
- An item deferred to "9:00 AM" appears back in Inbox/Needs-you at 9:00 AM with no manual action.

**FR-UI-6 — Completed view / audit trail.** The Completed view SHALL show the full audit trail (executed/rejected/failed/expired items) and SHALL be the canonical source for recall's structured citations.
- Every item leaving `in_review` appears in Completed with its final state and timestamp, regardless of outcome.
- Completed items are read-only; no state transitions are offered from this view.

**FR-UI-7 — Settings: Connections & Routing.** Settings SHALL expose Connections (OAuth status per provider) and a Routing table (abstract action → provider/account/mode), editable inline.
- Revoking/expiring a connection is reflected in the Dashboard agents panel within one polling cycle.
- Editing a routing row's mode persists and is applied to the next dispatch of that action type (FR-EXEC-2).

### 3.8 Delivery & Notifications (FR-DEL)

**FR-DEL-1 — Priority-based push.** The system SHALL push notifications for high/urgent action items to Telegram in addition to the in-app inbox.
- An item created with `priority: urgent` triggers a Telegram push within 60s of ingest.
- A `priority: low` item does not trigger a push by default (in-app only).

**FR-DEL-2 — Quiet hours & digest.** Delivery SHALL respect a configurable quiet-hours window; non-urgent notifications SHALL be held and delivered as a single digest after the window ends.
- An item created during quiet hours below `urgent` priority produces no push during the window.
- Held items are delivered as one digest push at the window's end, not as individually delayed pushes.

**FR-DEL-3 — Telegram-actionable.** Sandip SHALL be able to action at minimum {approve, dismiss} directly from Telegram without opening the web UI.
- Approving an item via a Telegram reply transitions its state identically to approving it in the web Inbox, with the same audit trail.

**FR-DEL-4 — Declarable channels.** Delivery channel selection SHALL be declarable per emitted type (`delivery.channels`) and SHALL default to `{inbox}` if unspecified.
- A type declaring `delivery.channels: [inbox]` never produces a Telegram push, regardless of priority.

### 3.9 Runtime & Daemon (FR-RT)

**FR-RT-1 — Persistent daemon.** The system SHALL run as a persistent background daemon (launchd / systemd / pm2) providing the scheduler, event listeners, Action Center services, local web UI, and Telegram push.
- Killing the daemon process results in automatic restart within the process manager's configured interval (target: <60s).
- The daemon starts automatically on machine boot/login without manual intervention.

**FR-RT-2 — Local-only by default.** The local web UI SHALL be served on `localhost` only by default, with no data leaving the machine except to explicitly connected third-party APIs.
- The UI is unreachable over the network unless a tunnel (Tailscale / Cloudflare Tunnel) is explicitly configured.

**FR-RT-3 — Filesystem watcher.** The daemon SHALL watch `~/Developer/*/journal` (and other configured local paths) and be able to trigger `event`-mode capabilities on file changes.
- A new file written to a watched journal directory triggers any capability subscribed to that event within one watch cycle.

**FR-RT-4 — Scheduler-sync adapter.** The daemon SHALL periodically read Claude's scheduled-task registry and adopt tasks tagged `sam:` into the Run Layer.
- A Claude scheduled task tagged `sam:wrap-nightly` is discoverable by the Run Layer without manual re-registration.
- A scheduled task without the `sam:` tag is ignored (opt-in only, no implicit adoption).

**FR-RT-5 — v0 scheduler substitution.** v0 MAY defer the standalone scheduler component and rely on Claude's scheduled-tasks for cron-mode triggers, provided event- and manual-mode triggers still function via the daemon.
- With the standalone scheduler disabled, a `scheduled`-mode capability still fires via an adopted Claude scheduled task (FR-RT-4).

### 3.10 Auto-Plug-In (FR-PLUG)

**FR-PLUG-1 — Scaffolder.** The system SHALL provide a capability scaffolder (`/new-capability`) that generates a `capabilities/<id>/` directory with a starter manifest and an entrypoint pre-wired to emit via `samaritan.emit()`.
- Running the scaffolder with a new id produces a `manifest.yaml` that passes validation (FR-CAP-2) unmodified.

**FR-PLUG-2 — Zero-core-edit drop-in.** Dropping a valid `capabilities/<id>/` directory into the known location SHALL result in discovery, validation, registration, and wiring with zero edits to Run Layer, Policy Engine, Action Center, or Execution Registry source.
- Adding a new capability directory and hot-reloading the daemon surfaces the capability in the Dashboard agents panel with no diff to any core service file.

**FR-PLUG-3 — Shared ingest function.** `samaritan.emit()` SHALL be the single shared function any capability uses to submit action items to the Action Center ingest path (FR-AC-1).
- Calling `samaritan.emit()` with a valid action item follows the same ingest path (validation, UUID assignment) as a value returned from `run()`.

**FR-PLUG-4 — Isolated validation failure.** A capability that fails validation on drop-in SHALL be rejected with a clear, actionable error, SHALL NOT be registered or appear in any view, and SHALL NOT affect other capabilities or crash the daemon.
- A capability with a malformed manifest is absent from the Dashboard agents panel and produces a log entry naming the specific validation failure.
- Other already-registered capabilities continue operating normally while one capability fails validation.

## 4. Non-Functional Requirements

### 4.1 Performance

**NFR-1 — Inbox load time.** The Inbox view SHALL load in under 1s (p95) for up to 200 pending items on local hardware.

**NFR-2 — Capability run latency ceiling.** A capability's `run()` SHALL complete or be timed out within a manifest-configurable maximum (default 120s); the Run Layer SHALL NOT let a hung capability block other scheduled runs.

**NFR-3 — Ask-Samaritan latency.** Structured (DB-backed) queries SHALL return in under 2s (p95); semantic/vector queries SHALL return in under 5s (p95).

### 4.2 Reliability

**NFR-4 — Auto-restart, no lost state.** The daemon SHALL auto-restart within 60s of a crash, and the action-item store SHALL persist to disk (not memory-only) so no item is lost across a restart.

**NFR-5 — No silent drops.** No action item, once ingested, SHALL be silently dropped: every item SHALL reach a terminal lifecycle state (`executed` / `failed` / `expired` / `rejected`) or remain visibly queued.

**NFR-6 — Capability fault isolation.** A single capability's failure (exception, timeout, malformed manifest) SHALL NOT crash the daemon or block other capabilities' runs.

### 4.3 Security & Privacy

**NFR-7 — Local-first data residency.** The vault, journals, and the action-item/audit store SHALL reside on the local machine (or a user-controlled always-on host) by default; no raw data leaves the machine to third-party cloud storage without explicit opt-in.

**NFR-8 — Credential storage.** OAuth tokens/credentials for connected providers SHALL be stored encrypted at rest and SHALL NOT appear in plaintext in any log or audit entry.

**NFR-9 — Money never moves automatically.** Policy-locked action types (e.g., `payment.make`) SHALL be architecturally incapable of automated or assisted execution — enforced in code, not configuration alone, so no config error can move money without an explicit human act (ties to FR-POL-4, FR-EXEC-6).

**NFR-10 — Remote access gate.** Remote access to the local web UI SHALL require an explicit, user-initiated tunnel (Tailscale / Cloudflare Tunnel) or an authenticated Telegram session; there SHALL be no default open network listener (ties to FR-RT-2).

### 4.4 Extensibility

**NFR-11 — Zero-core-change capability addition.** Adding a new capability SHALL require zero changes to Run Layer, Policy Engine, Action Center, or Execution Registry source code (verified per FR-PLUG-2).

**NFR-12 — Contract versioning.** The Action-Item, Trigger, and Execution contracts SHALL be versioned; a breaking schema change SHALL NOT silently break already-registered capabilities — old contract versions continue validating until the capability is migrated.

### 4.5 Observability & Audit

**NFR-13 — Append-only audit log.** Every action-item state transition (ingest, policy decision, response, execution result) SHALL be recorded in an append-only audit log, queryable by capability, type, date range, and outcome, and retained indefinitely by default.

**NFR-14 — System health at a glance.** Daemon uptime, per-capability last-run status, and per-provider connection status SHALL be visible on the Dashboard without querying logs directly.

### 4.6 Usability

**NFR-15 — Glanceable triage.** From the Dashboard alone, Sandip SHALL be able to tell within 5 seconds how many items need him and whether any capability is broken, via stat tiles and status dots (FR-UI-1, FR-UI-2).

**NFR-16 — Self-contained decisions.** Every rendered action item SHALL surface its decision-relevant information (`what_happened`, `why_flagged`, `outcome_preview`) without a click-through, regardless of render layout.

### 4.7 Integration & Platform Dependencies

**NFR-17 — Third-party API rate-limit compliance.** All incremental sync/polling integrations, including the Notion mirror (FR-RAG-6), SHALL implement exponential backoff on rate-limited (e.g., HTTP 429) responses and SHALL remain within each provider's documented rate limits under normal operation — verified by the absence of sustained rate-limit errors in the integration's request log, and by sync cycles never falling back to full-dataset re-fetches as a substitute for incremental sync.

**NFR-18 — macOS Full Disk Access prerequisite.** The daemon SHALL require macOS Full Disk Access to read local chat databases (`chat.db` for iMessage; the WhatsApp local store) for any capability that depends on them; if Full Disk Access has not been granted, the daemon SHALL detect this at startup or on first access and surface a clear, actionable error naming the required System Settings path, rather than failing silently or crashing.

## 5. Constraints & Assumptions

- **Single user.** Sandip is the only user; the routing/policy layer is designed *as if* multi-user but ships single-user (per PRD Non-Goals). No auth/tenancy system required beyond OAuth to third-party providers.
- **Local-first runtime.** Primary runtime is Sandip's laptop or an always-on Mac mini / home server; cloud VPS is optional and deferred (§6).
- **Existing skills are wrapped, not rewritten.** `capture`, `log`, `decision`, `file`, `meeting`, `wrap`, `recall` are assumed functionally complete; this platform wraps them in manifests rather than reimplementing their internal logic.
- **Manifest format is YAML**, co-located with each capability at `capabilities/<id>/manifest.yaml` (per PRD §6 decision).
- **v0 may lean on Claude's built-in scheduled-tasks** in place of a custom scheduler (FR-RT-5); the daemon becomes mandatory once event-driven triggers and always-on push are required.
- **Third-party APIs assumed available** within their documented rate limits: Gmail, Google Calendar, Slack, TickTick, Notion, Fireflies, Telegram (Claude Channels), iMessage (local), WhatsApp.
- **No dedicated ops/SRE function.** The daemon must be self-healing (auto-restart) since there is no on-call.
- **The OpenClaw confidence gate is the reference prototype** for the Policy Engine's confidence-based escalation; it is generalized, not replaced wholesale.

## 6. Out of Scope (v0)

- **Earn-autonomy feedback loop** — automatically raising auto-complete thresholds from approval history. Deferred to backlog.
- **Remote/cloud hosting (VPS) as primary runtime.** Remote access is via Telegram + Tailscale/Cloudflare Tunnel to the local instance, not a hosted backend.
- **Multi-user / delegation.** Single-user only.
- **Assisted-mode breadth beyond Gmail drafts.** Broader assisted integrations (e.g., additional draft-and-stage targets) are v1+.
- **Advanced digesting / notification summarization** beyond the basic quiet-hours digest (FR-DEL-2).
- **Rewriting existing skills' internal logic** — the Action Center wraps `meeting`/`wrap`/etc., it does not re-architect them.
- **Full render-layout library.** v0 needs `card` + `document` (or `diff`) sufficient for `wrap`/`meeting`; the remaining layouts generalize in v1 as more capabilities plug in.

## 7. Dependencies

- **Claude scheduled-tasks** — cron substitute for v0 (FR-RT-5); scheduler-sync adapter (FR-RT-4) adopts tasks tagged `sam:`.
- **Third-party integration APIs** — Gmail, Google Calendar, Slack, TickTick, Notion, Fireflies, Telegram (Claude Channels), iMessage (local), WhatsApp — each a Connection in Settings (FR-UI-7) and a provider in the Execution Registry (FR-EXEC-1).
- **macOS Full Disk Access** — required by the daemon to read `chat.db` (iMessage) and the WhatsApp local store; granted via System Settings → Privacy & Security → Full Disk Access for the process running the daemon. Absence is detected and surfaced per NFR-18.
- **Obsidian vault** — local Markdown files as the primary unstructured source of record for `capture`, `log`, and semantic recall (FR-RAG-2).
- **Local vector store** — LanceDB / Chroma / sqlite-vec, or an existing memory framework (Claude Mem / Mem Search), for the Ask-Samaritan semantic index (FR-RAG-5).
- **Process manager** — launchd (macOS) / systemd (Linux) / pm2, for daemon auto-start and auto-restart (FR-RT-1, NFR-4).
- **Tunnel (optional)** — Tailscale or Cloudflare Tunnel for remote access to the local web UI (FR-RT-2, NFR-10).
- **OpenClaw confidence gate** — existing prototype the Policy Engine's confidence-based escalation generalizes from (§5).
