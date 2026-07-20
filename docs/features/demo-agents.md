# Demo-ready Samaritan: agents that post to the Inbox

Feature branch: `claude/what-next-89afb8`

Goal: a Samaritan that can be demoed cold. Three beats.

1. Register an agent.
2. The agent posts to the Inbox.
3. Sandip acts on it and the effect lands.

This doc answers the three questions the work depends on, records what the
specs already settle, and lists the build chunks.

---

## The blocking finding: there is no Run Layer

`src/run-layer/` does not exist. Neither does `src/cli/run-capability.ts`, even
though `package.json` has a `run-capability` script pointing at it. Both
`capabilities/wrap` and `capabilities/meeting` declare `entrypoint: index.ts`
and neither folder has an `index.ts`. The wrap manifest says so in a comment:
"There is no TypeScript entrypoint yet. [...] nothing loads it in v0."

So today an agent is a Claude skill that shells out to `samaritan emit`. That
works, and it is how the anchor was proven. But it means:

- **Nothing can run an agent from inside Samaritan.** No "run now", no schedule,
  no telemetry, no last-run status.
- **"Adding an agent" has no artifact to point at.** You would be editing a
  Claude skill in a different repo tree, not dropping a folder into
  `capabilities/`.
- **The Dashboard's agent grid is a facade.** It already says so in a comment:
  last-run is approximated because "no run-layer telemetry exists yet".

All three demo beats need the Run Layer. It is TECH-SPEC §5.2, and the build
order puts it in v0 implicitly (step 14 shells out to
`dist/cli/run-capability.js`) but no step ever builds it. That is the gap.

---

## Q3: how agents are added, discovered and plugged in

Settled by TECH-SPEC §8 and §12 step 4. The contract, and what exists:

| Stage | Mechanism | Status |
|---|---|---|
| Add | `samaritan new-capability <id>` scaffolds `manifest.yaml` + `index.ts` | not built |
| Discover | `CapabilityRegistry.reload()` walks `capabilities/*/manifest.yaml`, validates with zod, persists to `capabilities` + `triggers` | **built** |
| Reload without restart | `POST /api/capabilities/reload` | **built** |
| Validate | zod on the manifest, predicate compile-check against declared attributes, execution-target cross-check against the Execution Registry | **built** |
| Degrade | missing execution target drops the type to `guided` (§10), restored on next reload | **built** |
| Run | Run Layer imports the entrypoint, calls `run(ctx)` with a bound `emit` | not built |
| Emit | `samaritan.emit()`, direct call in-process or `POST /api/actions` out-of-process | SDK built, in-process binding not |
| Ingest | validate against manifest, upsert on `(capability_id, dedupe_key)`, policy, audit, delivery | **built** |

The discovery half is done and is genuinely pluggable: nothing in
`src/registry/index.ts` knows the name of any capability. The execution half is
missing entirely.

**Design rule carried into this work:** adding an agent stays "drop a folder in
`capabilities/` and reload". No registration list, no import statement to edit,
no code outside the folder. If a chunk needs a central edit to add an agent,
that chunk is wrong.

---

## Q1: which agents to build

Four new, joining `wrap` and `meeting`. Chosen so the roster covers the whole
platform surface rather than four variations on one shape. Every one runs
offline with no OAuth, because a demo that needs a network round-trip is a demo
that fails on stage.

| Agent | Trigger | Layout | Policy | Execution | What it proves |
|---|---|---|---|---|---|
| `newsletter-digest` | event `email.received` | card | `worth_acting` splits escalate vs auto-complete | `notion.insight.create`, automated | Policy deciding, not a human. Same item type, two outcomes. This is TECH-SPEC §4.6's worked example built as specified. |
| `email-triage` | event `email.received` | form | always escalate | `gmail.draft.create`, assisted | The full assisted loop: edit the draft, approve, land in `awaiting_confirmation`, confirm. Also demos §10 auto-degrade, since no Gmail adapter exists. |
| `weekly-digest` | scheduled `0 20 * * 0` | document | `auto_complete_when: "true"` | `obsidian.note.create`, automated | Automation that never touches the Inbox. Fills "handled automatically today". TECH-SPEC §11(a) end to end. |
| `subscription-watch` | scheduled daily | card | always escalate | action type `payment.make`, locked | The money lock. Three independent layers refuse to automate it (§9), and the Routing table shows it locked. |

Existing `wrap` and `meeting` stay as they are: LLM extraction via Claude
skills, unconditional escalation. They are the anchor and the roster's proof
that Samaritan does not care whether the thing posting to it is a local
function or a language model.

**Honesty note.** The four new agents are deterministic. They read a fixture,
apply rules, and emit. The LLM seam is marked in each `run()` but not wired,
because a demo agent that needs an API key is a liability. `wrap` and `meeting`
are the LLM-driven half of the roster and they already work. Do not describe
the new four as "AI agents" in the demo; describe them as capabilities, which
is what the spec calls them and what they are.

---

## Q2: a full Inbox on day 1

`samaritan seed` runs each demo capability against its fixture, **through the
real ingest path**. Not hand-written rows.

That constraint is the whole point. If the seed inserts into `action_items`
directly then the policy decisions are fake, the audit trails are fabricated,
and the first thing a demo viewer clicks (the audit trail) is a lie. Going
through `POST /api/actions` means every seeded item has a true provenance
chain, a real policy decision with a real matched rule, and a real dedupe key.

Two passes:

1. **Emit.** Run each capability with its fixture input. Policy decides. Some
   items land pending, some auto-complete, one is money-locked.
2. **Act.** Drive a few real responses through the API so the other views are
   not empty: approve one (Completed), defer one (Deferred), approve an
   assisted one and leave it in `awaiting_confirmation` (the confirm loop
   mid-flight).

Everything the seed produces is reproducible and reversible: `--reset` clears
the demo capabilities' items and re-runs. Timestamps are honest, which means
everything is created now rather than backdated. A backdated `created_at` would
be the same lie as a hand-written row, one level down.

---

## Build chunks

Each chunk is small, leaves the tree green, and merges to `main` before the
next starts.

**Phase A — Run Layer**

- A1 `src/run-layer/context.ts` — `RunContext` / `RunResult` per §5.2, with
  `emit` bound to the in-process Action Center.
- A2 `src/run-layer/index.ts` — `runCapability()`: dynamic import, timeout
  race, error isolation, `last_run_at` / `last_run_status` telemetry (§10).
- A3 `src/cli/run-capability.ts` + `POST /api/capabilities/:id/run`.
- A4 Tests for A1-A3.

**Phase B — Scaffolder**

- B1 `src/cli/new-capability.ts` per §8.
- B2 Tests.

**Phase C — Agents** (one chunk each: manifest + entrypoint + fixture)

- C1 `newsletter-digest`
- C2 `email-triage`
- C3 `weekly-digest`
- C4 `subscription-watch`
- C5 Roster tests: every agent loads, runs, and lands the policy outcome it
  claims.

**Phase D — Seed**

- D1 `src/cli/seed.ts` emit pass.
- D2 Seed act pass.
- D3 Tests.

**Phase E — UI**

- E1 Dashboard agent grid on real telemetry, plus "Run now".
- E2 Settings: add-an-agent affordance and load problems.

**Phase F — Demo**

- F1 `docs/DEMO.md` runbook.

---

## Decisions

**Agents are deterministic in v0.** The LLM seam is marked, not wired. A demo
that depends on a network call and an API key has a failure mode on stage that
no amount of testing removes.

**The seed drives the real API.** No direct writes to `action_items`. The audit
trail is the product; faking it to demo it would be self-defeating.

**No backdated timestamps.** The Inbox looks like it was filled just now,
because it was.

**`payment.make` gets an agent.** The money lock is three layers of code that
nothing currently exercises end to end. `subscription-watch` makes it visible,
and a guardrail nobody can see is a guardrail nobody trusts.
