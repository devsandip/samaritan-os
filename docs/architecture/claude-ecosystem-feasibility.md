# Samaritan on Claude vs. OpenClaw vs. Hermes: Can a Personal Agentic OS Live Inside the Claude Ecosystem?

## 1. Executive summary
- **You can build a credible HITL layer and a competent local runtime inside the Claude ecosystem, but you cannot build a *local-first AND always-on* runtime there — that tension is irreducible today.** Local Claude Code/Cowork sleeps with your laptop; hosted Managed Agents stays up but is cloud-only, Claude-only, and beta.
- The Claude ecosystem's HITL is **per-tool allow/deny gating** (Agent SDK `can_use_tool` / `permission_mode` / `PreToolUse` hooks; Managed Agents `always_ask` + `user.tool_confirmation`; MCP elicitation). These are real pause→ask→resume mechanisms but they are **blocking, ephemeral, per-call prompts — not a typed, policy-driven, audited, deferrable inbox.** Your six Action Center differentiators are all build-yourself on every platform.
- **Managed Agents (public beta, launched April 8 2026) is the only first-party "always-on, zero-ops" option** — scheduled deployments (cron, minute granularity), durable sessions, a credential vault, `$0.08` per session-hour (measured to the millisecond, accruing only while a session's status is `running` — roughly $58/month for an around-the-clock agent before token costs, per Anthropic's pricing page). Anthropic cites Notion, Rakuten, Asana, and Sentry in production at launch. But it is cloud-hosted, Claude-only, and **not ZDR/HIPAA-eligible**, which collides with your local-first privacy constraint for Obsidian/health/company data.
- **No Claude surface offers a durable event trigger** ("email arrives", "transcript ready", "vault file changes") that survives a closed laptop. Locally you get the Monitor tool + file watchers + Channels webhook receiver (all session-bound); in the cloud you get cron + inbound webhooks you POST yourself. Event-driven agents need glue you write.
- **OpenClaw** (MIT, 381k+ GitHub stars per Steinberger's own GitHub profile, OpenClaw Foundation) and **Hermes** (MIT, 217k stars verified live on GitHub, Nous Research) both give you *out of the box* exactly the runtime plumbing Claude makes you assemble: an always-on gateway daemon, 20+ messaging channels, durable cron + heartbeat, secrets/credential pools, and a skills system. Both run Claude as the model.
- **But neither OpenClaw nor Hermes gives you your Action Center.** Their HITL is generic command/approval gating (OpenClaw exec-approvals deny/allowlist/ask/auto/YOLO; Hermes an 8-layer dangerous-command gate). Adopting them removes your *runtime* build, not your *differentiated* build.
- **Verdict: build a hybrid, and keep your Action Center yours.** The Action Center (policy engine, money-lock, render schemas, autonomy gradient, append-only audit, earn-autonomy) is the portfolio-defining IP and maps to no primitive on any platform — build it. For runtime, choose based on the always-on question, not on features.
- **One-line verdict:** *Claude-ecosystem-only* offers the best agent loop and best privacy but fails always-on without a dedicated always-on Mac; *OpenClaw/Hermes* solve always-on + channels + cron but bring generic HITL and (OpenClaw) a severe security-advisory load; the **right answer is hybrid — an always-on host (a Mac mini running Claude Code, or Hermes as the gateway) + the Claude Agent SDK for the loop + your own Action Center on top.**
- Given your constraints (single-user, privacy, no SRE, money-never-auto), I recommend: **an always-on Mac mini running Claude Code (Agent SDK) + MCP + Channels, your Action Center as the escalation brain, and Managed Agents used selectively for the non-sensitive, must-be-always-on cron agents.**

## 2. Claude ecosystem primitives inventory

| Primitive | Layer(s) served | Local vs hosted | Maturity (mid-2026) | Hard limits |
|---|---|---|---|---|
| **Claude Code (headless, `claude -p`)** | Runtime | Local (your machine) | GA, mature | Sleeps with laptop; resume-dialog can block unattended runs; `--dangerously-skip-permissions` removes gates |
| **Claude Agent SDK** (formerly Claude Code SDK, renamed Sept 2025) | Runtime + HITL (per-tool) | Local (your process) | GA, mature; Python + TS | Runs in *your* infra → not always-on by itself; governed by Anthropic Commercial Terms; API-key auth (no claude.ai login for 3rd-party products) |
| **Claude Code Channels** | Runtime (I/O) + HITL delivery | Local | Research preview (v2.1.80, Mar 20 2026) | Telegram/Discord/iMessage only; requires claude.ai Pro/Max login (no API key); **only works while session is open**; allowlisted plugins |
| **Monitor tool + file watchers/hooks** | Runtime (event trigger) | Local | Preview | Event stream only while session alive; chatty output auto-stops; not durable across sleep |
| **Claude Code scheduled tasks** (`/loop`, Desktop tasks, cloud Routines) | Runtime (cron) | Local (`/loop`, Desktop) / hosted (Routines) | Mixed | `/loop` session-scoped, 3-day expiry; Desktop needs app open; Routines min interval 1h, no local files; cron jitter up to 30 min |
| **Claude scheduled tasks (Cowork)** | Runtime (cron) | Hosted (runs even when laptop asleep) | Beta | Autonomous only — can't pause mid-run to ask; Claude-only |
| **Claude Managed Agents** | Runtime (always-on) + HITL (per-tool) | Hosted cloud (or self-hosted sandbox) | **Public beta** (`managed-agents-2026-04-01`), launched Apr 8 2026 | Cloud reasoning; **not ZDR/HIPAA-eligible**; no VPC/PrivateLink in beta; scheduled deployments minute-granularity, max 1,000/org, no backfill; `$0.08`/session-hr + tokens |
| **Agent Skills (SKILL.md)** | Runtime (capability) | Both | GA | Passive resource discovered by Claude; **cannot emit over HTTP**; not a trigger |
| **MCP** | Execution/integration + HITL (elicitation) | Both (local + remote servers) | GA; elicitation draft (spec 2025-06-18) | Elicitation client support still uneven; MCP itself has no policy/audit model |
| **Artifacts / Cowork live artifacts** | Action Center (UI surface only) | Client-side; desktop-only for live | GA | **No server backend; refresh-on-open only; no always-on**; single-user |
| **Cowork / Claude Desktop** | Runtime (execution surface) | Local desktop | Beta | Stops when app closed (local sessions); Claude-only; single-user |
| **Computer use / Claude in Chrome** | Runtime (browser acting) | Local/hosted | Research preview (Pro/Max) | Immature; risky for money/health actions |
| **Permission primitives** (allowed-tools, permission modes, AskUserQuestion, `can_use_tool`, PreToolUse hooks) | HITL | Both | GA | Per-tool allow/deny only; **no confidence/reversibility/blast-radius, no typed render, no audit, no deferral** |

## 3. What you CAN build in the Claude ecosystem, per layer

**RUNTIME.** The strongest local option is your current path: **Claude Code (Agent SDK) on a Mac**, invoked by `launchd`/cron for scheduled jobs (`claude -p --output-format json --json-schema ...`), with **skills** as capabilities and **MCP servers** for execution (Gmail, Calendar, Slack, Notion, TickTick, Obsidian, Telegram). Secrets ride the shell environment / macOS Keychain. **Events**: the **Monitor tool** streams a background watcher script's stdout into a live session (your `vault-file-changes` and `build-watcher` monitors are exactly this pattern), and **Channels** turns Telegram into a webhook receiver + chat bridge — but both die when the session/laptop sleeps. **Always-on** is the gap: local Claude Code cannot self-heal or survive a closed lid. The two honest fixes are (a) a dedicated **always-on Mac mini** (still local-first) or (b) **Managed Agents scheduled deployments** for the cloud-safe subset (hosted, self-healing, cron + vault, but Claude-only and not privacy-eligible for your vault/health/company data).

**HITL.** You can implement real pause→ask→resume three ways: **Agent SDK** `can_use_tool` callback / `permission_mode` / `PreToolUse` hook (block a tool call in-process and route the question out via Channels/Telegram); **Managed Agents** `always_ask` policy, which pauses the session with `stop_reason: requires_action` until you send a `user.tool_confirmation` (`allow`/`deny` + `deny_message`); or **MCP elicitation**, where a server pauses a tool and requests structured input. All three are genuine gates — but they gate a *single tool call*, synchronously, with no typing, no policy, no audit, no deferral, no autonomy tuning.

**ACTION CENTER.** Nothing in the Claude ecosystem provides it. The closest surface is a **Cowork live artifact** as the review UI (your dashboard already is one) — persistent HTML with MCP access — but it refreshes only when open and has no server backend. So the Action Center's brain (ingest API, policy engine, SQLite audit store, lifecycle state machine, render-schema contracts) must remain the standalone service you've already built; Claude primitives feed it (agents POST proposals) and consume it (approved actions execute via MCP).

## 4. OpenClaw and Hermes profiles

**OpenClaw** — MIT-licensed, self-hosted personal-agent gateway; created by Peter Steinberger (Warelay→Clawdbot→Moltbot→OpenClaw), now stewarded by the OpenClaw Foundation after Steinberger joined OpenAI (Feb 2026). Architecture: a persistent **Gateway** daemon (Node.js, localhost WebSocket control plane) with a session registry, command queue, **heartbeat runner**, **cron scheduler**, and event broadcaster; **channel adapters** for 20+ messaging platforms (WhatsApp, Telegram, Slack, Discord, Signal, iMessage…); an **agent runtime** that calls any frontier/local model (including Claude); and a **skills** system (SKILL.md, ClawHub registry). Scheduling: durable cron (persisted `jobs.json`, retry backoff, webhook delivery) + heartbeat (~30-min pulse). Events: inbound webhooks + wake modes. **HITL: exec-approvals** (deny/allowlist/ask/auto/full/YOLO) — a command-execution guardrail, not a typed policy inbox; a feature request for HITL on outbound messaging (issue #2023) remains open. **Maturity/risk: 381k+ stars (per Steinberger's own GitHub profile: "🦞 OpenClaw (381k+ stars) – the AI that actually does things"), extremely aggressive release cadence, and a very high security-advisory load** — 1,142 advisories in five months, "16.6/day, twice the Linux kernel's rate," per Steinberger's "State of the Claw" keynote (AI Engineer Summit, April 2026). A Bitsight analysis "found many exposed instances on the public internet, arguing attackers can skip prompt injection entirely and hit the gateway API directly if it's exposed." Provides: Runtime ✅, channels ✅, HITL ⚠️ (generic), Action Center ❌.

**Hermes (Hermes Agent, Nous Research)** — MIT-licensed, self-hosted, "self-improving" personal agent. **Verified primary-source facts (GitHub, mid-2026): 217k stars, 40.7k forks, 16,164 commits, v0.18.2 (`v2026.7.7.2`), last release Jul 8 2026, Python 81.7%/TS 15.6%.** (Secondary sources vary wildly — 140k/175k/355k; the live GitHub page shows 217k. It reportedly crossed 175k stars within four months of a Feb 25 2026 release per AI Builder Club; re-verify the count at build time.) Persistent **gateway daemon** with a built-in cron scheduler (ticks every 60s; single `cronjob` tool; `jobs.json` + `executions.db` ledger), 20+ platform adapters, a self-improving **skills** system (agentskills.io-compatible; Nous's internal benchmarks claim agents with 20+ self-created skills complete similar tasks ~40% faster/cheaper in tokens and wall-clock — not better output), and layered markdown memory. **Model-agnostic BYOK including Claude/Anthropic** (direct API, OAuth, OpenRouter). Secrets: credential pools, external secret managers (Bitwarden/Vault/AWS/1Password), Nous Portal OAuth. **HITL: an 8-layer security model whose layer 2 is a structurally-enforced "dangerous command approval" gate** (`tools/approval.py`, modes smart/manual/off, 300s fail-closed timeout, hardline blocklist) — but it is **command-execution-centric and does NOT natively gate "send email" or "move money."** Outbound-message approval exists only via a **separate plugin** (`hermes-telegram-business`, observe-with-approval: every drafted reply needs a [Send]/[Edit]/[Discard] tap; "No auto-send exists"). Event triggers: mostly no (cron + `script`/`wakeAgent` gates; a native-trigger PR was declined). Can auto-migrate from OpenClaw. Provides: Runtime ✅, channels ✅, HITL ⚠️ (command-centric + plugin), Action Center ❌.

Both are real, maintained, comparable frameworks. Neither has a typed/policy/audited Action Center.

## 5. Component-by-component gap table

**RUNTIME**
| Component | Claude ecosystem | OpenClaw | Hermes |
|---|---|---|---|
| Always-on daemon | ⚠️ Managed Agents (cloud, beta) or self-run Mac; local Code sleeps | ✅ Gateway (systemd) | ✅ Gateway (systemd) |
| Durable cron (survives restart) | ⚠️ Managed Agents deployments (cloud); local `/loop` ephemeral | ✅ `jobs.json` + backoff | ✅ `cronjob` + `executions.db` |
| Event triggers | ⚠️ Monitor/Channels (session-bound); cron+webhook in cloud | ⚠️ webhooks + heartbeat | ⚠️ cron + script gates |
| Messaging channels | ⚠️ Channels: Telegram/Discord/iMessage, preview, session-bound | ✅ 20+ | ✅ 20+ |
| Secrets/vault | ⚠️ shell env local; vault in Managed Agents (cloud) | ✅ | ✅ pools + secret managers |
| Self-healing | ⚠️ only Managed Agents | ✅ heartbeat | ✅ gateway supervision |
| Agent loop quality | ✅ best-in-class (first-party harness) | ✅ (via Claude) | ✅ (via Claude) |
| Skills | ✅ first-party | ✅ ClawHub | ✅ agentskills.io |

**HITL**
| Component | Claude ecosystem | OpenClaw | Hermes |
|---|---|---|---|
| Pause→ask→resume | ✅ per-tool (`always_ask`/`can_use_tool`/elicitation) | ✅ exec-approvals ask | ✅ dangerous-command gate |
| Structural enforcement | ✅ (Managed Agents platform-enforced) | ⚠️ interlock, compaction can drop it | ✅ code-enforced (commands only) |
| Outbound message/email gate | ❌ build | ❌ (FR open) | ⚠️ plugin only |
| Money gate | ❌ build | ❌ build | ❌ build |
| Confidence/reversibility/blast-radius policy | ❌ build | ❌ build | ❌ build |
| Typed render schemas | ❌ build | ❌ build | ❌ build |
| Autonomy gradient / earn-autonomy | ❌ build | ❌ build | ❌ build |
| Append-only audit substrate | ❌ build | ❌ build | ❌ build |

**ACTION CENTER** — Build-yourself on all three. None provides a typed/policy/audited inbox, render-schema contracts, or auto-tuning thresholds.

**Direct answer — what Claude-ecosystem-only forces you to build that OpenClaw/Hermes hand you:** (1) an always-on gateway daemon that self-heals and survives restarts; (2) a multi-channel messaging fabric (you'd have only preview-grade, session-bound Channels); (3) a heartbeat/supervision loop; (4) durable cron persisted across restarts with retry backoff + a run ledger (locally — Managed Agents gives this only in the cloud); (5) credential pools / secret-manager integration (locally). **What the Claude ecosystem uniquely gives you that OpenClaw/Hermes don't:** (1) the best-in-class first-party Claude agent harness (same loop as Claude Code, with subagents/hooks/compaction); (2) first-party Agent Skills and first-party MCP (Anthropic authored the protocol) + the largest connector ecosystem; (3) a first-party **managed, zero-ops, always-on host** (Managed Agents + vaults) — both rivals are self-host-only, so *you* run and patch the box; (4) platform-enforced per-tool `always_ask` confirmation (allow/deny + `deny_message`); (5) typed structured output (`--json-schema`) that feeds your zod contracts; (6) Cowork live artifacts as a zero-build review UI.

## 6. Pros and cons

**Claude-ecosystem-only.** Pros: best agent loop; first-party skills/MCP; strongest privacy if kept local; typed output for your zod contracts; a zero-ops cloud option (Managed Agents). Cons: no local-first always-on; event triggers are session-bound or cron-only; channels are preview-grade; Managed Agents is beta, Claude-only, not ZDR/HIPAA; deep vendor lock-in to Anthropic.

**OpenClaw.** Pros: turnkey always-on gateway, 20+ channels, durable cron + heartbeat, huge ecosystem, MIT, runs Claude. Cons: **very high security-advisory load and a history of mass-exposed instances**; volatile multiple-per-week releases (breaking changes); HITL is generic command gating, prompt/convention-heavy (context compaction has dropped HITL instructions in real incidents). Lock-in: low (MIT, model-agnostic).

**Hermes.** Pros: turnkey always-on gateway, 20+ channels, durable cron with a run ledger, credential pools + external secret managers, MIT, model-agnostic (Claude-ready), **cleaner/code-enforced approval for commands**, OpenClaw import. Cons: approval gate is command-centric (email/money not natively gated); outbound-message approval is a plugin; event triggers are weak; younger/smaller ecosystem than OpenClaw; still self-host (you run the box). Lock-in: low.

**Hybrid (recommended).** OpenClaw *or* Hermes (or an always-on Mac mini running Claude Code) for runtime + channels + cron; the **Claude Agent SDK** for the agent loop where you want the best harness; **your own Action Center** as the escalation/policy/audit brain on top. Pros: each layer uses the best tool; your differentiators stay yours and portable; you avoid rebuilding runtime plumbing. Cons: more integration surface; two moving systems to keep healthy. **The core tradeoff is local-first vs always-on**: a closed MacBook can't be always-on, so either dedicate an always-on machine (keeps privacy) or push the always-on subset to a hosted runtime (Managed Agents) and accept that non-sensitive agents leave your machine.

## 7. The 26 agents mapped

**Well-served by Claude primitives today (on-demand / cron, low blast-radius):** PRD writer (3), calendar reads (4), data-analysis (5), WBR (6), system-design/product-sense/analytical interview prep concept-of-the-day + quiz (18, 20, 21), today-task (19), newsletter → today's read (22), weekly-planner (23), teach-me-this-concept (25), interview docket builder (17). These are largely your blog's "skills + scheduled jobs" and run well as Claude Code skills + cron.

**Need extra runtime infra (durable event triggers and/or always-on host):** email read/write (1), Slack/Telegram (2), meeting-notes from Granola (26), post-meeting sweeps, oversee-Claude-Code (7), hourly check-in (24), and the inbound-alert job agents — LinkedIn jobs (13), LinkedIn saved posts (14), Indeed (15), other-jobs (16). "Email arrives / transcript ready / new alert" has **no durable Claude-native trigger** — these need your webhook shim, a polling cron, or an always-on watcher. The oversee-Claude-Code agent (7) maps neatly to the **Monitor tool** locally.

**MUST have HITL gates:**
- **Money (sharpest — your "money-never-auto" lock):** invest via Zerodha (12), personal-budget unsubscribe/cut actions (11). These must escalate to the Action Center every time, and money movement should never be a tool the agent can auto-call.
- **External messages/email:** email send (1), Slack/Telegram send (2), and every referral/outreach draft-and-send (13, 14, 15, 16). Draft auto, send only on approval.
- **Calendar writes (4):** moderate — auto-add low-stakes, escalate conflicts with protected hours (family / doc-writing / learning / sleep).
- **Health/sensitive data:** nutrition/meal-tracking (8), workout/Hevy (9), wellness/Oura (10). The sensitivity argues for **local-first execution** (not cloud Managed Agents, which isn't ZDR/HIPAA-eligible), even though the actions themselves are low-stakes.

**Exceed / strain Claude-ecosystem capabilities:**
- **invest (12)** is the hardest: it needs a brokerage integration (no first-party Zerodha MCP — you'd build an MCP or resort to browser **computer use**, which is research-preview and risky) *and* it moves money → maximum HITL. Recommend research/propose-only, execution always manual.
- **Health integrations (8/9/10):** Oura/Hevy/meal-tracking need MCP/API adapters you build or source, plus sensitive-data handling.
- **Granola meeting notes (26):** needs a Granola export/integration (your blog already wires Fireflies via a post-meeting sweep — same shape).

Event-driven: 1, 2, 7, 13–16, 22, 24, 26. Cron: 6, 8–11, 18–21, 23, and morning/weekly rollups. On-demand: 3, 4, 5, 17, 25.

## 8. Recommendation

**Single best architecture for your constraints:**
1. **Runtime host:** a **dedicated always-on Mac mini running Claude Code (Agent SDK)** as the agent loop, kept alive by `launchd`, with skills as capabilities and **MCP servers** for every tool (Gmail, Calendar, Slack, Notion, TickTick, Obsidian, Telegram, Indeed). This preserves local-first privacy *and* solves always-on — the one combination no cloud Claude surface offers. Reach it remotely via **Channels (Telegram)** + your private tunnel. (This also matches your published "Claude is the broker; the apps are the substrate" model.)
2. **Event triggers:** local watchers (Monitor tool + file watchers for the vault; a small always-on webhook receiver for Gmail push / Granola / alerts) that POST proposals into your Action Center ingest API.
3. **HITL + Action Center:** keep your existing service as the escalation brain. Claude agents never send money or external messages directly — they emit proposals; the Action Center's policy engine decides auto-complete vs escalate; the money-lock stays structural and independent of confidence.
4. **Selective cloud:** use **Managed Agents scheduled deployments** only for the *non-sensitive, must-be-always-on* cron agents (e.g., newsletter digest, public-data research) so they survive even if the mini is down — never for vault/health/company data.

**Regardless of path, the exact components you must build yourself (they map 1:1 to your six differentiators):**
- (a) **Policy engine** (auto vs escalate on confidence + reversibility + blast-radius) — no platform has it.
- (b) **Structural money-never-auto lock** independent of confidence — no platform has it.
- (c) **Per-item typed render schemas** (card/form/document/diff) as a first-class contract — no platform has it.
- (d) **Guided→assisted→automated autonomy gradient** — no platform has it.
- (e) **Append-only audit substrate** ("why did this happen") — no platform has it (OpenClaw/Hermes have run ledgers, not decision audit).
- (f) **Earn-autonomy** (thresholds auto-tuned from approval history) — no platform has it.

**Adopt off-the-shelf for everything else:** the agent loop (Claude Agent SDK), skills, MCP connectors, and — if you prefer a turnkey gateway over a Mac mini — **Hermes** for the always-on daemon + channels + cron + credential pools (cleaner, code-enforced approval and a far lower security-advisory load than OpenClaw), with your Action Center layered on top. This is also the strongest *portfolio narrative* for a Principal-PM-HITL role: it shows you evaluated the entire landscape, adopted commodity runtime, and reserved your engineering for the differentiated HITL/governance layer that no vendor ships.

**Benchmarks that would change this recommendation:** if Managed Agents exits beta *with* ZDR/HIPAA eligibility and self-hosted-sandbox maturity, the hosted path becomes viable for sensitive agents and could replace the Mac mini. If Anthropic ships a durable, first-party event-trigger + always-on local daemon (an "OpenClaw-in-Claude-Code"), the case for a third-party gateway collapses. If OpenClaw's advisory rate falls sharply and its outbound-message HITL (issue #2023) lands, it re-enters contention over Hermes on ecosystem size.

## 9. Risks & flags
- **Beta/preview to re-verify:** Managed Agents (public beta, `managed-agents-2026-04-01`; pricing/limits/dreaming/MCP-tunnels may change); Channels (research preview, session-bound, claude.ai-login-only); Monitor tool and computer use (previews). Re-check all before depending on them.
- **The always-on-laptop constraint is the central risk.** A closed MacBook is not a runtime. Decide now: dedicated always-on machine (keeps privacy) vs hosted (leaks the always-on subset to Anthropic's cloud).
- **Privacy eligibility:** Managed Agents is **not ZDR/HIPAA-eligible** and data resides on Anthropic's cloud — do not route Obsidian, health, or company data through it.
- **OpenClaw security posture:** very high advisory rate and mass-exposed-instance history; if adopted, bind to localhost, require auth, pin versions, and audit skills. Treat "agent with shell + credentials in your inbox" as sudo with a chat UI.
- **HITL fragility:** prompt/convention-based approval can be silently dropped by context compaction (documented in real incidents where a "don't act until I approve" instruction was summarized out of context). Your structural, out-of-band Action Center is the correct mitigation — keep the gate outside the model's context and enforce it in your own code, not in the prompt.
- **Volatility:** OpenClaw ships multiple times per week with breaking changes; Hermes is younger (v0.18.2). Star counts and features move fast — re-verify at build time (Hermes especially, where secondary sources disagree by 100k+).
- **Lock-in:** Managed Agents/Cowork/Channels are Anthropic-only; OpenClaw/Hermes are MIT and model-agnostic. Keeping your Action Center model-agnostic protects you if you switch agent backends.

## 10. Sources
Primary (verified this session): **docs.claude.com / platform.claude.com** — Agent SDK overview (headless, hooks PreToolUse/PostToolUse/etc., subagents, MCP, permissions, sessions; SDK-vs-Managed-Agents table), Managed Agents overview / permission-policies (`always_allow`/`always_ask`, `user.tool_confirmation`) / scheduled-deployments (cron, minute granularity, 1,000/org, pause/unpause/archive) / pricing ($0.08/session-hr), Agent Skills (SKILL.md, progressive disclosure), Channels (`code.claude.com/docs/en/channels`), Monitor/tools reference, Cowork help-center articles (scheduled tasks run remotely; live artifacts desktop-only, refresh-on-open, no backend). **claude.com/blog** — Managed Agents launch (public beta Apr 8 2026; Notion/Rakuten/Asana/Sentry). **github.com/anthropics** — claude-agent-sdk-python/typescript. **github.com/openclaw/openclaw** (repo, security advisories, issue #2023), **docs.openclaw.ai** (automation, exec-approvals, gateway architecture), **openclaw.ai/blog** (auto-mode approvals), Steinberger GitHub profile (381k+ stars), "State of the Claw" keynote coverage (1,142 advisories). **github.com/NousResearch/hermes-agent** + **hermes-agent.nousresearch.com/docs** (security 8-layer/dangerous-command gate, cron, architecture, providers, FAQ) + **github.com/NousResearch/hermes-telegram-business**. **modelcontextprotocol.io** (elicitation, spec 2025-06-18). **blog.sandip.dev** (AI-PM-OS skills/triggers/jobs post — Samaritan, Cowork artifacts, Claude Code Channels Telegram bridge). Secondary/context (Bitsight exposure analysis; MindStudio/Momentic/Verdent Managed Agents pricing; AI Builder Club Hermes stars) flagged inline as secondary.