---
title: Samaritan — Technical Specification / Design Document
subtitle: Implementation blueprint for the Action Center platform
owner: Sandip Dev
author: Sandip Dev
status: Draft v0.1
date: 2026-07-19
companion_docs: [PRD.md, TECH-REQUIREMENTS.md, UI-SPEC.md, PRFAQ.md]
---

# Samaritan — Technical Specification / Design Document

This is the buildable counterpart to `PRD.md`. The PRD argues *why* the Action Center is a platform and defines the product contracts; this document specifies *how* it gets built — components, stack, schemas, APIs, runtime, and build order — at a level an engineer (or Claude Code) can implement directly against. It does not restate product rationale (`PRD.md`), UI visuals (`UI-SPEC.md`), or market framing (`PRFAQ.md`); see those docs for that. Naming throughout is identical to the shared design canon: Action Center, capability, manifest, Run Layer, Policy Engine, Execution Registry, guided/assisted/automated, decision_surface/execution_surface.

## 1. Overview & design goals

Samaritan is Sandip's personal agentic OS. The Action Center is its universal Human-in-the-Loop layer and pluggable capability platform: one inbox for everything that needs Sandip, sitting on top of four layers (Run → Policy → Action Center → Execution) and three shared contracts (Trigger, Action-Item, Execution/Capability).

**Design goals for this implementation:**

- **Pluggability is a hard constraint, not a feature.** A new capability is a folder — `capabilities/<id>/manifest.yaml` + an entrypoint. Discover → validate → register → wire. Zero core code changes, ever. If adding capability #20 requires touching the Action Center's code, the architecture has failed.
- **Contracts over convention where it matters.** The Action-Item and Manifest shapes are typed and runtime-validated (zod) at every boundary they cross (ingest, render, execute). Capabilities are otherwise free to do whatever they want internally.
- **Local-first, single-user, laptop-first.** No server dependency for the core loop. Data (Action Store, vector index, vault) lives on Sandip's machine. Remote access is additive (Telegram, tunnel), never required.
- **The human is the executor of last resort.** Every action type must have a working `guided` path before it's ever promoted to `assisted` or `automated`. Nothing is allowed to have *no* fallback.
- **Boring technology, sized to the actual load.** One user, dozens of action items a day, a handful of capabilities. One Node process and one SQLite file beat a microservice mesh at this scale — optimize for buildability and debuggability, not for hypothetical horizontal scale.
- **Auditable by construction.** Every state transition of every action item is recorded before anything else happens. `recall`'s trustworthiness — and Sandip's trust in autonomy over time — depends on this being non-negotiable, not bolted on later.
- **Ship the anchor first.** v0 proves the platform on the two highest-inference capabilities (`wrap`, `meeting`) with a hard review gate before any Notion/TickTick write. Everything else generalizes from that thin slice (see §12).

## 2. System architecture

### 2.1 Component diagram

```
                              EXTERNAL INPUTS
     capabilities/*/manifest.yaml + index.ts   (filesystem; read on boot + hot-reload)
     cron ticks  |  webhooks (Fireflies/Slack/Gmail)  |  pollers (TickTick/Gmail/iMessage)
     fs.watch (chokidar): Obsidian vault, ~/Developer/*/journal
                                       |
                                       v
+--------------------------------------------------------------------+
| CAPABILITY REGISTRY & LOADER
| discover -> validate (zod against manifest schema) -> register -> wire
+--------------------------------------------------------------------+
                                       | registers triggers
                   +-------------------+--------------------+
                   v                                         v
+-----------------------------+                +-----------------------------+
| SCHEDULER                    |                | EVENT BUS & LISTENERS        |
| node-cron (v1) /             |                | webhooks + pollers +         |
| Claude scheduled-tasks (v0)  |                | fs.watch, normalized into    |
| via scheduler-sync adapter   |                | one internal Event shape     |
+-----------------------------+                +-----------------------------+
                   |                                         |
                   +-------------------+--------------------+
                                       v
+--------------------------------------------------------------------+
| RUN LAYER
| dispatch: scheduled | event | manual | continuous
| invokes capability.run(context) inside try/catch + timeout
+--------------------------------------------------------------------+
                                       | action_items[]
                                       v
+--------------------------------------------------------------------+
| POLICY ENGINE
| evaluate(draft, policy) -> auto_complete | escalate  (+ reason)
+--------------------------------------------------------------------+
                auto_complete |                    | escalate
                               |                    v
                               |      +--------------------------------+
                               |      | ACTION CENTER SERVICE            |  <---> Web UI/API
                               |      | ingest . triage . render .       |        (Fastify +
                               |      | decide . execute . confirm .     |        React SPA,
                               |      | expire . audit                   |        127.0.0.1:4173)
                               |      +--------------------------------+
                               |                    | Sandip decides (approve/
                               |                    | edit/reject/defer/ask-more)
                               v                    v
+--------------------------------------------------------------------+
| ACTION STORE   (SQLite, ~/.samaritan/samaritan.db)
| action_items . action_item_events (audit, append-only) . capabilities .
| triggers . routing_config . connections . executions .
| recall mirror tables . recall_chunks (+ FTS5 / sqlite-vec)
+--------------------------------------------------------------------+
                                       | approved item
                                       v
+--------------------------------------------------------------------+
| ROUTING RESOLVER
| resolve(actionType) -> { provider, account, mode, locked }
+--------------------------------------------------------------------+
                                       v
+--------------------------------------------------------------------+
| EXECUTION REGISTRY & ADAPTERS
| guided (deep link/instructions) . assisted (stage) . automated (commit)
| idempotency_key required on every request
+--------------------------------------------------------------------+
                                       v
          Notion . TickTick . Obsidian . Gmail . Calendar .
          Slack . iMessage . WhatsApp

CROSS-CUTTING (called from any stage above — not pipeline steps):
+-----------------------------+          +----------------------------------+
| DELIVERY SERVICE             |          | RECALL / RAG SERVICE               |
| pushes to Telegram,          |          | query(question) -> structured SQL  |
| respects quiet_hours,        |          | + sqlite-vec/FTS5 semantic search  |
| queues during quiet window   |          | -> synthesis with citations        |
+-----------------------------+          +----------------------------------+

Everything above (except the external systems on the right/bottom) runs inside
ONE Node process — the daemon/kernel — supervised by launchd (macOS) or pm2,
bound to 127.0.0.1 only. See §6.
```

### 2.2 Component responsibilities

**Daemon / kernel** — the single long-running Node process that hosts every component below in-process. Owns process lifecycle (config load, composition root wiring components together, graceful shutdown on SIGTERM), exposes `GET /healthz`, and is the thing launchd/pm2 supervises. Not a "service" in its own right — it's the boundary around everything else.

**Scheduler** — fires `trigger.mode: scheduled` capabilities on their declared cron expression. v0: delegated to Claude scheduled-tasks (no daemon required yet). v1: `node-cron`, running in-process, with the scheduler-sync adapter (§8) — informed by a one-time push registration, never by polling Claude's scheduler — keeping track of any capability still owned by a Claude scheduled task so nothing double-fires.

**Event Bus & listeners** — normalizes heterogeneous inputs (webhooks from Fireflies/Slack/Gmail-push; pollers for TickTick/Gmail-history/iMessage; filesystem watch via chokidar on the vault and `~/Developer/*/journal`) into one internal `SamaritanEvent` shape and publishes it on an in-process `EventEmitter`. The Run Layer subscribes for `trigger.mode: event` capabilities.

**Capability Registry & loader** — walks `capabilities/*/manifest.yaml` on boot and on `POST /api/capabilities/reload`; validates each manifest with zod against the contract schema; registers triggers with the Run Layer; registers emitted types + render/validation schemas with the Action Center; cross-checks `requires_capabilities` against the Execution Registry (missing → degrade that action type to `guided`, warn); persists the manifest into the `capabilities` table as the source of truth every other component reads.

**Run Layer** — the dispatcher. Given a fired trigger (from Scheduler, Event Bus, a manual command, or a continuous poll), resolves the target capability, builds `RunContext` (injects requested `context.requires`/`inputs`/`memory`), invokes `run(context)` inside `try/catch` + a timeout race, and hands the returned `action_items[]` to the Policy Engine. Isolates one capability's failure from the daemon and from every other capability.

**Policy Engine** — a pure decision function: given a draft action item and its type's `policy` spec (plus hardcoded overrides like the money-lock, §9), returns `auto_complete` or `escalate` with a reason and the matched rule. Stateless, no side effects — deliberately easy to unit test and to reason about in isolation from everything downstream.

**Action Center service** — the universal inbox and the owner of the action-item lifecycle state machine end to end: ingest (validate + dedupe/upsert + persist, §5.1), triage (priority/deadline/batching), render (selects a layout from `render.layout`), decide (accepts a response, enforces the item's allowed `responses[]`), execute (hands off to the Execution Registry on approve), confirm (closes the loop on work that finished *outside* Samaritan), fail, expire (ttl sweep), audit (writes every transition). Guided items, and any `assisted` item whose effect requires an external commit (Sandip clicking Send in Gmail, replying in Slack/WhatsApp, etc.), can't be marked `executed` by the OS itself — Samaritan only ever dispatches them. Those land in `awaiting_confirmation` once dispatched and stay there until Sandip clicks "Mark as done" / "Confirm sent" in the UI, which calls `POST /api/actions/:id/confirm` (§5.1) and transitions the item to `executed`. Without this state the lifecycle would hang indefinitely for anything that finishes off-system — `awaiting_confirmation` is what keeps `recall` and the audit trail honest about what's actually done versus merely handed off.

**Action Store** — the SQLite database at `~/.samaritan/samaritan.db`. Tables: `action_items`, `action_item_events` (append-only audit), `capabilities`, `triggers`, `routing_config`, `connections`, `executions`, plus Recall's mirror tables (`notion_*`, `ticktick_tasks`, `calendar_events`) and `recall_chunks`/`recall_chunks_fts`. Single source of truth — every component reads/writes through it, never around it. Full DDL in §4.4.

**Execution Registry & adapters** — the catalogue of what the OS can actually do. Each entry (`notion.insight.create`, `gmail.draft.create`, …) is backed by an adapter module implementing `execute(request)`. Dispatches by mode: `guided` returns a deep link/instructions with no external call and reports `status: "staged"` back (the real-world action still happens by Sandip's hand); `assisted` stages (e.g., a Gmail draft) and likewise reports `"staged"` whenever committing the effect needs a further external action, `"succeeded"` when the stage itself is the whole effect; `automated` commits and reports `"succeeded"`. §5.3 spells out how the Action Center maps that status onto the item's lifecycle (`"staged"` → `awaiting_confirmation`, closed out via `POST /api/actions/:id/confirm`; `"succeeded"` → `executed` directly). Enforces idempotency via `idempotency_key`. Exposes `verify()` per adapter for connection-health checks surfaced in Settings.

**Routing resolver** — pure lookup + policy check: `resolve(actionType)` reads `routing_config`, returns the concrete `{provider, account, mode}`, and rejects mode changes on `locked` entries. The only component that translates an abstract action type (`email.send`) into a concrete Execution Registry id (`gmail.draft.create` on `sandip@work`).

**Recall / RAG service** — answers `query(question)`. Owns the jobs that keep the structured mirror tables fresh (Notion/TickTick/Calendar pollers), the chunker + embedding pipeline that keeps `recall_chunks` fresh, and the hybrid retrieval + synthesis + citation-validation pipeline (§7). Reads the Action Store directly for structured and audit queries — no separate database.

**Delivery service** — the only component allowed to push to Telegram. Formats action items and digests for a phone-sized surface, respects `quiet_hours` (queues instead of pushing, flushes after the window), and stays a thin outbound layer — no lifecycle or business logic lives here.

**Web UI / API server** — a Fastify instance in the same Node process, exposing `/api/*` (§5) and serving the built React SPA as static files from `/`. The only network-facing surface in the whole system, bound to `127.0.0.1`. The SPA is a thin client over the API; all lifecycle logic stays server-side in the Action Center service.

## 3. Recommended tech stack

| Layer | Recommendation | Alternative |
|---|---|---|
| Language / runtime | **Node.js 20 LTS + TypeScript** | Python 3.12 + FastAPI |
| Action Store | **SQLite** via `better-sqlite3` | Postgres |
| Vector store | **sqlite-vec** (+ FTS5 for keyword) | LanceDB (upgrade path); Chroma (not recommended) |
| Web UI | **Vite + React SPA**, served by the same API server | Server-rendered (Fastify + templates/htmx) |
| Scheduler | **v0:** Claude scheduled-tasks · **v1:** `node-cron` in-process | APScheduler (Python), plain OS cron |
| Event ingestion | **Webhooks** where available, **pollers** elsewhere, **chokidar** for filesystem | Managed event bus (Kafka/Redis Streams) — overkill at this scale |
| Process manager | **launchd** (macOS, production) / **pm2** (dev convenience) | systemd (if hosting ever moves to a Linux home server) |
| API framework | **Fastify** | Express |
| Validation | **zod** (schema + TS type from one definition) | JSON Schema + ajv |
| Secrets | **macOS Keychain** via `keytar` | 1Password CLI, age-encrypted file |

**Rationale — language/runtime.** Samaritan is an integration-glue daemon (webhooks, polling, cron, filesystem watch, a dozen third-party SDKs), not an ML-training system — that favors Node's async I/O model over Python's. More importantly, the whole pluggability story depends on a shared, typed contract (Manifest, Action Item) that both the daemon *and* the SPA frontend consume — one language end-to-end means one set of types (`src/types/*.ts`, imported by both), not a duplicated/drifting schema across a Python backend and a TS frontend. Every integration in the routing table has a solid Node SDK (`@notionhq/client`, `googleapis`, `@slack/web-api`, `telegraf`); TickTick and iMessage don't have official SDKs in either language, so that's a wash. Python's advantage is a deeper RAG/ML ecosystem (LangChain, LlamaIndex) — but the RAG pipeline here (§7) is simple enough (chunk, embed, kNN, fuse, prompt) to implement directly without a heavyweight framework, so that advantage doesn't outweigh the one-language benefit. If Sandip's own tooling preferences shift toward Python later, the contracts in §4 are language-agnostic (JSON Schema-equivalent) and would port.

**Rationale — Action Store.** SQLite is a single file, zero ops, ACID (matters directly for the "no lost items" requirement in §10), trivially backed up (copy the file), and comfortably handles single-user throughput of dozens of writes a day. `better-sqlite3` is synchronous and fast enough that there's no async/connection-pool ceremony to build. Move to Postgres only if Samaritan ever needs concurrent writers from multiple devices or a hosted multi-user future — both explicitly out of scope (see PRD.md Non-Goals: single-user, laptop-first).

**Rationale — vector store.** `sqlite-vec` is a loadable SQLite extension, so the vector index lives in the *same* database file/process as the Action Store — no second server, no Docker container, no Python dependency. Paired with SQLite's built-in FTS5 for keyword search, it covers hybrid retrieval (§7) without adding a moving part. Upgrade to **LanceDB** (has a Node binding, `vectordb`) if the corpus grows past what sqlite-vec comfortably indexes — rough trigger: vector count above ~200k, or a need for richer ANN indexes (IVF_PQ) or built-in versioning. Chroma is deprioritized: even its "embedded" mode tends to want a Python runtime alongside it, which breaks the one-process simplicity this design is built around.

**Rationale — Web UI.** The Inbox is schema-driven (`render.layout: card|form|document|diff`) — a component library maps naturally onto that (`<CardRenderer>`, `<FormRenderer>`, `<DocumentRenderer>`, `<DiffRenderer>`, selected dynamically per item). A built SPA (`vite build` → static `dist/`) served by the same Fastify instance that exposes `/api/*` keeps everything on one origin (no CORS), one port, one process to supervise. Server-rendered HTML (Fastify + htmx) is a legitimate lighter-weight alternative if Sandip wants to minimize frontend tooling later — `UI-SPEC.md` owns the actual view/interaction design; this doc only fixes the serving architecture.

**Rationale — scheduler.** v0 deliberately does *not* require a daemon: capabilities that want `trigger.mode: scheduled` register as a Claude scheduled task tagged `sam:<capability-id>` (using the `mcp__scheduled-tasks__*` tooling already available in this environment), whose job is to shell out to a small CLI that runs the capability and posts through the same ingest path a running daemon would use. This means the Action Center + review gate can ship and prove itself before the daemon exists. v1 migrates scheduled capabilities to in-process `node-cron` once the daemon is running anyway for event listeners — lower latency, works offline, unified logs. The scheduler-sync adapter (§8) makes this a per-capability, explicit cutover, not a flag day.

**Key libraries:** `better-sqlite3`, `node-cron`, `chokidar`, `zod`, `fastify` + `@fastify/static`, `keytar`, `telegraf` (Telegram), `@notionhq/client`, `googleapis` (Gmail/Calendar), `@slack/web-api`, `sqlite-vec`, `@xenova/transformers` (local embeddings, pure JS/WASM), `uuid`, `pino` (structured logging).

## 4. Data model & schemas

Five contracts, all defined once as TypeScript types with a matching zod schema (the zod schema *is* the runtime validator at every boundary; the TS type is inferred from it via `z.infer<>` so the two never drift).

### 4.1 Capability Manifest

```typescript
type RunMode = "scheduled" | "event" | "manual" | "continuous";
type RenderLayout = "card" | "form" | "document" | "diff";
type ExecutionMode = "guided" | "assisted" | "automated";
type ResponseOutcome = "execute" | "guided" | "discard" | "defer" | "ask_more_info";
type Priority = "low" | "normal" | "high" | "urgent";

interface TriggerSpec {
  mode: RunMode;
  cron?: string;              // required if mode === "scheduled"
  on?: string[];               // required if mode === "event", e.g. ["email.received"]
  filter?: Record<string, unknown>;
  command?: string;            // required if mode === "manual", e.g. "/newsletter"
}

interface ActionItemTypeSpec {
  type: string;                 // unique within the capability
  render: {
    layout: RenderLayout;
    primary?: string;           // field name from custom_attributes
    secondary?: string;
    badges?: string[];
  };
  custom_attributes: Record<string, "string" | "string[]" | "number" | "boolean">;
  responses: { id: string; label: string; outcome: ResponseOutcome }[];
  execution: { mode: ExecutionMode; capability: string };  // execution-registry id
  policy?: {
    escalate_when?: string;         // predicate expression, e.g. "worth_acting == true"
    auto_complete_when?: string;
    confidence_threshold?: number;  // 0..1
  };
  priority?: Priority;
  ttl?: string | null;              // e.g. "24h"
}

interface CapabilityManifest {
  id: string;                  // unique, stable, kebab-case
  name: string;
  description: string;
  version: string;             // semver
  owner: string;
  enabled: boolean;
  entrypoint: string;          // path relative to capabilities/<id>/, e.g. "index.ts"

  trigger: TriggerSpec;
  context?: {
    requires?: string[];       // context keys the OS injects into RunContext
    inputs?: string[];         // payload types consumed (event mode)
    memory?: ("recall")[];
  };
  emits: ActionItemTypeSpec[];
  requires_capabilities: string[];  // execution-registry ids; missing -> degrade to guided
  delivery?: { channels?: ("inbox" | "telegram")[]; quiet_hours?: string };
  audit?: boolean;             // default true
  timeout_ms?: number;         // default 60000
}
```

### 4.2 Action Item (runtime instance)

```typescript
type ActionItemStatus =
  | "pending" | "in_review" | "approved" | "awaiting_confirmation"
  | "rejected" | "deferred" | "executed" | "failed" | "expired";
  // awaiting_confirmation: dispatched (guided, or assisted requiring an external
  // commit) but not yet closed out — only a manual POST /api/actions/:id/confirm
  // (§5.1) moves it to executed. See §2.2 (Action Center service) and §5.3.

interface ActionItemContext {           // shared attributes — same shape for every item
  what_happened: string;
  source: { kind: string; id: string; link?: string };
  provenance: string[];                 // the path it travelled, e.g. ["email.received","newsletter-digest.run","policy.escalate"]
  why_flagged: string;
  trigger_reason: "confidence" | "policy" | "value" | "risk" | "action_type";
  confidence: number;                   // 0..1
  decision_needed: string;
  decision_surface: string;             // where Sandip reviews, e.g. "inbox"
  execution_surface: string;            // where the action lands, e.g. "notion"
  outcome_preview: string;
}

interface DraftActionItem {             // what a capability's run() returns, pre-ingest
  capability_id: string;
  type: string;
  context: ActionItemContext;
  custom: Record<string, unknown>;      // validated against the manifest's custom_attributes
  dedupe_key: string;                   // capability-computed idempotency key
}

interface ActionItem extends DraftActionItem {  // persisted, post-ingest
  id: string;                           // uuid v4
  status: ActionItemStatus;
  responses: string[];                  // response ids allowed for this instance
  execution: { mode: ExecutionMode; capability: string; payload: Record<string, unknown> };
  priority: Priority;
  deadline: string | null;
  expires_at: string | null;
  created_at: string;                   // ISO 8601
  updated_at: string;
}
```

### 4.3 Routing Config

```yaml
# routing.yaml — abstract action type -> concrete provider/account/mode
- action_type: message.work.send
  provider: slack
  account: acme-workspace
  mode: automated
- action_type: message.personal.send
  provider: imessage
  account: local
  fallback_provider: telegram
  mode: guided
- action_type: email.send
  provider: gmail
  account: sandip@work
  mode: assisted
- action_type: task.create
  provider: ticktick
  account: work-list
  mode: automated
- action_type: event.schedule
  provider: google-calendar
  account: work
  mode: assisted
- action_type: note.file
  provider: notion
  account: pm-os-workspace
  mode: automated
- action_type: journal.capture
  provider: obsidian
  account: vault
  mode: automated
- action_type: payment.make
  provider: none
  account: manual
  mode: guided
  locked: true            # Policy Engine + Routing + Execution Registry all refuse to promote this — see §9
```

```typescript
interface RoutingEntry {
  action_type: string;       // abstract action, e.g. "email.send"
  provider: string;
  account: string;
  mode: ExecutionMode;
  fallback_provider?: string;
  locked?: boolean;          // cannot be promoted past this mode via the API
}
```

### 4.4 Execution Registry entry

```typescript
type ConnectionStatus = "connected" | "disconnected" | "error" | "not_configured";

interface ExecutionCapability {
  id: string;                        // e.g. "notion.insight.create"
  provider: string;                  // "notion"
  description: string;
  modes_supported: ExecutionMode[];  // which modes this adapter can actually perform
  adapter: string;                   // module path, e.g. "adapters/notion/insightCreate.ts"
  scopes_required: string[];
  status: ConnectionStatus;
  account?: string;
  last_verified_at?: string;
}
```

### 4.5 Audit / Store record

```typescript
interface ActionItemEvent {          // append-only — see §9
  id: string;
  action_item_id: string;
  from_status: ActionItemStatus | null;
  to_status: ActionItemStatus;
  actor: "sandip" | "policy" | "system" | "capability";
  reason?: string;
  payload_diff?: Record<string, unknown>;   // populated on edit-then-approve
  created_at: string;
}
```

**Action Store DDL** (SQLite, `~/.samaritan/samaritan.db`):

```sql
CREATE TABLE capabilities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  manifest_json TEXT NOT NULL,       -- full parsed manifest; source of truth
  enabled INTEGER NOT NULL DEFAULT 1,
  registered_at TEXT NOT NULL,
  last_run_at TEXT,
  last_run_status TEXT
);

CREATE TABLE triggers (
  id TEXT PRIMARY KEY,
  capability_id TEXT NOT NULL REFERENCES capabilities(id),
  mode TEXT NOT NULL,                -- scheduled|event|manual|continuous
  cron TEXT,
  on_events TEXT,                    -- JSON array
  command TEXT,
  claude_scheduled_task_id TEXT,     -- set by the scheduler-sync adapter; nullable
  next_fire_at TEXT
);

CREATE TABLE action_items (
  id TEXT PRIMARY KEY,
  capability_id TEXT NOT NULL REFERENCES capabilities(id),
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  context_json TEXT NOT NULL,
  custom_json TEXT NOT NULL,
  responses_json TEXT NOT NULL,
  execution_json TEXT NOT NULL,
  deadline TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(capability_id, dedupe_key)     -- re-ingest is an upsert against this key; see §5.1 for update-vs-insert logic
);
CREATE INDEX idx_action_items_status ON action_items(status);
CREATE INDEX idx_action_items_capability ON action_items(capability_id);

CREATE TABLE action_item_events (       -- append-only audit trail
  id TEXT PRIMARY KEY,
  action_item_id TEXT NOT NULL REFERENCES action_items(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT,
  payload_diff_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_events_item ON action_item_events(action_item_id);

CREATE TABLE executions (
  id TEXT PRIMARY KEY,
  action_item_id TEXT NOT NULL REFERENCES action_items(id),
  mode TEXT NOT NULL,
  capability TEXT NOT NULL,           -- execution-registry id
  idempotency_key TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,               -- pending|succeeded|failed
  result_json TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(idempotency_key, attempt)
);

CREATE TABLE routing_config (
  action_type TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  account TEXT NOT NULL,
  mode TEXT NOT NULL,
  fallback_provider TEXT,
  locked INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE connections (
  id TEXT PRIMARY KEY,                -- execution-capability id, e.g. notion.insight.create
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  account TEXT,
  scopes_json TEXT,
  last_verified_at TEXT
);

-- Recall / RAG support (see §7)
CREATE TABLE recall_chunks (
  rowid INTEGER PRIMARY KEY,
  source_kind TEXT NOT NULL,          -- obsidian|email|slack|transcript
  source_path TEXT NOT NULL,          -- file path or message id
  heading TEXT,
  chunk_text TEXT NOT NULL,
  embedding BLOB,                     -- float32[] consumed by sqlite-vec
  updated_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE recall_chunks_fts USING fts5(
  chunk_text, source_path, source_kind, content='recall_chunks', content_rowid='rowid'
);
-- sqlite-vec companion virtual table (conceptual):
-- CREATE VIRTUAL TABLE recall_vec USING vec0(embedding float[384]);

-- Structured mirrors kept fresh by pollers, for recall's structured retrieval path
-- notion_decisions/notion_insights are write-through: Execution Registry adapters upsert here directly on
-- successful execute(); the §7 incremental poller (last_edited_time cursor) is a reconciliation safety-net, not primary sync.
CREATE TABLE notion_decisions (id TEXT PRIMARY KEY, title TEXT, rationale TEXT, project TEXT, reversibility TEXT, notion_url TEXT, last_edited_time TEXT);
CREATE TABLE notion_insights  (id TEXT PRIMARY KEY, title TEXT, body TEXT, tags TEXT, notion_url TEXT, last_edited_time TEXT);
CREATE TABLE ticktick_tasks   (id TEXT PRIMARY KEY, title TEXT, list TEXT, due TEXT, status TEXT, last_synced_at TEXT);
CREATE TABLE calendar_events  (id TEXT PRIMARY KEY, title TEXT, starts_at TEXT, ends_at TEXT, attendees TEXT, last_synced_at TEXT);
```

### 4.6 Worked manifest example — newsletter capability

```yaml
# capabilities/newsletter-digest/manifest.yaml
id: newsletter-digest
name: Newsletter Digest
description: Reads configured newsletters, summarizes, flags items worth acting on
version: 0.1.0
owner: sandip
enabled: true
entrypoint: index.ts

trigger:
  mode: event
  on: [email.received]
  filter: { from_in: ["@newsletters"] }

context:
  requires: [user.interests, projects.active]
  inputs:   [email.message]
  memory:   [recall]

emits:
  - type: newsletter-digest-review
    render:
      layout: card
      primary: summary
      secondary: top_links
      badges: [relevance_notes]
    custom_attributes:
      summary: string
      top_links: string[]
      relevance_notes: string
      worth_acting: boolean            # policy signal — referenced by escalate_when/auto_complete_when (§5.6)
    responses:
      - { id: file_insight, label: "File to Notion", outcome: execute }
      - { id: open_link,    label: "Open link",      outcome: guided }
      - { id: dismiss,      label: "Dismiss",        outcome: discard }
    execution:
      mode: automated
      capability: notion.insight.create
    policy:
      escalate_when: "worth_acting == true"
      auto_complete_when: "worth_acting == false"   # silently file low-signal digests
      confidence_threshold: 0.7
    priority: normal
    ttl: null

requires_capabilities:
  - notion.insight.create
  - url.open

delivery:
  channels: [inbox, telegram]
  quiet_hours: "22:00-07:00"

audit: true
timeout_ms: 60000
```

```typescript
// capabilities/newsletter-digest/index.ts
import type { RunContext, RunResult, DraftActionItem } from "@samaritan/sdk";
import { hash } from "@samaritan/sdk/util";

export async function run(context: RunContext): Promise<RunResult> {
  const email = context.inputs.email_message;
  const { summary, topLinks, relevanceNotes, worthActing, confidence } =
    await summarizeNewsletter(email, context.memory);

  const item: DraftActionItem = {
    capability_id: "newsletter-digest",
    type: "newsletter-digest-review",
    context: {
      what_happened: `Read "${email.subject}"`,
      source: { kind: "email", id: email.id, link: email.permalink },
      provenance: ["email.received", "newsletter-digest.run"],
      why_flagged: relevanceNotes,
      trigger_reason: worthActing ? "value" : "confidence",
      confidence,
      decision_needed: "File this as an insight?",
      decision_surface: "inbox",
      execution_surface: "notion",
      outcome_preview: `Creates an Insight row in Notion: "${summary.slice(0, 60)}..."`,
    },
    custom: { summary, top_links: topLinks, relevance_notes: relevanceNotes, worth_acting: worthActing },
    dedupe_key: hash(email.id),
  };

  return { action_items: [item], status: "ok", logs: [] };
}
```

## 5. Contracts & APIs

All endpoints are served from the single API server at `http://127.0.0.1:4173` (v0/v1, no auth — the trust boundary is "who can reach localhost on this machine"; see §9 for the tunnel-exposed case). JSON in, JSON out. Errors: `{ "error": { "code": string, "message": string } }` with standard HTTP status codes (200/202/400/404/409/500).

### 5.1 Action Center ingest API

```http
POST /api/actions
Content-Type: application/json

{
  "capability_id": "newsletter-digest",
  "items": [
    {
      "type": "newsletter-digest-review",
      "context": { "...": "ActionItemContext, see §4.2" },
      "custom": { "summary": "...", "top_links": ["..."], "relevance_notes": "high" },
      "dedupe_key": "sha256:..."
    }
  ]
}
```

```http
202 Accepted
{
  "accepted": [{ "id": "a1b2...", "dedupe_key": "sha256:...", "status": "pending" }],
  "rejected": []
}
```

Validation pipeline: look up the manifest by `capability_id` → find `type` in `manifest.emits[]` → validate `custom` against `custom_attributes` (zod schema built from the manifest at load time) → **upsert decision** on `(capability_id, dedupe_key)` (detailed below) → run Policy Engine `evaluate()` → auto_complete transitions straight to `approved` and triggers execution; escalate stays `pending` and fires Delivery per `manifest.delivery`.

**Upsert decision logic.** `(capability_id, dedupe_key)` is UNIQUE at the DB level (§4.4), so a repeat ingest never produces a silent duplicate — it resolves to exactly one of:

- **No existing match** — ordinary insert, `status: pending`.
- **Match found, not yet settled** (`status` is `pending`, `in_review`, `approved`, `awaiting_confirmation`, or `deferred` — the logical event has not run its course yet) — UPDATE the existing row's `context_json`/`custom_json`/`execution_json` with the new draft's values and reset review state (`in_review` rolls back to `pending`, since whatever Sandip was reviewing no longer matches the current content). This supersedes the stale draft outright and re-runs the Policy Engine against the refreshed content. An `action_item_events` row is still appended (`actor: "capability"`, `reason: "superseded_by_reingest"`, `payload_diff` = old → new `context`/`custom`) so the audit trail shows a draft was replaced rather than the update happening invisibly.
  - **`deferred` is the exception that stays put.** It supersedes in place like the rest, but the row stays `deferred` and keeps the `defer_until` it already had, and Delivery is not fired. A deferral is Sandip's decision about *when* he wants to look at something; a re-ingest only reports what the content is now. The two are orthogonal, so the content is refreshed and the window is held, and the wake shows what is true at wake time rather than a snapshot from before the snooze. Rolling it back to `pending` would let any capability that re-emits on every run silently cancel a snooze; treating it as settled and forking a fresh row leaves the snoozed row orphaned with its `defer_until` intact, so `resurface()` (§6) wakes it alongside its replacement and the Inbox shows the same thing twice. Policy still re-runs, so a refresh that now matches `auto_complete_when` executes without waiting for the window, which is the way through for something that has become urgent.
  - **`awaiting_confirmation` is the exception that is not touched at all.** No supersede, no fork: the row is left byte-identical and only the re-emission is recorded, as an `action_item_events` row with `from_status` equal to `to_status` (`actor: "capability"`, `reason: "reingest_held_awaiting_confirmation"`, `payload_diff` = old → new). By this point the OS has already dispatched. A draft exists in Gmail or a task in TickTick, `execution.payload` carries the `_guided_link`/`_guided_instructions` Sandip needs to finish it, and none of that can be un-issued. Superseding in place would overwrite `execution` and take the link with it, and since `POST /confirm` and `POST /reopen` both answer only `awaiting_confirmation`, the rollback to `pending` would leave the item with no way to close its own loop. Forking a fresh row instead mints a new item id, and the §10 idempotency key is derived from it, so the next approve would miss the registry's replay guard and dispatch a second time for real. Holding the status while refreshing the content is no better: the amber chip would then assert "we staged this" over a version that was never staged, and `POST /confirm` would record `executed` for work the OS never dispatched. So the newer content waits. `POST /reopen` ("Didn't do it") is how Sandip declares the handoff void, after which the row is `pending` and the next re-ingest supersedes it normally. Reopening also opens a new **dispatch generation**: the §10 idempotency key is `<item id>:<n>` where `n` counts prior `awaiting_confirmation → pending` events, so approving the revised content dispatches it for real instead of replaying the voided attempt. Keying on the item id alone would make the remedy silently useless, since the registry would replay the first attempt forever and the card would show the new content over instructions for the old.
- **Match found, already settled** (`status` is `executed`, `failed`, `rejected`, or `expired`) — that logical event already ran its course, so ingest must not mutate it. (`failed` counts: execution was attempted, so something external may already be half-committed and the attempt is worth keeping as its own row.) Its `dedupe_key` is rewritten with a `:superseded:<id>` suffix (freeing the unique slot) and a fresh row is INSERTed under the original `dedupe_key`, `status: pending` — **both statements run inside one SQLite transaction, so a crash between them can never leave a rewritten key with no replacement row** — going through the Policy Engine like any new item. This path is for genuine re-fires of the same occurrence (a retry, a corrected re-run) — capabilities whose dedupe key is expected to recur *by design* (e.g., a daily digest) should already scope the key to the occurrence, per §4.6's `hash("weekly-digest" + isoWeek)` pattern, so this branch rarely triggers for them.

Other Action Center endpoints:

```http
GET  /api/actions?status=pending&capability_id=&priority=&limit=50
GET  /api/actions/:id
POST /api/actions/:id/respond
     body: { "response_id": "file_insight", "edited_payload"?: {...}, "actor": "sandip" }
POST /api/actions/:id/confirm        # manual close-out for guided / assisted-external-commit items
     body: { "actor": "sandip", "note"?: "..." }
     — requires status === "awaiting_confirmation"; transitions -> executed; 409 otherwise
POST /api/actions/:id/reopen         # "Didn't do it" — un-confirm an item back into the Inbox
     body: { "actor": "sandip", "reason"?: "..." }
     — requires status === "awaiting_confirmation"; transitions -> pending; 409 otherwise
GET  /api/actions/:id/audit          # ActionItemEvent[] for this item
GET  /api/capabilities
POST /api/capabilities/reload        # re-walk capabilities/*, hot-reload manifests
GET  /api/capabilities/:id
GET  /api/routing
PUT  /api/routing/:action_type       # body: { provider, account, mode } — 409 if locked
POST /api/recall/query               # body: { question } -> RecallAnswer
GET  /healthz
```

### 5.2 Capability entrypoint

```typescript
type CapabilityEntrypoint = (context: RunContext) => Promise<RunResult>;

interface RunContext {
  capability_id: string;
  trigger: { mode: RunMode; firedAt: string; payload?: unknown };
  inputs: Record<string, unknown>;      // resolved from manifest.context.inputs
  memory: { recall?: (q: string) => Promise<RecallAnswer> };  // if manifest.context.memory includes "recall"
  emit: (items: DraftActionItem[]) => Promise<void>;          // bound samaritan.emit(), see §8
}

interface RunResult {
  action_items: DraftActionItem[];
  status: "ok" | "error";
  logs: string[];
}
```

### 5.3 Execution Registry interface

```typescript
interface ExecutionRequest {
  action_item_id: string;
  capability: string;             // execution-registry id, e.g. "notion.insight.create"
  mode: ExecutionMode;
  payload: Record<string, unknown>;
  /**
   * `<action item id>:<dispatch generation>`. The generation counts prior
   * `awaiting_confirmation -> pending` events on the item, so it is stable
   * across retries of one approval (the scope §10 asks for) and distinct after
   * a `POST /reopen`, which is Sandip declaring the previous handoff void. The
   * bare item id would be stable for the item's whole life, so once an approval
   * had staged, the registry would replay it forever and a revised version
   * could never be dispatched at all. See §5.1 branch 2a.
   */
  idempotency_key: string;
}

interface ExecutionResult {
  status: "succeeded" | "failed" | "staged";
  result?: Record<string, unknown>;   // e.g. { notion_row_id: "..." }
  guided_link?: string;               // populated for guided/assisted handoffs
  error?: string;
}

interface ExecutionAdapter {
  id: string;                         // "notion.insight.create"
  modes: ExecutionMode[];             // which modes this adapter implements
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
  verify?(): Promise<ConnectionStatus>;
}

interface ExecutionRegistry {
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
  register(adapter: ExecutionAdapter): void;
  capabilities(): ExecutionCapability[];
}
```

**Status mapping (execute → confirm).** The Action Center derives the action item's post-execute status from `ExecutionResult.status`: `"succeeded"` (an `automated` commit, or any adapter whose write *is* the full effect) transitions the item straight to `executed`. `"staged"` — `guided`'s deep link/instructions, or an `assisted` handoff like a Gmail draft that still needs Sandip to act outside Samaritan — transitions it to `awaiting_confirmation` instead; it only reaches `executed` once Sandip calls `POST /api/actions/:id/confirm` (§5.1). `"failed"` transitions it to `failed` per §10. This mapping is why `awaiting_confirmation` is the correct terminus for every `guided` item and for the subset of `assisted` items whose effect isn't actually committed until an external system (Gmail, Slack, WhatsApp) records a separate human action.

### 5.4 Routing resolver

```typescript
function resolve(actionType: string, opts?: { capabilityId?: string }): RoutingResolution;

interface RoutingResolution {
  provider: string;
  account: string;
  mode: ExecutionMode;
  locked: boolean;
  execution_capability_id: string;    // the concrete Execution Registry id to call
}
```

### 5.5 Recall API

```typescript
async function query(question: string, opts?: { maxCitations?: number }): Promise<RecallAnswer>;

interface RecallAnswer {
  answer: string;
  citations: {
    kind: "notion_row" | "obsidian_file" | "ticktick_task" | "audit_event" | "calendar_event";
    ref: string;         // row id or file path (+ optional #heading)
    excerpt?: string;
  }[];
  retrieval_path: "structured" | "semantic" | "hybrid";
}
```

```http
POST /api/recall/query
{ "question": "Why did we pick Vendor A over Vendor B for the export pipeline?" }

200 OK
{
  "answer": "Vendor A was chosen over Vendor B because of pricing volatility flagged in the June 30 vendor review, formalized in dec_482. [notion_row:dec_482] [obsidian_file:Meetings/2026-06-30-vendor-review.md#pricing]",
  "citations": [
    { "kind": "notion_row", "ref": "dec_482", "excerpt": "Chose Vendor A for export pipeline..." },
    { "kind": "obsidian_file", "ref": "Meetings/2026-06-30-vendor-review.md#pricing", "excerpt": "...pricing volatility on Vendor B's tier..." }
  ],
  "retrieval_path": "hybrid"
}
```

### 5.6 Policy Engine (internal)

```typescript
function evaluate(draft: DraftActionItem, policy: ActionItemTypeSpec["policy"]): PolicyDecision;

interface PolicyDecision {
  outcome: "auto_complete" | "escalate";
  reason: string;
  matched_rule: string;    // e.g. "hardcoded:payment.make" | "manifest:confidence_threshold" | "manifest:auto_complete_when"
}
```

**Predicate evaluation context.** `escalate_when` / `auto_complete_when` are expressions evaluated over a **flat, read-only variable map** built by merging the draft item's `context` fields (`confidence`, `trigger_reason`, `decision_surface`, …) with **all of its declared `custom` attributes**. Any signal a capability wants policy to key on — e.g. `worth_acting` in the newsletter example — **must therefore be a declared `custom_attribute`, set in `run()`**; a predicate can only reference variables actually persisted on the item. Evaluation uses a **sandboxed expression evaluator** (`expr-eval` or a jsonlogic-style parser) — never `eval`/`new Function` — limited to booleans, numbers, strings, and comparison/logical operators. Precedence: the hardcoded money-lock (§9) is checked first and cannot be overridden; then `escalate_when`; then `confidence_threshold` (escalate if `confidence` is below it); then `auto_complete_when`; default is **escalate** if nothing matches.

## 6. Runtime & daemon

**Process model.** One Node process (`dist/daemon.js`) hosts the Scheduler, Event Bus/listeners, Run Layer, Policy Engine, Action Center service + Action Store, Execution Registry, Routing resolver, Recall service, Delivery service, and the Fastify API/static server — all in-process, sharing one event loop. This is a deliberate monolith at single-user scale: no IPC, no network hops between internal components, one thing to supervise and to read logs from. Heavy async work (LLM calls for extraction/synthesis, embedding generation) is offloaded via `await` to external APIs or a WASM-based local model so it doesn't block the loop; if RAG indexing ever starts contending with request latency, it's a candidate to split into a worker process — not needed at current scale.

**Supervision — launchd (macOS, primary):**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.sandipdev.samaritan</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/sandipdev/Developer/samaritan/dist/daemon.js</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/sandipdev/Developer/samaritan</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/sandipdev/Library/Logs/samaritan/daemon.out.log</string>
  <key>StandardErrorPath</key><string>/Users/sandipdev/Library/Logs/samaritan/daemon.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SAMARITAN_CONFIG</key><string>/Users/sandipdev/.samaritan/config.yaml</string>
    <key>NODE_ENV</key><string>production</string>
  </dict>
</dict>
</plist>
```

Installed at `~/Library/LaunchAgents/com.sandipdev.samaritan.plist`, loaded with `launchctl load -w`. **pm2** (`pm2 start dist/daemon.js --name samaritan`) is the dev-loop alternative — faster iterate/restart during development, and `pm2 startup` can generate the launchd hook itself; if hosting ever moves to a Linux home server (PRD §13's hosting table), the equivalent is a `systemd` unit with `Restart=always`.

**Scheduler, event listeners, filesystem watch.** Scheduler ticks drive `trigger.mode: scheduled` capabilities (node-cron in v1; delegated to Claude scheduled-tasks in v0, see §3). Event listeners run as long-lived subscriptions/poll loops inside the same process: Fireflies and Slack via webhook routes registered on the same Fastify instance (`POST /webhooks/fireflies`, `POST /webhooks/slack`), Gmail/TickTick/iMessage via interval pollers (watermarked by last-seen id/timestamp so polls are incremental). Because a message can arrive via **both** a webhook and a poller, the Event Bus de-duplicates at the **source-event level**: every `SamaritanEvent` carries a stable source id (Gmail message id, Fireflies transcript id, or file path + mtime), and a short-lived seen-set (a persisted watermark) drops a second delivery of the same source id — so an overlapping webhook and poll fire the target capability only once. Filesystem watch uses `chokidar` on the Obsidian vault (`Inbox/`, and the full vault for Recall indexing) and `~/Developer/*/journal/**/*.md`, with `awaitWriteFinish` enabled to avoid reading partial writes; changes debounce into `journal.updated` / `note.created` events on the internal bus.

**Ports & network surface.** Single port (default `4173`, configurable via `config.yaml: server.port`) serves both `/api/*` and the static SPA — one origin, no CORS. Bound to `127.0.0.1` only; never `0.0.0.0`. Remote reach is Telegram (outbound only, no inbound port) plus an optional Tailscale/Cloudflare Tunnel in front of the same port for UI access (§9).

**macOS permissions (operational prerequisite).** Before first run, the process launchd/pm2 supervises (`node dist/daemon.js`) must be granted **Full Disk Access** in System Settings → Privacy & Security — required for the iMessage (`~/Library/Messages/chat.db`) and WhatsApp pollers in the Event Bus (§2.2) to read anything at all. This is a one-time manual grant against the daemon's own binary/launcher, not something the process can request or elevate itself at runtime. See §9 for the full detail, including the required boot-time check and error surfacing.

**Config & state locations:**

| What | Path |
|---|---|
| Non-secret config | `~/.samaritan/config.yaml` |
| Action Store (SQLite) | `~/.samaritan/samaritan.db` |
| Logs | `~/Library/Logs/samaritan/*.log` |
| Capabilities | `<repo>/capabilities/<id>/{manifest.yaml,index.ts}` |
| Secrets | macOS Keychain (service `samaritan`, account `<provider>:<account-id>`) — never in `config.yaml` |

`config.yaml` holds only non-secret settings: port, vault path, journal glob, default quiet hours, log level, embedding provider choice. Secrets are resolved at boot / first use via `keytar.getPassword("samaritan", "<provider>:<account>")` and are never written to the Action Store or logged.

## 7. Ask-Samaritan RAG pipeline

**Ingestion sources & cadence.**

| Source | Path into the system | Cadence |
|---|---|---|
| Obsidian vault | chokidar watch | near real-time, + nightly full reconcile |
| `~/Developer/*/journal` | chokidar watch | near real-time |
| Notion DBs (decisions/insights/people/projects) | write-through on execution (primary) + incremental poller, `last_edited_time` filter, exponential backoff (safety-net) — mirrored into `notion_*` tables | live on write-through; poller every 15 min |
| TickTick tasks | poller, mirrored into `ticktick_tasks` | every 15 min |
| Google Calendar | poller, mirrored into `calendar_events` | every 15 min |
| Action Store audit log | already local | live — no sync needed, first-class RAG source |
| Email / Slack / Fireflies transcripts | event-driven, at `email.received` / `slack.message` / `fireflies.transcript_ready` | on event |

**Notion sync — write-through primary, incremental poll as safety net.** A full-workspace poll on every cadence tick would burn through Notion's rate limits fast, so the poller is deliberately not the primary sync path:

- **Write-through (primary).** Samaritan itself creates or updates the large majority of rows in the Notion decisions/insights/people/projects DBs, via the same Execution Registry adapters (`notion.decision.create`, `notion.insight.create`, …) that commit to Notion in the first place. Each successful `execute()` against a Notion adapter optimistically upserts the identical row straight into the corresponding `notion_*` mirror table (§4.4) as part of that same request — Recall can see a decision the moment Samaritan files it, not up to 15 minutes later.
- **Incremental poll (reconciliation safety-net).** Every 15 minutes, a poller queries each Notion DB filtered on `last_edited_time` greater than that database's own last-synced cursor (persisted per-DB, never a global timestamp or a full-database read) and upserts only the changed pages. This exists to catch what write-through can't — edits Sandip makes directly in Notion's UI, or rows written by any other client. On a Notion API error (429 rate-limit or 5xx) the poller backs off exponentially (base 1s, cap ~5 min) and resumes from the same unmoved cursor on the next attempt; a failed poll never advances the cursor and never falls back to a full re-scan.

Both paths upsert on the mirror table's primary key (the Notion page id), so a write-through insert followed by the poller re-observing the same edit is a no-op, not a duplicate.

**Chunking.** Markdown-aware: split by heading (H1/H2) first, then by paragraph within an oversized section; target 500-800 tokens per chunk with ~15% overlap; retain frontmatter (date, tags) and heading path as chunk metadata (`source_path`, `heading`). Transcripts: grouped by speaker turn into ~800-token windows, retaining speaker labels and timestamps. Emails/Slack threads: one message (or a short merged thread) per chunk when under budget, else chunked like markdown.

**Embeddings.** Default: a local model run in-process via `@xenova/transformers` (pure JS/WASM, e.g. `all-MiniLM-L6-v2`) — no raw text leaves the machine, matching the local-first/privacy stance in §9. Opt-in upgrade: a cloud embedding API (OpenAI `text-embedding-3-small` or Voyage `voyage-3-lite`) gated behind an explicit `embeddings.provider` setting Sandip sets consciously — never the silent default. Stored as `float32` BLOBs in `recall_chunks.embedding`, indexed by `sqlite-vec` for cosine-similarity kNN.

**Hybrid retrieval — `query(question)`:**

1. **Classify** the question — rule-based keyword match first (who/status/what-did-we-decide → `factual_lookup`; why/how-come → `explanatory`), LLM fallback for ambiguous phrasing; `both` triggers the two paths below in parallel.
2. **Structured path** (factual_lookup/both) — match against the mirrored SQL tables (`notion_decisions`, `notion_insights`, `ticktick_tasks`, `action_items`, `calendar_events`) via a small set of parameterized query templates keyed by detected intent + named entities. (v1 candidate: constrained NL-to-SQL over an allowlisted read-only view; v0 sticks to templates — safer, no injection surface.)
3. **Semantic path** (explanatory/both) — embed the question with the same model used for indexing; kNN top-20 over `recall_chunks` via sqlite-vec; BM25 keyword search over the same candidates via `recall_chunks_fts`; fuse the two rankings with Reciprocal Rank Fusion; keep the top ~8 after fusion.
4. **Synthesis** — feed the structured rows and top semantic chunks (each tagged with its citation ref) to an LLM with an explicit instruction: answer only from the provided context, cite every claim with the given ref format, say so plainly if the answer isn't in context.
5. **Citation validation** — verify every ref the model used actually exists in the retrieved set; strip or flag any unsupported citation before returning. This is the guardrail that keeps `recall` trustworthy.
6. Return `{ answer, citations[], retrieval_path }` (§5.5).

Because every action item and completed decision carries `provenance` (§4.2 — "the path it travelled"), the audit log lets Recall trace *why* something happened, not just *what* — e.g., "why Vendor A" resolves through `dec_482`'s provenance chain back to the meeting that produced it.

## 8. Auto-plug-in mechanism

**Template.** `npx samaritan new-capability <id>` scaffolds:

```
capabilities/<id>/
  manifest.yaml    # stub with TODOs, valid trigger/emits skeleton
  index.ts         # stub run() already wired to context.emit()
```

**`samaritan.emit()` SDK** — the one function every capability calls, whether it runs in-process (invoked by the Run Layer, which binds `emit` into `RunContext`, a direct function call) or out-of-process (a Claude scheduled task shelling out to `node dist/cli/run-capability.js <id>`, where the same SDK function instead POSTs to `http://127.0.0.1:4173/api/actions`):

```typescript
// @samaritan/sdk
export async function emit(
  items: DraftActionItem[]
): Promise<{
  accepted: { id: string; dedupe_key: string }[];
  rejected: { item: DraftActionItem; errors: string[] }[];
}>;
```

**Ingest pipeline** (what runs on every `emit()`/`POST /api/actions` call): resolve manifest by `capability_id` → resolve `type` within `manifest.emits[]` → validate `custom` against `custom_attributes` (zod, generated from the manifest at load time) → upsert on `(capability_id, dedupe_key)` → `Policy Engine.evaluate()` → auto_complete calls the Execution Registry immediately; escalate sets `pending` and fires Delivery per `manifest.delivery` → append an `action_item_events` row (`actor: "capability"`).

**Scheduler-sync adapter** — reconciles capabilities that still fire via Claude's own scheduled-task infrastructure rather than the in-process scheduler. **This is push-based, not poll-based** — the daemon never queries Claude's scheduler (Claude's internal scheduled-task state isn't reachable from an external Node process; `mcp__scheduled-tasks__*` tooling only exists inside a Claude session). Instead, a Claude-owned scheduled task registers *itself*: the CLI it shells out to (`samaritan emit …`, §3) attaches a `source: { kind: "claude_scheduled_task", task_ref, capability_id }` field to its `POST /api/actions` payload. On first seeing that source, the Action Center upserts a `triggers` row with `claude_scheduled_task_id` set — so the Dashboard shows it as a first-class trigger even though Claude's infra, not node-cron, actually fires it. Liveness is inferred purely from received pushes (a row that hasn't pushed within its expected interval is greyed as stale), never from asking Claude. **Ownership rule:** if a `triggers` row has a non-null `claude_scheduled_task_id`, the in-process scheduler must skip it — Claude owns firing until a capability author explicitly migrates it (adds a `cron` field to the manifest and removes/retags the Claude task). This cutover is always manual and per-capability, never automatic, to guarantee nothing double-fires.

## 9. Security & privacy

- **Secrets** — OAuth tokens/API keys live only in the **macOS Keychain** (`keytar`, service `samaritan`), never in `config.yaml` or a `.env` file. The daemon resolves them into memory at boot/first-use, never logs them, never persists them into the Action Store.
- **Local-first** — the Action Store, vector index, Obsidian vault, and journals never leave the machine by default. The API/UI server binds `127.0.0.1` only — no LAN or public exposure unless a tunnel is explicitly configured.
- **macOS Full Disk Access (operational prerequisite, referenced from §6)** — the process launchd/pm2 supervises (`node dist/daemon.js`) must be granted **Full Disk Access** in System Settings → Privacy & Security before first run. Without it, the iMessage (`~/Library/Messages/chat.db`) and WhatsApp pollers in the Event Bus cannot read anything and fail *silently* with `EPERM`. Two safeguards make this non-silent: (1) **boot-time check** — on startup, before listeners begin, the daemon attempts a read of `chat.db`; on `EPERM` it does **not** crash but marks the `imessage`/`whatsapp` `connections` rows `status: "error", reason: "full_disk_access_required"`, disables those pollers, and surfaces an actionable card in Settings/Dashboard plus a one-time Telegram alert with the exact grant steps; the rest of the daemon runs normally. (2) The grant is a **manual, one-time** action against the daemon's own binary/launcher — the process cannot request or elevate it at runtime — so it is documented in the install runbook, not automated. Re-checking on each boot means the error clears automatically once access is granted.
- **Remote access — two sanctioned paths only:** (1) **Telegram**, outbound long-poll/webhook via Telegram's own infrastructure, no inbound port opened; (2) **Tailscale** (preferred — private mesh, device-authenticated, zero-config) or **Cloudflare Tunnel** (authenticated tunnel) to reach the local web UI off-LAN. Either way the origin stays `127.0.0.1`-bound; the tunnel adds authentication in front rather than opening a port. When a tunnel is active, `PUT`/`POST` endpoints additionally require `Authorization: Bearer <token>` (token from Keychain, checked by a Fastify `onRequest` hook) — localhost-only traffic stays unauthenticated since the OS-level access boundary already covers it.
- **Money-never-auto enforcement — three independent layers, all must agree:**
  1. **Policy Engine** — `payment.make` (and any action type matching a hardcoded high-risk allowlist) always evaluates to `escalate`, regardless of confidence, and this cannot be overridden by a capability's own `auto_complete_when`.
  2. **Routing Config** — the `payment.make` entry ships `locked: true`; `PUT /api/routing/:action_type` returns `409` on any attempt to change its mode.
  3. **Execution Registry** — `register()` throws at load time if an adapter declares `modes: ["automated"]` for a payment-namespaced action type; no such adapter is ever allowed to exist.
- **Audit** — `action_item_events` is append-only (no `UPDATE`/`DELETE` in application code against that table; enforced by code review and, as a backstop, a SQLite trigger that rejects updates/deletes on it). Every ingest, policy decision, human response, and execution attempt writes a row — this table is what `recall` queries to answer "why did this happen."
- **Least privilege** — each integration is connected with the minimum OAuth scopes its declared `requires_capabilities` actually need (e.g., Gmail connected read+compose, not full send, unless a capability explicitly requires `email.send`).
- **Sensitive content** — transcripts and emails can contain confidential material. Local embeddings are the default specifically so that content never reaches a third-party API without an explicit opt-in (§7); the same default-local stance applies to any LLM extraction step a capability performs.

## 10. Failure handling

- **Execution failure** — adapter throws or returns `{status:"failed"}` → `executions` row updated, `action_items.status = "failed"`, `action_item_events` appended, Delivery notifies with the error and a retry affordance. Retry re-invokes `execute()` with the **same** `idempotency_key`, so a provider call that actually succeeded server-side but timed out client-side isn't double-executed — adapters are required to check-or-create by that key (e.g., the Notion adapter checks for an existing row tagged with the key before creating another). After retries are exhausted (default 3, backoff), fall back to **guided**: surface the same payload as a deep link/copy-ready text so the action still completes by hand.
- **Capability error** — `run()` throws or exceeds `manifest.timeout_ms` (default 60s) → the Run Layer's `try/catch` + `Promise.race` isolates it; `capabilities.last_run_status = "error"`, surfaced in Dashboard/Observability; the daemon keeps running and every other capability is unaffected. Repeated failures back off exponentially before the next attempt; after 5 consecutive failures the capability is auto-disabled (`enabled: false`) with a Telegram alert, requiring explicit re-enable.
- **Missing integration** — at registration time the Capability Registry checks every id in `requires_capabilities` against the Execution Registry; anything backed by a missing/unregistered capability is auto-degraded to `guided` for that action-item type (overriding the manifest's declared mode), with a warning surfaced in Settings/Connections. Once the integration connects, the next manifest reload restores the declared mode — no manifest edit required.
- **Daemon restart** — launchd `KeepAlive`/pm2 `autorestart` brings the process back. On boot, before the scheduler/listeners start, a reconciliation pass: (1) any `approved` item with no matching `executions` row (crashed mid-handoff) is resubmitted using its stored `idempotency_key`; (2) any `executions` row stuck `pending` past a staleness threshold (5 min) is treated as failed-and-retried, not silently dropped; (3) scheduled triggers missed while down are logged as `missed_trigger` audit events and skipped by default — a per-manifest `catch_up: run_once` opt-in exists for triggers where a missed run genuinely matters (e.g., a daily digest).
- **Idempotency / no-lost-items** — every action item carries a capability-computed `dedupe_key`, unique per `(capability_id, dedupe_key)` at the DB level, so re-emitting the same logical event upserts instead of duplicating. Every execution attempt carries an `idempotency_key` threaded to the adapter. The SQLite write on ingest happens synchronously inside the `POST /api/actions` request, before the `202` response — an item is durably persisted before the emitting capability considers the call "done"; nothing is held only in memory.

## 11. Sequence flows

**(a) Scheduled capability → action item → automated execute → confirm.** *(example: `weekly-digest`, the scheduled synthesis job behind the existing `weekly` skill.)*

1. Scheduler fires at Sunday 20:00 per `weekly-digest`'s `trigger: { mode: scheduled, cron: "0 20 * * 0" }`.
2. Run Layer resolves the trigger to `weekly-digest`, builds `RunContext` (injects `hourly_log.week`, `notion.decisions.week`, `notion.insights.week`), calls `run(context)`.
3. The capability reads the past 7 days of Hourly Log + this week's Notion rows, synthesizes a digest, and returns a `DraftActionItem` of type `weekly-digest-ready` with `execution: { mode: automated, capability: "obsidian.note.create" }` and `custom.markdown` set to the digest body.
4. The capability calls `context.emit([item])` → ingest validates `custom` against the manifest, computes `dedupe_key = hash("weekly-digest" + isoWeek)`, upserts into `action_items` (`status: pending`).
5. Policy Engine `evaluate()` — this type declares `auto_complete_when: "true"` (a digest write is low-risk and reversible) → `outcome: auto_complete`.
6. Action Center, seeing `auto_complete`, transitions `pending → approved` (`actor: "policy"`) without surfacing it in the Inbox, and calls Routing Resolver: `resolve("journal.capture")` → `{ provider: "obsidian", account: "vault", mode: "automated" }`.
7. Execution Registry `execute()` dispatches to the `obsidian.note.create` adapter with `idempotency_key = action_item.id`; the adapter writes `Areas/Weekly/2026-W29.md` to the vault and returns `{ status: "succeeded", result: { path: "Areas/Weekly/2026-W29.md" } }`.
8. `executions` row recorded; `action_items.status = "executed"`; `action_item_events` gets two rows (`policy` auto-complete, `system` executed) — the audit trail closes.
9. Delivery pushes a condensed Telegram message ("Weekly digest ready: 5 decisions, 3 insights, 2 stuck items — [open]") per `manifest.delivery.channels`. `recall` can now cite this file path for "what did we do this week."

**(b) Inbound email event → escalate → assisted send.** *(example: `email-triage`, matching the routing table's `email.send → assisted`.)*

1. A Gmail poller/webhook detects a new message; the Event Bus emits `email.received` with the message id/thread.
2. Run Layer matches capabilities whose `trigger.on` includes `email.received` (`email-triage`), builds `RunContext` with the message payload + injected context (`user.interests`, `open_threads`), calls `run(context)`.
3. The capability classifies the email as needing a reply, drafts one, and returns a `DraftActionItem` of type `email-reply-review` with `execution: { mode: assisted, capability: "gmail.draft.create" }`, `custom.draft_body`, `confidence: 0.74`, `trigger_reason: "action_type"` (sending email always escalates regardless of confidence).
4. `emit()` → ingest validates, upserts (`dedupe_key` = message id).
5. Policy Engine `evaluate()` — this type declares `escalate_when: "true"` (email send is never auto-completed) → `outcome: escalate`.
6. Action Center transitions `pending → in_review`, renders the item as a `form` (editable draft body) in the Inbox; Delivery pushes a summary card to Telegram since `manifest.delivery.channels` includes it.
7. Sandip opens the item (Inbox or Telegram deep link), edits a line, and calls `POST /api/actions/:id/respond` with `{ response_id: "send_reply", edited_payload: { draft_body: "..." } }` — an edit-then-approve response.
8. Action Center records the diff (`action_item_events`, `actor: "sandip"`, `payload_diff`), transitions `in_review → approved`, calls `resolve("email.send")` → `{ provider: "gmail", account: "sandip@work", mode: "assisted" }`.
9. Execution Registry dispatches to `gmail.draft.create` (assisted mode never sends outright) with the edited body; the adapter creates/updates the Gmail draft and returns `{ status: "staged", guided_link: "https://mail.google.com/mail/u/0/#drafts/..." }`.
10. Per §5.3, the `"staged"` result transitions the item to `awaiting_confirmation` — **not** `executed` — because the assisted contract is "agent stages, Sandip commits" and the commit hasn't happened yet. Delivery sends the deep link to Telegram; Sandip taps it and hits Gmail's own Send.
11. Sandip then clicks **"Mark as done"** in the UI (or a later Gmail webhook confirms the send), calling `POST /api/actions/:id/confirm` → the item transitions `awaiting_confirmation → executed`, and the audit trail records both the OS-side staging and the confirmed send — closing the loop for `recall`.

**(c) Ask-Samaritan query → hybrid retrieval → cited answer.**

1. Sandip asks a question (web UI, Telegram, or CLI) — e.g., "Why did we pick Vendor A over Vendor B for the export pipeline?" → `POST /api/recall/query { question }`.
2. The Recall service classifies the question → `explanatory` (a "why"), with named entities ("Vendor A/B") worth a structured lookup too.
3. **Structured sub-query** — looks up `notion_decisions` for rows matching "Vendor A"/"export pipeline" → finds `dec_482` ("Chose Vendor A for export pipeline," reversibility: hard, 2026-06-30).
4. **Semantic sub-query** — embeds the question, runs sqlite-vec kNN (top-20) over `recall_chunks` + FTS5 keyword search over the same table, fuses via Reciprocal Rank Fusion, keeps the top 8 — surfaces a paragraph from `Meetings/2026-06-30-vendor-review.md` and two email chunks discussing tradeoffs.
5. Both result sets are merged, each candidate tagged with its citation ref (`notion_row:dec_482`, `obsidian_file:Meetings/2026-06-30-vendor-review.md#pricing`, …).
6. **Synthesis** — an LLM call receives the question plus the tagged context, instructed to answer only from it and cite every claim with the given refs.
7. **Citation validation** — every ref the model used is checked against the retrieved set; unverifiable citations are stripped or the claim is flagged as unsupported rather than returned as fact.
8. Response returned: `{ answer, citations: [...], retrieval_path: "hybrid" }` (§5.5's example is this exact query).
9. The client renders the answer with clickable citations — `notion_row` opens the Notion page, `obsidian_file` opens the vault note at the cited heading.

## 12. Build order / phasing

### v0 — prove the anchor (Action Center + wrap/meeting review gate)

1. Repo scaffold: `capabilities/`, `src/{types,store,run-layer,policy,action-center,execution,routing,recall,delivery,api}`, TypeScript + zod + fastify + better-sqlite3 wired; `~/.samaritan/config.yaml` loader.
2. Shared types + zod schemas for `CapabilityManifest`, `ActionItem`, `RoutingEntry`, `ExecutionCapability` (§4) — everything else depends on this contract.
3. Action Store migration: run the DDL in §4.4 against `~/.samaritan/samaritan.db`, with a minimal migration runner.
4. Capability Registry & loader: read `capabilities/*/manifest.yaml`, validate with zod, register into `capabilities`/`triggers`; `GET /api/capabilities`.
5. Action Store CRUD module: `createActionItem`, `getActionItem`, `listActionItems`, `transition(id, toStatus, actor, reason)` — the only code path allowed to mutate `action_items`, always paired with an `action_item_events` insert.
6. Action Center ingest: `POST /api/actions` (validate → Policy Engine v0 → store), per §5.1.
7. Policy Engine v0: a **sandboxed** predicate evaluator (`expr-eval` or jsonlogic-style — never `eval`/`new Function`) over the flat variable map defined in §5.6 (item `context` + declared `custom` attributes), for `escalate_when`/`auto_complete_when`/`confidence_threshold` — not a full expression language yet.
8. Execution Registry v0: adapters for `notion.*.create`, `ticktick.task.create` (automated) + one generic `guided` fallback adapter (renders payload as copy-ready text/deep link); `execute()` dispatch with idempotency-key handling.
9. Routing resolver v0: load `routing.yaml` (§4.3) into `routing_config`; implement `resolve()`.
10. **The anchor**: rewire `wrap` and `meeting` to call `samaritan.emit()` instead of writing to Notion/TickTick directly. Their extracted items become `DraftActionItem`s (`wrap-item-review` / `meeting-item-review`) with `execution.mode: automated` but `policy.escalate_when: "true"` — always reviewed. Success criterion (from PRD.md): no `wrap`/`meeting` row hits Notion without an explicit approve or edit-then-approve.
11. Minimal web UI: Inbox list + card/form renderer + approve/reject/edit/defer actions, served by Fastify as a static SPA, talking to `/api/actions*`.
12. Delivery v0: Telegram push on new `pending` items (reuse the existing Telegram/Claude-Channels integration) + a deep link back to the local UI.
13. Audit: `GET /api/actions/:id/audit`; append-only enforcement (§9).
14. No daemon yet — capabilities fire via existing Claude scheduled-tasks / manual slash commands, shelling out to `node dist/cli/run-capability.js <id>`.
15. Smoke test: run `wrap` end-to-end — item lands in the Inbox, approve it, confirm the Notion row is created with the right payload, confirm the audit trail is complete.

### v1 — generalize to a platform

16. Daemon skeleton (`dist/daemon.js`) combining scheduler + listeners + API server in one process; launchd plist + `~/Library/Logs/samaritan/`.
17. `node-cron` scheduler replacing ad hoc CLI invocation for `scheduled`-mode capabilities; scheduler-sync adapter (§8) for anything still tagged `sam:` in Claude's scheduled tasks.
18. Event Bus + listeners: Fireflies webhook, Gmail poller, Slack Events API, chokidar filesystem watch on journals + vault.
19. Policy Engine v1: full confidence/reversibility/value rules, per-type overrides, hardcoded money-lock (§9).
20. Execution Registry v1: `assisted` adapters (Gmail draft, Calendar tentative-hold); connection status surfaced in Settings.
21. Onboard new capabilities via the `new-capability` scaffolder: newsletter-digest, calendar-from-screenshot, email-triage, job-search.
22. Recall v1: sqlite-vec + chunker + hybrid retrieval pipeline (§7), replacing the current flat "Notion-then-Obsidian" search.
23. Triage in the Action Center: priority/deadline sorting, batch-approve for similar low-risk items, `ttl`-based auto-expiry.
24. Routing UI in Settings (Connections + Routing tables, editable, respecting `locked`).

### Backlog

Earn-autonomy feedback loop (auto-raising thresholds from approval history); remote/VPS hosting; multi-user/delegation; advanced digesting; multi-surface parity. Unchanged from PRD.md §10 — no new technical dependencies identified for these beyond what v1 already builds.
