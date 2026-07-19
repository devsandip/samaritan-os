---
title: Samaritan Action Center — PRD & Technical Spec
subtitle: A pluggable Human-in-the-Loop platform for a personal agentic OS
owner: Sandip Dev
status: Draft v0.1
date: 2026-07-19
---

# Samaritan Action Center — PRD & Technical Spec

## 1. Summary

Samaritan is Sandip's personal agentic OS: a set of skills and scheduled agents that capture thoughts, process meetings, file structured knowledge, and answer questions across Obsidian, Notion, TickTick, Fireflies, and Telegram. Today those agents mostly run in isolation and either act autonomously or dump work back on Sandip ad hoc.

This document specifies the **Action Center** — a universal **Human-in-the-Loop (HITL)** layer and a **pluggable capability platform**. It is the single place where *anything that needs Sandip* lands: agent-proposed actions awaiting his approval, rendered with the right surface for their type, routed by confidence and blast-radius, and executed (or handed off) once he decides.

The central design principle — and the reason this is a *platform*, not a feature:

> **The OS provides the horizontals (running, remembering, surfacing, executing, delivering). A capability provides only its vertical domain logic and declares its integration points via a thick manifest. Adding the 20th capability costs almost nothing, because every shared service already exists.**

## 2. Goals & Non-Goals

**Goals**
- A **universal action inbox**: every capability routes "needs Sandip" moments through one contract and one surface.
- **Pluggable capabilities**: drop in a new agent/skill/scheduled task; the OS discovers, validates, and wires it into all shared services with no core code changes.
- A **thick manifest contract** that fully declares a capability's triggers, context needs, emitted action-item types (+ render schemas), execution needs, and policy.
- **Explicit execution modes** (guided / assisted / automated) so the OS automates what's safe and cheap, stages what's risky, and guides what it can't touch.
- **Separation of concerns** across four layers: Run → Policy → Action Center → Execution.

**Non-Goals (v0/v1)**
- The **earn-autonomy feedback loop** (auto-raising thresholds from approval history) — designed for, but deferred to backlog.
- **Remote/server hosting** (VPS) — runs on laptop for now; access via Telegram.
- **Multi-user / delegation** — single user (Sandip); the routing layer is designed *as if* multi-user but ships single-user.
- Replacing any existing skill's internal logic — the Action Center wraps, it does not rewrite.

## 3. Current State — what's already built

**Skills (BUILT)** — the `capture → structure → recall` arc:

| Skill | What it does | Writes to | Inference? |
|---|---|---|---|
| `capture` | Dump a raw thought, no routing | Obsidian Inbox | None (explicit) |
| `log` | 1-3 sentence "what just happened" | Obsidian Hourly Log | None (explicit) |
| `decision` | File a Decision row (rationale, reversibility) | Notion | Low |
| `file` | Explicitly write a typed row (decision/insight/person/project) | Notion | None (explicit) |
| `meeting` | Process a transcript → note + rows + tasks | Obsidian + Notion + TickTick | **High (extraction)** |
| `wrap` | Scan a session → file decisions/insights/people/tasks | Notion + TickTick + Obsidian | **High (extraction)** |
| `recall` | Answer a question, grounded in row IDs / file paths | reads Notion + Obsidian | N/A (read) |

**Stack integrations (BUILT):** Obsidian vault (Inbox, Hourly Log, notes), Notion DBs (decisions / insights / people / projects), TickTick (tasks), Fireflies (transcripts), Telegram via Claude Channels (capture surface + notifications).

**Scheduled jobs (BUILT, informal):** ~7 scheduled tasks running today (e.g., weekly synthesis). Not yet unified under a formal run layer.

**HITL seed (BUILT — the prototype to generalize):** the OpenClaw screenshot tool already scores extraction confidence per field and *only acts when confident, else asks the user*. This is a working confidence-gated intervention for one capability — the Action Center generalizes it into a platform primitive.

**The gap:** there is no unified inbox, no capability contract, and no formal Run / Policy / Execution layers. `meeting` and `wrap` — the two highest-inference skills — write to Notion with no review gate, which is exactly where an agent mis-extracts, hallucinates a task, or files a garbage row. They are the natural **anchor use case** for v0.

## 4. Proposed Architecture

Four layers, plus cross-cutting services, joined by **three contracts**.

```
        ┌─────────────────── PLUGGABLE CAPABILITIES ───────────────────┐
        │  wrap · meeting · newsletter · calendar · email · job-search  │
        │            (each ships a thick MANIFEST)                      │
        └───────────────┬───────────────────────────────┬──────────────┘
                        │  [Trigger contract]           │ [Action-Item contract]
                        ▼                               ▼
   ┌───────────┐   ┌──────────────┐   ┌───────────────────────┐   ┌───────────────┐
   │ RUN LAYER │──▶│ POLICY ENGINE│──▶│    ACTION CENTER      │──▶│ EXECUTION     │
   │ schedule/ │   │ auto vs.     │   │  inbox · render ·     │   │ REGISTRY      │
   │ event/    │   │ escalate     │   │  responses · lifecycle│   │ [Exec contract]│
   │ manual    │   │ (conf/risk)  │   │                       │   │ guided/assist/│
   └───────────┘   └──────────────┘   └──────────┬────────────┘   │ automated     │
                        ▲                          │ decision       └──────┬────────┘
   Cross-cutting:       │                          ▼                       │
   Context/Memory ──────┘                  ┌──────────────┐                ▼
   Capability Registry                     │    SANDIP    │        Systems of record:
   Delivery (Telegram)                     │ (via inbox / │        Notion · TickTick ·
   Observability/Audit                     │  Telegram)   │        Obsidian · Gmail ·
                                           └──────────────┘        Calendar · ...
```

**Data flow (one action's life):**
`trigger` (run layer fires the capability) → capability runs with injected context → produces a result → **policy** decides *auto-complete* vs *escalate* → if escalate, emit a standardized **action item** (carrying its execution mode) → **Action Center** renders it and routes to Sandip → Sandip decides → **execution** runs (guided / assisted / automated) → confirm back → audit.

**The three contracts (the lingua franca that makes pluggability work):**
1. **Trigger contract** — how the run layer knows when to fire a capability.
2. **Action-Item contract** — the standardized shape every capability emits; the reason the Action Center can be universal (it never needs to know who produced an item).
3. **Execution/Capability contract** — how a capability requests an action from the shared execution registry.

## 5. Core Concepts

### 5.1 Capability (the plugin)
A unit of domain logic — a scheduled task, an agent, or a skill — that plugs into the OS by shipping a **manifest** and a standard **entrypoint**. It brings the *what* (read the newsletter, extract decisions); it never re-implements the *how* (scheduling, inbox, memory, execution, delivery).

### 5.2 Run modes (when a capability fires)
- **scheduled** — cron/polling (daily job scan, morning brief, hourly email sweep).
- **event** — fires on a trigger (email received, meeting ends → transcript ready, message arrives).
- **manual** — invoked by command (`/wrap`, `/recall`, `/capture`, `/meeting`).
- **continuous** — persistent watch; in practice implemented as frequent polling / event subscription.

### 5.3 Policy (does the result need Sandip?)
Distinct from the run layer. A rule set that decides **auto-complete vs. escalate**, based on:
- **confidence** (model/extraction confidence below threshold → escalate),
- **reversibility / blast-radius** (irreversible or high-impact → escalate even if confident),
- **value / amount** (e.g., above a threshold → escalate),
- **action type** (some types always escalate — sending an email, making a payment).

### 5.4 Action Item (the unit in the inbox)
Every capability emits action items conforming to a shared schema: **shared attributes** (OS contract) + **custom attributes** (capability-declared) + **render schema** + **allowed responses** + **execution mode**. See §7.

### 5.5 Execution modes (how far the agent takes the action)
- **guided** — agent produces content + tells Sandip where to act; *Sandip* executes entirely (e.g., a WhatsApp message: text + deep link). Zero integration.
- **assisted / staged** — agent preps and stages; Sandip does the final commit (e.g., composes an email → Gmail draft; Sandip reviews + sends). Partial integration.
- **automated** — agent completes on approval (e.g., file a Notion row, create a TickTick task). Full integration + low risk.

Mode is decided by three factors: **capability** (does an integration exist / is it worth building?), **risk/reversibility** (should it, even if it can?), **effort vs. payoff**. The human is the **executor of last resort**.

### 5.6 Capability (execution) registry
An explicit catalogue of what the OS *can actually do* — `notion.insight.create ✓`, `ticktick.task.create ✓`, `gmail.draft ✓`, `gmail.send ⚠️ (assisted only)`, `calendar.move ✓`, `whatsapp.send ✗ (guided only)`. Each action type maps to a registry capability + a chosen mode. Adding an integration **promotes** an action guided → assisted → automated. That promotion path *is* the roadmap.

## 6. The Manifest Contract (thick)

Decision: **thick manifest** — capabilities declare explicitly rather than relying on OS inference. More authoring effort per capability, but robust, predictable, and self-documenting. Required core is small; the rest is richly optional with sane defaults.

```yaml
# ─────────── IDENTITY (required) ───────────
id: newsletter-digest                 # unique, stable
name: Newsletter Digest
description: Reads configured newsletters, summarizes, flags items worth acting on
version: 0.1.0
owner: sandip
enabled: true

# ─────────── RUN / TRIGGER (required) ───────────
trigger:
  mode: event                         # scheduled | event | manual | continuous
  # scheduled → cron: "0 7 * * *"
  on: [email.received]                # event types (event mode)
  filter: { from_in: ["@newsletters"] }
  # manual → command: "/newsletter"

# ─────────── CONTEXT (optional) ───────────
context:
  requires: [user.interests, projects.active]   # what the OS injects
  inputs:   [email.message]                      # payload consumed
  memory:   [recall]                             # may query recall

# ─────────── EMITTED ACTION-ITEM TYPES (required) ───────────
emits:
  - type: newsletter-digest-review
    render:                            # thick: how Action Center displays it
      layout: card                     # card | form | document | diff
      primary: summary
      secondary: top_links
      badges: [relevance_notes]
    custom_attributes:                 # declared schema for the type
      summary: string
      top_links: string[]
      relevance_notes: string
    responses:                         # the allowed decisions
      - { id: file_insight, label: "File to Notion", outcome: "execute" }
      - { id: open_link,    label: "Open link",      outcome: "guided" }
      - { id: dismiss,      label: "Dismiss",        outcome: "discard" }
    execution:
      mode: automated                  # guided | assisted | automated
      capability: notion.insight.create
    policy:                            # per-type escalation posture (overridable)
      escalate_when: "worth_acting == true"
      auto_complete_when: "worth_acting == false"     # silently file digest
      confidence_threshold: 0.7
    priority: normal                   # low | normal | high | urgent
    ttl: null                          # optional expiry (e.g., "24h")

# ─────────── EXECUTION NEEDS (required) ───────────
requires_capabilities:
  - notion.insight.create              # missing → degrade to guided
  - url.open

# ─────────── DELIVERY (optional) ───────────
delivery:
  channels: [inbox, telegram]
  quiet_hours: "22:00-07:00"

# ─────────── OBSERVABILITY (optional) ───────────
audit: true
```

**Standard entrypoint** the OS calls (imperative side of the contract):

```
run(context) -> {
  action_items:      ActionItem[],       # conforming to §7
  execution_requests: ExecutionRequest[],# for auto-completed actions
  status:            "ok" | "error",
  logs:              string[]
}
```

A capability that ships a valid manifest + this entrypoint is a first-class citizen.

## 7. Action Item schema (runtime instance)

```yaml
action_item:
  id: uuid
  capability_id: newsletter-digest
  type: newsletter-digest-review
  status: pending      # pending → in_review → approved|rejected|deferred → executed|failed|expired
  created_at: <ts>

  # ── SHARED ATTRIBUTES (the OS contract — same for every item) ──
  context:
    what_happened:   "Read Lenny's Newsletter, 2026-07-18 issue"
    source:          { kind: email, id: msg_123, link: "https://…" }
    provenance:      ["email.received", "newsletter-digest.run", "policy.escalate"]  # path travelled
    why_flagged:     "Contains a job-market piece relevant to your search"
    trigger_reason:  value             # confidence | policy | value | risk
    confidence:      0.82
    decision_needed: "File this as an insight?"
    decision_surface:  inbox           # where SANDIP reviews (review surface)
    execution_surface: notion          # where the ACTION lands (execution surface)
    outcome_preview: "Creates an Insight row in Notion: '…'"

  # ── CUSTOM ATTRIBUTES (declared by the capability) ──
  custom:
    summary: "…"
    top_links: ["…", "…"]
    relevance_notes: "high"

  # ── RESPONSE + EXECUTION ──
  responses: [file_insight, open_link, dismiss]
  execution: { mode: automated, capability: notion.insight.create, payload: {…} }
  priority: normal
  deadline: null
  expires_at: null
```

Note the two distinct surfaces: **decision_surface** (where Sandip reviews) vs **execution_surface** (where the action lands). Provenance captures "the path it travelled" so `recall` can answer "why did this happen?" later.

## 8. Action Center — behaviour & lifecycle

**Lifecycle states:** `pending → in_review → (approved | rejected | deferred) → (executed | failed | expired)`.

- **Ingest** — receives action items from any capability via the contract; validates against the type's declared schema.
- **Triage** — sorts by priority/urgency/deadline; groups by capability/type; supports batch actions for similar low-risk items (mitigates the OpenClaw "flood" failure mode).
- **Render** — draws the surface from the item's `render` schema (card / form / document / diff) — the platform's answer to "different use cases need different interfaces."
- **Decide** — Sandip picks an allowed response (approve / reject / edit-then-approve / defer / ask-more-info). **Edit-then-approve** lets him modify the proposed payload (fix the draft, change the amount) before it commits.
- **Ask-more-info** — routes to `recall`: "why did we choose Tableau over QuickSight?" → answer pulled from Notion decisions / email / capture dump, grounded in IDs.
- **Execute** — on approve, dispatch to the execution registry in the item's mode; **guided** returns a deep link, **assisted** stages (e.g., Gmail draft) and returns a handoff, **automated** commits.
- **Confirm / fail** — record execution result; on failure (email bounces, payment declines, API error), set `failed`, notify, and offer retry/guided fallback.
- **Expire** — items past `ttl` auto-resolve per the type's rule (e.g., a passed meeting-invite auto-declines or drops).
- **Audit** — every state transition + decision logged for `recall` and trust.

## 9. Pluggability — how a capability gets plugged in

1. **Drop it in a known location** — `capabilities/<id>/` containing `manifest.yaml` + the entrypoint. Discovery by convention (description-first / progressive disclosure, matching the skills pattern).
2. **Validate on install** — the OS checks the manifest against the contract schema; rejects malformed manifests with clear errors.
3. **Register** — wires triggers into the Run Layer, registers emitted action-item types + render schemas with the Action Center, and checks `requires_capabilities` against the Execution Registry (missing capability → auto-degrade that action to **guided** and warn).
4. **Lifecycle** — enable/disable, version, declare dependencies; hot-reload on manifest change.

No core code changes. **Discover → validate → register → wire.** That is the whole definition of "plugged in."

## 10. What needs to be built

| Component | Status | Notes |
|---|---|---|
| Skills: capture/log/decision/file/meeting/wrap/recall | **Built** | Become the first "capabilities"; wrap manifests around them |
| Stack integrations (Obsidian/Notion/TickTick/Fireflies/Telegram) | **Built** | Become entries in the Execution Registry |
| ~7 scheduled jobs | **Built (informal)** | Migrate under the formal Run Layer |
| OpenClaw confidence gate | **Built (prototype)** | Generalize into the Policy Engine |
| **Action Center** (inbox, render, lifecycle, responses) | **NEW** | Core of v0 |
| **Action-Item contract + validator** | **NEW** | The lingua franca |
| **Capability Registry + manifest loader** | **NEW** | Discover/validate/register |
| **Run Layer** (unified scheduler/event/manual) | **Partial** | Formalize the existing jobs |
| **Policy Engine** (auto vs escalate) | **NEW** | Generalize OpenClaw's gate |
| **Execution Registry + modes** (guided/assisted/automated) | **NEW** | Integrations exist; formalize as registry |
| **Delivery** (Telegram digest, quiet hours) | **Partial** | Telegram exists; add digest/routing |
| **Recall-in-inbox** ("ask more info") | **Partial** | recall exists; wire into items |
| Earn-autonomy loop | **Backlog** | Deferred (see Non-Goals) |
| Remote hosting (VPS) | **Backlog** | Laptop for now |

### Phasing

- **v0 (MVP) — prove the anchor.** Action Center + Action-Item contract + manifest loader (thin slice) + `wrap` and `meeting` as the first two producers, with a **review gate before any Notion/TickTick write**. Modes: automated (Notion/TickTick) + guided fallback. Delivery via inbox + Telegram. Success: no `wrap`/`meeting` row hits Notion without Sandip's approve/edit.
- **v1 — generalize to a platform.** Policy Engine (confidence/risk/value); Execution Registry with **assisted** mode (Gmail drafts); new capabilities (newsletter, calendar-from-screenshot, email-triage, job-search); render schemas per type; triage (priority/expiry/batching); recall-in-inbox.
- **Backlog.** Earn-autonomy loop; advanced digesting; remote hosting; multi-surface parity.

## 11. Metrics (light for v0; full set with earn-autonomy later)

- **Efficiency:** escalation rate (want it *down* over time without losing quality), median decision latency, items auto-completed vs escalated.
- **Quality/risk:** edit rate (how often Sandip changes the proposal), **reject rate**, and the scary one — **false negatives** (things auto-committed that Sandip later corrects). Never optimize escalation rate alone; balance it against false negatives.
- **Volume:** queue depth, batch-approval usage, digest open-through.

## 12. Open questions

- Manifest format: YAML file vs. frontmatter in a `skill.md` (lean: standalone `manifest.yaml` for clarity, co-located with the skill).
- Policy expression language: declarative predicates vs. small embedded expressions (`escalate_when: "amount > 100000"`). Lean: start declarative, add expressions where needed.
- Do `capture`/`log`/`file` (zero-inference) skip the Action Center entirely (auto-commit), or always leave a lightweight audit trail? Lean: auto-commit, audit-only.
- One inbox vs. per-domain lanes (work / personal / job-search / coding) as a view over one store. Lean: one store, filterable lanes.

---

## 13. Runtime & Deployment

**Local-first by default.** Samaritan reads email, messages, bills, and the dev journals in `~/Developer/*/journal` — data that should not sit on someone else's cloud, and filesystem access only works where the files are. The UI is a local web app the daemon serves on `localhost:PORT`.

**It requires a daemon** — a persistent background process running: the **scheduler** (fires scheduled capabilities on cron), **event listeners** (email/Slack/Fireflies webhooks + a filesystem watch on journals), the **Run → Policy → Action Center** services + the action store, the **local web UI**, and **notification push** (Telegram). Managed by **launchd** (macOS) / **systemd** (Linux) / **pm2** for auto-start and auto-restart.

**Hosting options (recommendation: local-first on an always-on machine):**

| Option | 24/7 | Sees local journals | Data stays home | Effort |
|---|---|---|---|---|
| Laptop | No (only when open) | Yes | Yes | Lowest |
| **Always-on Mac mini / home server (recommended)** | Yes | Yes | Yes | Low |
| Cloud VPS | Yes | Only if vault synced | No (tokens on server) | Highest |

Reach it from your phone via **Telegram** (message it; it runs where the files are) + a private tunnel (**Tailscale / Cloudflare Tunnel**) to open the UI remotely. A lean **v0 shortcut**: lean on Claude's built-in **scheduled-tasks** for the cron part so the scheduler isn't built day one; the daemon becomes mandatory once event-driven triggers and always-on notifications are needed.

## 14. Integrations & Routing

Two concerns, cleanly separated so capabilities never hardcode an account.

**Connections (the execution registry — what the OS *can* do):** OAuth-connected apps with live status — Gmail, Google Calendar, Slack, TickTick, Notion, Obsidian (local), Fireflies, iMessage (local), Telegram, WhatsApp. Reconnection surfaces in Settings and on the Dashboard agent panel (e.g., `whatsapp-triage: auth expired`).

**Routing / defaults (which app, account, and mode for each action):** a config mapping each **abstract action type** → provider + account + default execution mode. Capabilities declare abstract needs (`requires: [email.send]`); the routing config **resolves** them to a concrete provider/account/mode. Change the default in one place, every capability follows.

| Action | Provider | Account/target | Default mode |
|---|---|---|---|
| `message.work.send` | Slack | Acme workspace | Automated |
| `message.personal.send` | iMessage | local · Telegram fallback | Guided |
| `email.send` | Gmail | sandip@work | Assisted |
| `task.create` | TickTick | Work list | Automated |
| `event.schedule` | Google Calendar | work | Assisted |
| `note.file` / `insight.file` | Notion | PM OS workspace | Automated |
| `journal.capture` | Obsidian | vault | Automated |
| `payment.make` | — none — | manual only | Guided (locked by policy) |

Policy can **lock** a mode regardless of connected apps — e.g., `payment.make` is Guided-only; money never moves automatically. See `settings` view in `samaritan-app.html`.

**Auto-plugging-in scheduled tasks (push, not pull):** a capability plugs in by emitting to the **Action Center ingest endpoint** (`POST /api/actions`) via a shared `samaritan.emit()` tool. A `/new-capability` scaffolder stamps tasks from the template pre-wired to emit. For tasks you create *in Claude*: the Claude scheduled-task script itself **POSTs to the ingest webhook when it fires** — Claude's internal scheduler state isn't externally queryable by the daemon, so we **push, not poll**. Opt-in via the template/tag; no magic detection — a convention plus an ingest contract.

## 15. Ask-Samaritan (RAG)

`recall`, generalized into a queryable layer over the whole OS.

**Sources** — structured: Notion DBs (decisions/insights/people/projects), TickTick, the **Action Center audit log** (Completed/Deferred), calendar. Unstructured: Obsidian vault (inbox, hourly log, notes, WBRs), emails, Slack threads, transcripts.

**Two-tier retrieval:** classify the question → for "what did we decide / who owns / status of," **query Notion directly** (exact, cited by row ID); for "*why* did we…," **semantic/vector search** over the prose. Synthesize with **citations to row IDs / file paths**.

**Provenance is the enabler:** because every action item and completed decision carries "the path it travelled" (source → meeting → Notion row), Ask-Samaritan can trace "why Vendor A" through the chain. The audit log is a first-class RAG source.

**Index:** a **local vector store** (LanceDB / Chroma / sqlite-vec) over the vault + synced structured sources, or an existing memory framework (Claude Mem / Mem Search) for the semantic layer. Local, for the same privacy reasons as §13.

---

## Appendix A — Mapping to UiPath (why this demonstrates platform thinking)

This architecture is the same primitive as an enterprise HITL platform, applied to a personal OS. Useful as a concrete "I think in platforms" artifact:

| Samaritan | UiPath equivalent |
|---|---|
| Run Layer (schedule/event/manual) | Orchestrator (scheduling, triggers, queues) |
| Policy Engine (auto vs escalate) | Guardrails / business-rule gates in a Maestro process |
| Action Center (inbox, render, lifecycle) | Action Center (human tasks, Action Apps) |
| Action-Item contract | The task/work-item schema a workflow emits |
| Execution modes (guided/assisted/automated) | "Controlled agency" — human vs. bot vs. agent executes the step |
| Capability manifest / registry | Connectors / activities / MCP tool registration |
| Execution surface vs review surface | Where the human acts (invoice screen / email / Slack) vs. what they decide |

The point Shiva was probing — *configurable review surfaces across many use cases, on a platform, not a point tool* — is exactly what the **thick manifest + render schema + shared Action-Item contract** deliver.
