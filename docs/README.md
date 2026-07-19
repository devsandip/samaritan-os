# Samaritan — Personal Agentic OS

Samaritan is Sandip's local-first personal agentic OS. Its centerpiece is the **Action Center**: a universal Human-in-the-Loop (HITL) layer and a **pluggable capability platform** — "one inbox for everything that needs Sandip."

**The one idea that everything hangs on:** the OS provides the *horizontals* (running agents, deciding what needs you, surfacing it, executing it, delivering it); a **capability** provides only its *vertical* domain logic plus a thick manifest. Any agent plugs in via three contracts (Trigger, Action-Item, Execution) — so adding the 20th capability costs almost nothing. The policy engine auto-handles what's safe/reversible and escalates the rest; each escalation renders on the surface its type needs; and it executes in the right mode (**guided / assisted / automated**). Money never moves automatically. Everything is auditable and queryable ("Ask Samaritan").

---

## What's in this folder — suggested reading order

| # | File | What it is | Open it for |
|---|------|-----------|-------------|
| 1 | **PRFAQ.md** | Amazon-style press release + FAQ | The pitch and the "why" in 5 minutes — start here |
| 2 | **PRD.md** | Product requirements + architecture | What we're building and why; the 4-layer architecture, runtime, integrations, RAG |
| 3 | **TECH-REQUIREMENTS.md** | Enumerated, testable requirements | The FR/NFR checklist with acceptance criteria |
| 4 | **TECH-SPEC.md** | Implementation blueprint | How it's built — components, schemas, APIs, daemon, RAG, security, sequence flows, build order. **Claude Code builds from this.** |
| 5 | **UI-SPEC.md** | UI & interaction spec | Design tokens, the render-schema system, per-view specs, states, components |
| 6 | **architecture.html** | Architecture diagram (browser) | See the layered architecture + contracts at a glance |
| 7 | **samaritan-app.html** | Full app mockup (browser) | Click through Dashboard · Inbox · Deferred · Completed · Settings |
| 8 | **action-center-mockup.html** | Detailed Inbox mockup (browser) | The four schema-driven detail surfaces (WBR, email, PRD, meetings) |
| 9 | **Samaritan-ideation.md** | Raw origin notes | Where this started — kept for provenance |

*(Open the three `.html` files in a browser — they're self-contained, no build step.)*

---

## Status

Draft **v0.x**. The suite is design-complete and internally consistent; the next step is implementation.

- **v0 anchor:** `meeting` + `wrap` extractions get a review gate before anything is filed to Notion/TickTick. This ships the Action Center + review loop before the full daemon exists (v0 can lean on Claude's scheduled-tasks).
- **v1:** the local daemon (scheduler + event listeners + services + web UI + Telegram), the policy engine, more capabilities, assisted mode (Gmail drafts), the routing registry, Ask-Samaritan (RAG).
- **Backlog:** earn-autonomy loop (auto-tuning escalation thresholds from approval history), remote hosting, multi-user.
- Full build order is in **TECH-SPEC.md** (final section).

## Current state (already built, pre-Action-Center)

7 skills — `capture`, `log`, `decision`, `file`, `meeting`, `wrap`, `recall` — on Obsidian + Notion + TickTick + Fireflies + Telegram, plus ~7 scheduled jobs. The OpenClaw confidence-gate is the working HITL prototype this platform generalizes.

## Runtime, in one line

A local-first **daemon** (launchd/pm2) runs the scheduler, event listeners, the Action Center services, and a `127.0.0.1` web UI; reachable from your phone via Telegram + a private tunnel (Tailscale). Your data stays on your machine.
