# Samaritan: Buy-vs-Build Evaluation of Agent Runtime and HITL Action Center Tooling

## 1. Executive Summary
- **Verdict — Runtime: BUY/ADOPT.** The scheduler + durable run-loop + secrets + "pause→ask→resume" mechanic is genuinely commodity; you should not hand-roll it. Your hypothesis is correct here.
- **Verdict — Action Center: BUILD (the logic), SCAFFOLD (the surface).** No off-the-shelf tool ships your typed/policy/audited HITL as a product. The base inbox surface can be scaffolded, but the six differentiators are whitespace. Your hypothesis is correct here too, with one refinement: the buy/build line falls *inside* the inbox, not around it.
- The best self-hostable runtime for a single-user, laptop-hosted, event+cron, durable, Claude-based system is **Windmill** (AGPL-3.0, self-hostable, cron + webhooks + suspend/approve + secrets) or **Trigger.dev** (Apache-2.0, waitpoint tokens) — with **Temporal** (MIT) or **Restate** (BSL 1.1) as the "serious durability" upgrade path.
- **OpenClaw** (the user's working name) is real: it is the MIT-licensed personal-agent gateway created by Peter Steinberger, formerly Clawdbot/Moltbot, now under the OpenClaw Foundation with Steinberger at OpenAI. It fits local-first + Telegram + skills + cron better than anything else, but its guardrail is generic allow/deny, so adopting it means rebuilding your Action Center inside its framework.
- **"Anthropic Managed Agents"** is real: **Claude Managed Agents**, a hosted runtime that added cron "scheduled deployments" and a credential "vault" in public beta on June 9, 2026. It is hosted/beta-gated and Claude-only — it violates local-first, so it's a comparison point, not the pick.
- **HumanLayer, LangChain Agent Inbox + LangGraph `interrupt()`, Temporal/Inngest/Trigger.dev/Windmill approvals** are all *approval primitives or generic inboxes* — allow/deny/edit/respond on a tool call. None do per-item render schemas, a policy engine on confidence+reversibility+blast-radius, a structural money-lock, an autonomy gradient, or earn-autonomy.
- **UiPath Action Center** (your reference target) is the closest prior art to out-design: a real typed task inbox (Form, Document Validation, App tasks) with audit, SLAs, and — via **Maestro** (GA April 2025) + **Agent Memory** — escalation routing and memory reuse. But it is proprietary, cloud/Orchestrator-coupled, and escalation is *manually modeled* (prompt/BPMN), not a confidence/risk policy engine. Your policy engine + earn-autonomy is genuinely differentiated even versus UiPath.
- **Camunda 8** (Zeebe/Tasklist user tasks) is the strongest open prior-art for typed human tasks + audit, but it is BPMN-centric, JVM-heavy, and since v8.6 (October 8, 2024) all Self-Managed components are under the source-available Camunda License 1.0 requiring a paid production license — too heavy for a single-user laptop, but worth studying for user-task typing and audit design.
- **Net:** adopt a runtime, scaffold the inbox surface from LangChain Agent Inbox or a Retool/internal-tool builder, and spend your build budget on the policy engine, money-lock, render-schema contract, autonomy gradient, audit substrate, and earn-autonomy. That is the defensible portfolio artifact.

## 2. Category 1 — Agent Runtime Inventory

| Tool | What it is | Self-host? | License | GitHub maturity | Scheduling / durability | Fit for Samaritan |
|---|---|---|---|---|---|---|
| **Claude Managed Agents** ("Anthropic Managed Agents") | Hosted Claude agent runtime: sandbox, state persistence, cron "scheduled deployments," credential vault | No (hosted) | Proprietary | N/A | Cron + durable sessions, hosted | Fastest demo; violates local-first; beta-gated, Claude-only |
| **Claude Agent SDK** | Runs the agent loop *in your own process* | Yes (your process) | Proprietary SDK (free to use) | Maintained by Anthropic | You own scheduling/durability | Good agent-loop library; not a runtime by itself |
| **OpenClaw** | Self-hosted personal-agent gateway; messaging channels, skills, cron "heartbeat" | Yes (local-first) | MIT | ~350k+ stars; hyper-active; weekly releases; ~1,142 security advisories in 5 months | Cron + event; process-level durability | Best local-first fit; guardrail is generic allow/deny |
| **LangGraph** (OSS lib) | Graph/state-machine agent framework; `interrupt()` + checkpointer for HITL | Yes | MIT | ~24,800 stars; 1.0 GA Oct 2025, v1.0.10 Mar 2026; ~34–38.8M monthly PyPI downloads | Durable via checkpointer; you host | Strong HITL primitive; needs a host/scheduler around it |
| **LangGraph Platform** | Hosted/self-hostable deploy plane for LangGraph (cron, persistence, API) | Hosted + self-host tiers | Proprietary (platform) | N/A | Cron + durable | Heavier; team-oriented; overkill single-user |
| **Temporal** | Durable-execution engine; workflows survive crashes; signals = human wait | Yes | MIT (server + SDKs) | Very mature, widely deployed | Best-in-class durability; signals/queries for HITL | Powerful but operationally heavy for a laptop |
| **Inngest** (+ AgentKit) | Event-driven durable steps; `step.waitForEvent` for HITL; AgentKit multi-agent (TS) | Yes (self-host) | Apache-2.0 (core) / AgentKit MIT | Active | Event + cron + durable steps | Great TS fit; cloud-optimized but self-hostable |
| **Trigger.dev** | Open-source background-jobs/durable runner; waitpoint tokens for HITL | Yes | Apache-2.0 | Active; v4 GA | Cron + durable + waitpoints | Strong self-host + HITL primitive; good candidate |
| **Restate** | Durable-execution engine, single binary; awakeables = human wait | Yes | BSL 1.1 (source-available) | Active, smaller community | Durable; awakeables/timers survive crashes | Lightweight single-binary; BSL license caveat |
| **Cloudflare Agents + Workflows** | Durable Objects agents + Workflows durable execution; alarms/cron; `waitForEvent` | Hosted (edge) | Proprietary platform (SDKs open) | Active; Workflows GA | Cron + durable + human gates | Not local-first; edge-hosted |
| **n8n** | Visual workflow automation; 400+ integrations; AI nodes | Yes | Sustainable Use License (fair-code, source-available) | ~100k+ stars; very active | Cron + webhook + wait | License restricts commercial resale; not OSI-OSS |
| **Windmill** | Developer platform: scripts→workflows, cron, webhooks, suspend/approve, secrets, app builder | Yes | AGPL-3.0 (CE) | Active; Rust core | Cron + webhook + suspend/approve; per-workspace secrets | **Top self-host runtime pick** for you |
| **Activepieces** | No-code automation; MCP/AI | Yes | MIT | Active | Cron + webhook | Truly OSS (MIT); lighter than n8n |
| **Kestra** | Declarative (YAML) orchestrator; event + schedule | Yes | Apache-2.0 (OSS) + EE | Active | Cron + event + durable | Data-pipeline oriented; heavier |
| **Dify / Flowise** | LLM app builders (RAG/agent visual) | Yes | Dify: open-core w/ restrictions; Flowise: Apache-2.0 | Active | Limited durable scheduling | App builders, not run layers |
| **Letta** (ex-MemGPT) | Stateful agent server w/ tiered memory | Yes | Apache-2.0 | ~16–24k stars | Server, not a scheduler | Memory framework, not a runtime |
| **Mastra** | TS agent framework (workflows, memory, tools) | Yes | Apache-2.0 (confirm on repo) | ~19k stars; active | Workflows; you host | Good TS agent layer; pair with a runner |
| **CrewAI** | Role-based multi-agent | Yes | MIT | ~45,400 stars at v1.10.1 (Mar 2026); 12M+ daily agent executions | No durable scheduler | Orchestration, not run layer |
| **Microsoft Agent Framework** | AutoGen+Semantic Kernel successor; workflows, checkpointing, HITL | Yes | MIT | RC/GA target ~Q1 2026 | Checkpointing + HITL | .NET/Python; enterprise; newish |
| **LlamaIndex Workflows** | Event-driven workflow lib for agents | Yes | MIT | Active | Event steps; you host | Library, not a runtime |
| **Prefect** | Python orchestration; durable via `pydantic-ai` integration | Yes | Apache-2.0 | Mature | Cron + event | Data-ops flavored; viable |

**Short notes:**
- **OpenClaw** is the single best *local-first* match on paper: it is a long-running Node gateway on your own machine, connects Telegram/WhatsApp/etc., runs skills, and has a proactive cron "heartbeat." It is MIT-licensed and moved to the OpenClaw Foundation after Steinberger joined OpenAI (Feb 2026). Caveats: it is moving extraordinarily fast (weekly releases; a very high security-advisory rate reported — ~1,142 advisories in its first five months, ~16.6/day), so it is *immature/volatile* as a dependency, and its built-in HITL is a generic approval/guardrail model, not your typed Action Center.
- **Windmill** is the pragmatic self-host runtime: cron schedules, webhook triggers, suspend/approve steps (with forms on Cloud/EE tiers), encrypted per-workspace secrets, and it benchmarks as a fast engine (Rust core). AGPL-3.0 is real copyleft — fine for a personal/portfolio project you self-host, but note the obligation if you ever distribute a modified networked service.
- **Trigger.dev** (Apache-2.0) and **Inngest** (Apache-2.0 core) are the best *code-native durable* options with first-class human-wait primitives (waitpoint tokens / `waitForEvent`).
- **Temporal** (MIT) and **Restate** (BSL 1.1) are the "graduate to serious durability" tier — signals/awakeables let a workflow wait for human approval indefinitely and survive restarts — but both add operational weight that a no-ops laptop deployment may not want.
- **Claude Managed Agents** deletes exactly the plumbing you want to buy (cron + vault + sandbox), but is hosted and Claude-only, so it fails local-first.

## 3. Category 2 — HITL Inbox / Approval Surface Inventory

| Tool | Real inbox or just a primitive? | Typed items vs allow/deny | Edit-before-approve? | Audit trail? | Routing/policy/escalation? | Multi-channel | Self-host / license |
|---|---|---|---|---|---|---|---|
| **HumanLayer** | Primitive/SDK (+ evolving IDE) | Function-call approval; generic | Approve/deny (edit limited) | Basic | Contact channels; no policy engine | Slack, email | OSS SDK Apache-2.0; ~11k stars; superseded by CodeLayer IDE |
| **LangChain Agent Inbox + LangGraph `interrupt()`** | Real (minimal) inbox UX over interrupts | Action + args; `allow_ignore/respond/edit/accept` | Yes (edit) | Via checkpointer state | No policy; manual in graph | Web (inbox); Slack via add-ons | MIT; the best OSS *scaffold* |
| **UiPath Action Center** (reference target) | Real enterprise task inbox | Typed: Form, Document Validation, App tasks | Yes (validate/edit) | Yes (comprehensive audit) | SLAs, assignment rules; escalation via Maestro; Agent Memory reuse | Web; Orchestrator | Proprietary; cloud/Orchestrator-coupled |
| **Camunda 8 (Zeebe user tasks + Tasklist)** | Real human-task inbox | Typed via BPMN forms | Yes | Yes (process history) | BPMN gateways, DMN rules, escalation modeled | Web; APIs | Camunda License 1.0 (source-available); JVM-heavy |
| **Flowable / jBPM** | Real BPM human-task engines | Typed forms | Yes | Yes | BPMN escalation | Web | Flowable: Apache-2.0/EE; jBPM: Apache-2.0 |
| **Temporal / Inngest / Trigger.dev / Windmill / Prefect / n8n / Activepieces** | Primitives (wait/approve) | Generic approve/reject/resume | Some (Windmill forms; edit varies) | Execution history | Manual in workflow | Email/Slack/UI varies | See Category 1 licenses |
| **AG-UI protocol + CopilotKit** | Protocol + frontend stack | HITL approvals, generative UI, typed via your tools | Yes | No (transport) | No policy | Web, Slack, Teams | MIT (CopilotKit); AG-UI open |
| **Retool / Appsmith / Budibase / ToolJet** | Internal-tool builders (fast custom inbox) | Whatever you model (typed) | Yes | If you build it | If you build it | Web (+ integrations) | Retool proprietary; Appsmith Apache-2.0; Budibase GPL-3.0; ToolJet AGPL-3.0 |
| **Relay.app / Lindy / Gumloop** | Commercial automation w/ approval gates | Generic approval steps | Limited | Vendor-side | Rule-based approvals | Web/Slack/email | Proprietary SaaS; not self-host |

**Short notes:**
- **LangChain Agent Inbox** is the closest thing to a ready-made *surface* to scaffold from: it renders `interrupt()` actions with `action`/`args`/`description`, supports accept/edit/respond/ignore, and stores state in the LangGraph checkpointer. But it is a thin inbox, not a policy/audit product — you would build your typed render schemas, policy engine, and audit on top.
- **HumanLayer** is the most-cited "HITL for agents" name, but it is fundamentally an *approval API* (`require_approval`, `human_as_tool`) across Slack/email, and its own SDK docs now state it "is being superseded by CodeLayer," a "post-IDE IDE" for orchestrating coding agents. The Apache-2.0 SDK still ships but is no longer the center of gravity. It is not a typed reviewable inbox with policy/audit.
- **UiPath Action Center** is the enterprise gold standard to out-design (details in Gap Analysis).
- **Camunda 8 / Flowable / jBPM** are decades of prior art for *typed human tasks with audit* — study their user-task model and history/audit design, but they are BPMN-first and JVM-heavy, wrong shape for a single-user local app.
- **Retool/Appsmith/Budibase/ToolJet** let you stand up a custom typed inbox fast; Appsmith (Apache-2.0) and ToolJet (AGPL-3.0) are the self-host-friendly options if you want a low-code surface instead of your React UI.

## 4. Gap Analysis — Is the typed/policy/audited Action Center whitespace?

**Yes — the *combination* is whitespace.** Individually, pieces exist; assembled as an agent-native, self-hostable, typed/policy/audited HITL product, nothing off-the-shelf matches. Against your six differentiators:

1. **Policy engine (auto vs escalate on confidence + reversibility + blast-radius).** *No open-source agent tool ships this.* Approval tools decide via a static per-tool config ("this tool needs approval") — LangGraph's HITL middleware maps tool names to allowed decision types; HumanLayer marks specific functions. UiPath escalation is triggered by a developer-written natural-language prompt, not a computed risk score. Document Understanding uses a *confidence threshold* to route low-confidence field extractions to validation, which is the nearest analog — but it is per-field extraction filtering, not a general auto/escalate policy over reversibility and blast-radius. **Your multi-factor policy engine is genuinely novel.**
2. **Structural "money-never-auto" lock (independent of confidence).** No tool has a first-class, confidence-independent structural lock. Everyone models this as "just another approval." Your enforce-in-three-places design is differentiated.
3. **Per-item render schemas (card/form/document/diff) as a typed contract.** Closest: UiPath's typed action types (Form, Document Validation, App tasks) and LangGraph's `ActionRequest` args. But none treat *render type* as a first-class typed contract selected per item. AG-UI/CopilotKit give you generative UI primitives to *build* this, not the contract itself.
4. **Guided→assisted→automated autonomy gradient.** No off-the-shelf equivalent. UiPath offers only a coarse per-escalation Continue/End switch. A graduated autonomy ladder per action type is whitespace.
5. **Append-only audit as the substrate for "why did this happen."** BPM engines (Camunda) and UiPath keep audit trails, and durable engines keep event histories — but these are execution logs, not a decision-provenance substrate designed so a status change is *structurally impossible* without an audit row. Your invariant is stronger than what these ship.
6. **Earn-autonomy (thresholds that auto-tune from approval history).** The single closest thing anywhere is **UiPath Agent Memory**: each resolved escalation in Action Center stores a key-value pair of the question and supporting context (80-char key limit, 3-month TTL), matched by text-embedding semantic similarity so future similar escalations can auto-resolve — "allowing it to become more independent over time." But that is semantic-similarity memory reuse, *not* confidence thresholds that auto-tune from your approval statistics. **Your earn-autonomy is differentiated even against UiPath's best feature.**

**Conclusion:** The typed/policy/audited Action Center *is* genuine whitespace as an integrated, agent-native, self-hostable product. Everything on the market is either (a) a generic pause/approve primitive, (b) a heavyweight BPM human-task engine, or (c) a proprietary enterprise suite (UiPath). None provides your policy engine, money-lock, render-schema contract, autonomy gradient, provenance-grade audit, and earn-autonomy together. This is exactly the story a Principal-PM-for-HITL portfolio wants to tell.

## 5. Recommendation

**Runtime — BUY/ADOPT. Single best self-hostable pick: Windmill.** It gives you cron + webhook/event triggers, suspend/resume + approval steps, encrypted per-workspace secrets, and a fast self-hostable engine under AGPL-3.0, matching local-first. Wire your Claude capabilities as Windmill scripts/flows that POST action-items to your Action Center ingest API.
- *If you prefer code-native TypeScript:* **Trigger.dev** (Apache-2.0, waitpoint tokens) or **Inngest** (Apache-2.0 core, `waitForEvent`).
- *If you want maximum "personal-agent" ergonomics and accept volatility:* **OpenClaw** for channels/skills/heartbeat, but treat it as an untrusted, fast-moving dependency and keep your Action Center as a separate service it POSTs to.
- *If durability guarantees become paramount:* graduate to **Temporal** (MIT) or **Restate** (BSL 1.1).
- *Do not adopt* Claude Managed Agents as the core (hosted, Claude-only, beta) — but keep it in mind as a hosted fallback if you ever demo without your laptop.
- **The "always-on across a closed laptop" problem is the runtime's hardest requirement** and is not solved by any of these on a laptop that sleeps; plan a small always-on host (mini-PC/VPS/tunnel) or accept catch-up-on-wake semantics. This is the one place where "self-healing, no ops" collides with physics.

**Inbox — BUILD the logic, SCAFFOLD the surface.**
- **Scaffold from LangChain Agent Inbox** (MIT) if you want an agent-native inbox shell with edit/accept/respond/ignore, *or* keep your existing React UI and use **AG-UI + CopilotKit** (MIT) for typed/generative render surfaces and multi-channel (web/Slack/Telegram-adjacent) delivery.
- **Build yourself:** the policy engine, money-lock, render-schema typed contract, autonomy gradient, append-only audit substrate, and earn-autonomy. These are your defensible core and none exist off-the-shelf.
- **Prior art to study and out-design:** **UiPath Action Center + Maestro + Agent Memory** (the enterprise reference — typed tasks, audit, escalation routing, memory reuse) and **Camunda 8 user tasks/Tasklist** (open, mature typed human tasks + process history/audit). Out-design them on: multi-factor *policy* (they escalate by manual modeling — a developer-written prompt or BPMN User task, not a computed risk score), *earn-autonomy by approval statistics* (UiPath does semantic memory only), and *provenance-grade append-only audit* (they log execution, not decision provenance).

**Where the buy/build line falls:**
- Runtime: **100% buy.** Scheduler, durable retries, secrets, sandbox, pause/resume — all commodity.
- Inbox base surface (rendering shell, notification transport): **buy/scaffold.**
- Inbox *judgment layer* (the six differentiators): **build.** This is the portfolio artifact that demonstrates Principal-PM product judgment for HITL.

## 6. Risks & Flags

- **Licenses to watch:**
  - **n8n** — Sustainable Use License (fair-code, *not* OSI open source; internal/personal use OK, commercial resale restricted). Was Apache-2.0 + Commons Clause until 17 March 2022, when it switched to the Sustainable Use License.
  - **Windmill / ToolJet** — AGPL-3.0 (network copyleft; obligations if you distribute a modified networked service).
  - **Restate** — BSL 1.1 (source-available; can't offer it as a competing managed service).
  - **Camunda 8 (Zeebe/Tasklist/Operate/Identity/Optimize)** — Camunda License 1.0 since v8.6 (October 8, 2024); per docs.camunda.io, "To use the software in production, purchase the Camunda Self-Managed Enterprise Edition." Personal/non-commercial use is exempted. Current stable is 8.8.0 (October 7, 2025). *Not* OSI-OSS.
  - **Budibase** — GPL-3.0. **Retool / Lindy / Relay.app / Gumloop / Cloudflare / Claude Managed Agents / UiPath** — proprietary.
  - **OSI-approved OSS in this set:** LangGraph, Agent Inbox, CopilotKit, CrewAI, LlamaIndex Workflows, Microsoft Agent Framework, Mastra, Activepieces, Flowise, Letta (Apache-2.0), Trigger.dev (Apache-2.0), Inngest core (Apache-2.0), Kestra core (Apache-2.0), Prefect (Apache-2.0), Appsmith (Apache-2.0), OpenClaw (MIT).
- **Immature / volatile:** **OpenClaw** (months old, weekly releases, very high early security-advisory rate, leadership moved to OpenAI + new foundation — expect churn). **Claude Managed Agents** (public beta since June 2026). **Microsoft Agent Framework** (RC/GA early 2026; APIs may shift). Treat all three as moving targets.
- **Pivoted:** **HumanLayer** — its own docs say the SDK "is being superseded by CodeLayer," a coding-agent IDE; the approval SDK remains Apache-2.0 but is no longer the strategic focus — verify the SDK is still maintained before depending on it.
- **Likely changed since training data (re-verify before building):**
  - Exact GitHub star counts and last-commit recency for OpenClaw, LangGraph (~24,800; 1.0 GA Oct 2025, v1.0.10 Mar 2026), Trigger.dev, Windmill, Letta, CrewAI (~45,400 at v1.10.1, Mar 2026), Mastra — all fast-moving.
  - Whether Claude Managed Agents cron/vault features left beta and their pricing (session-hour fee reported at ~$0.08/session-hour plus token usage).
  - Trigger.dev v4 GA status and whether waitpoints are still v4-gated.
  - UiPath 2025.10 features (Case Management, Process Apps) GA vs preview status.
  - Mastra's exact license (confirm Apache-2.0 vs Elastic v2 on the repo).
  - Camunda licensing edition boundaries (which components are free for dev vs require production license).

## 7. Sources
Official docs and GitHub cited inline throughout. Key primary sources: Anthropic/Claude Managed Agents announcements (InfoQ, Tech Times, Anthropic docs); github.com/openclaw/openclaw + en.wikipedia.org/wiki/OpenClaw; docs.langchain.com human-in-the-loop + github.com/langchain-ai/agent-inbox + langchain.com blog on `interrupt`; docs.temporal.io AI cookbook (human-in-the-loop); inngest.com docs + agentkit.inngest.com/advanced-patterns/human-in-the-loop; trigger.dev docs (wait-for-token, v4 GA); restate.dev docs + github.com/restatedev/restate; developers.cloudflare.com/agents + Cloudflare Workflows GA blog; docs.n8n.io sustainable-use-license + github.com/n8n-io/n8n/LICENSE.md + en.wikipedia.org/wiki/N8n; windmill.dev docs (flow_approval) + github.com/windmill-labs/windmill; github.com/camunda/camunda + docs.camunda.io/reference/licenses; docs.copilotkit.ai + github.com/CopilotKit/CopilotKit (AG-UI); learn.microsoft.com/agent-framework; docs.uipath.com Action Center (actions-overview, create-form-task, create-document-validation-action, action-definitions), Maestro (user-task, April 2025 release notes), and Agents Escalations & Agent Memory.