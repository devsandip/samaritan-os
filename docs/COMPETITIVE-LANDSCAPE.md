---
title: Samaritan vs the 2026 Agentic-OS Landscape
subtitle: Competitive scan of local-first agent OSes, HITL layers, and manifest prior art
owner: Sandip Dev
status: Scan v1.0
date: 2026-07-20
---

# Samaritan vs the 2026 Agentic-OS Landscape

*Companion to PRFAQ.md. This is the evidence behind the PRFAQ's buy-vs-build
answer and its differentiation claims. It is a dated snapshot, not a living
document: rerun the scan rather than editing this file, and supersede it with a
new dated section if the landscape moves.*

*Mirrored to the vault at `Research/Inbox/2026-07-20-samaritan-vs-2026-agentic-os-landscape.md`
and to [Notion](https://app.notion.com/p/3a38fdd0911181528fc0c537bf699d58).*

---

Competitive scan run 2026-07-20 against Samaritan. Eight parallel research agents
covering local-first personal agent OS projects, human-in-the-loop approval
layers, agent-runtime products, enterprise agent-approval platforms, agentic
identity and authorization, capability-manifest prior art, big-tech platform
positioning, and 2026 launches.

Method caveat, stated up front. The session's web-search budget was exhausted
early; most evidence comes from authenticated GitHub API calls, direct fetches of
vendor documentation, and the arXiv and HN Algolia APIs. That is stronger evidence
for schemas, star counts and liveness than search snippets would be, but it means
closed-source and non-GitHub launches are under-covered. Items that could not be
verified are flagged inline.

## Samaritan, as the baseline

- Local-first. Local daemon, SQLite store, web UI on 127.0.0.1, reached remotely
  via Telegram plus a Tailscale or Cloudflare tunnel. Explicitly not a hosted SaaS.
- Knowledge stack: Obsidian vault, Notion databases, TickTick, Fireflies, Gmail,
  Calendar, Telegram.
- Capabilities are folders with a `manifest.yaml` declaring trigger, emitted
  action-item types with render schema, allowed human responses, execution mode,
  per-type policy, and `requires_capabilities`. Zero core code changes to add one.
- Agents never write to systems of record. They emit action items into a policy
  engine that scores confidence, reversibility and blast radius per item, and
  either auto-completes or escalates to the Action Center inbox.
- Execution registry maps abstract action types (`message.send`, `task.create`,
  `payment.make`) to provider plus account plus execution mode (guided, assisted,
  automated). A missing or incapable adapter degrades to `guided.fallback` rather
  than failing.
- Hard invariants enforced structurally: money never moves automatically, checked
  in three independent places; a status change with no audit row is not
  representable, enforced by SQLite triggers.
- Designed but unbuilt: earn-autonomy, thresholds auto-tuning from approval history.

## Headline finding

The topology has been commoditized. The contract has not.

Two projects above 200k stars converged independently on Samaritan's exact
infrastructure: local daemon, SQLite, 127.0.0.1 UI, Telegram, Tailscale or SSH for
remote. That removes topology as a differentiator entirely.

The governance contract is a different story, but it is narrower ground than it
looked at the start of the scan. ZeroClaw has already shipped most of the manifest
idea. What remains genuinely unclaimed is the emitted-action-item type with a
render schema, the execution registry, degrade-to-guided, and earn-autonomy.

## Tier 0: the real peers

### OpenClaw

https://github.com/openclaw/openclaw

383,532 stars, 80,563 forks, MIT-ish, created 2025-11-24, releases on calendar
versioning multiple times a week. The most-starred software project on GitHub.
Formerly Clawdbot, then Moltbot, renamed OpenClaw 2026-01-30.

Same architecture as Samaritan, opposite philosophy. It has the topology line for
line: a Gateway daemon installed as a launchd or systemd user service, loopback by
default (`ws://127.0.0.1:18789`), SQLite control plane at
`~/.openclaw/state/openclaw.sqlite` plus per-agent stores, Control UI on 127.0.0.1,
23+ messaging channels, and documented remote access via SSH tunnel or Tailscale.

It has a task ledger (`flow_runs`, statuses `queued|running|waiting|blocked|
succeeded|failed|cancelled|lost`) and a separate metadata-only audit ledger with
`schemaVersion: 1` and `redaction: "metadata_only"`. Notably its audit docs warn
that "absence of a row proves nothing", which is precisely the weakness Samaritan's
DB triggers close.

Its capability contract is thin. Skills are `SKILL.md` folders with `name` plus
`description` required. Plugins use `openclaw.plugin.json` with a real `activation`
block (`onStartup`, `onProviders`, `onCommands`, `onChannels`, `onRoutes`,
`onConfigPaths`, `onCapabilities`) and a `contracts` capability-ownership snapshot.
No policy field anywhere.

Its approval model is exec-scoped and per-call: `tools.exec.mode` in
`deny|allowlist|ask|auto|full`, with `exec.approval.requested` broadcast and
resolved via Control UI, macOS app, Matrix reactions or CLI. Approval-time file
binding means a changed file invalidates the approval. Its "standing orders", the
closest thing to a policy document, are markdown prose in `AGENTS.md` interpreted
by the model, not a machine-checked schema.

Security is its weak flank: CVE-2026-33579 privilege escalation, 135,000 exposed
instances with 15,000+ RCE-vulnerable, 800+ malicious skills on ClawHub, the
top-downloaded skill on the marketplace being malware, and both Anthropic and
Google temporarily restricting subscription OAuth for OpenClaw usage in early 2026.
China restricted state-enterprise use in March 2026. NVIDIA ships NemoClaw (21.8k
stars) specifically to sandbox it. O'Reilly's March 2026 analysis names the missing
pieces as "permission boundaries, approval gates, audit logging, and recovery
mechanisms", which is a market-gap statement for exactly what Samaritan builds.

### ZeroClaw

https://github.com/zeroclaw-labs/zeroclaw

32,329 stars, Apache-2.0, created 2026-02-13, `v0.8.3` on 2026-07-16, 151 releases,
~4,477 commits. Rust rewrite of the OpenClaw idea as a single binary.

**This is the closest capability-manifest contract that exists, and it is a
correction to any claim that Samaritan's manifest is unprecedented.** Capabilities
are SOPs: a folder containing a required `SOP.toml` plus an optional `SOP.md`.

`SOP.toml` declares `name`, `description`, `version`, `max_concurrent`,
`admission_policy` in `parallel|hold|coalesce|drop`, `max_pending_approvals`,
`step_schema_enforce`, `step_scope_enforce`, and typed `[[triggers]]` covering
mqtt, cron, channel, amqp, manual, filesystem, git, webhook, peripheral and
calendar. Their docs admit webhook, peripheral and calendar are matched but not yet
routed to a live event source.

`SOP.md` steps carry `tools:`, `requires_confirmation: true`, `kind:
execute|checkpoint`, `when:` JSONPath guards, `on_failure: fail|retry:<n>|goto:
<step>`, a `policy:` reference to a named approval-broker policy, and JSON-Schema
`input:`/`output:`.

Named approval policies:

```toml
[sop.approval.policies.prod]
required_group = "release"
quorum = 2
escalation_route = "oncall"
```

Risk profiles are declared: `readonly`, `supervised` (default), `full`, with
per-tool `auto_approve`, `always_ask`, `excluded_tools`, `allowed_commands`,
`workspace_only`, `forbidden_paths`. Approvals route to the originating channel
(Telegram inline keyboards, Slack Block Kit), 120s default timeout, unanswered
equals denied. Runs park in `WaitApproval` and release their execution slot.
`max_pending_approvals` provides backpressure so triggers are deferred, never
silently dropped.

Audit: `sop.persist_runs` writes SQLite at `<data_dir>/sop/runs.db`, plus records
under keys `sop_run_{id}`, `sop_step_{id}_{n}`, `sop_approval_{id}_{n}`,
`sop_timeout_approve_{id}_{n}`. Cryptographic tool receipts on every action.

Where it diverges: SOPs declare deterministic *steps*, not emitted action-item
types. There is no render schema. There is no review inbox UI at all. And it is
operator- and team-shaped (quorum, escalation routes, MQTT and AMQP triggers)
rather than single-user.

Skepticism note: 32k stars on a pre-1.0 project in five months is a hype curve
riding OpenClaw's coattails, and PR numbers in the #9000s suggest heavy bot traffic.

### Hermes Agent (Nous Research)

https://github.com/NousResearch/hermes-agent

217,417 stars, MIT, created 2025-07-22, `v2026.7.7.2` on 2026-07-08. Local daemon
plus gateway, SQLite memory with FTS5, separate desktop (13.4k) and web UI (16.3k)
repos.

The only project shipping a persistent, restart-surviving, multi-item approval
queue reviewable from Telegram. `tools/write_approval.py` stages records at
`<HERMES_HOME>/pending/{memory,skills}/<id>.json` "so they survive process restarts
and can be reviewed from CLI, gateway, or the web dashboard". Reviewed via
`/memory pending`, `/skills pending`, `approve <id>`, `reject <id>`, `diff <id>`.
Records carry `id`, `summary`, and `origin` (`foreground` vs `background_review`).

Diverges: the gate covers only its own memory and skill writes, it is off by
default (`write_approval: false`), and there are no typed action items or render
contract. Everything else executes directly.

### openhuman

https://github.com/tinyhumansai/openhuman

35,113 stars, GPL-3.0, created 2026-02-18, `v0.61.8` on 2026-07-17, self-labelled
"Early Beta". Rust plus Tauri desktop app.

The nearest competitor on *positioning and data stack*. On-device encrypted store,
"Memory Trees" compressed into markdown in a Karpathy-style Obsidian wiki, Obsidian
vault sync, native IMAP/SMTP, 17 messaging channels including Telegram, and it
joins Meet/Zoom/Teams/Webex natively, which eats the Fireflies use case. One-switch
Privacy Mode where no inference leaves the machine.

Approval components exist (`ApprovalRequestCard.tsx`, `FlowApprovalRequestCard.tsx`,
`FlowRunPendingApprovalCard.tsx`) and workflows are described as "durable,
trigger-driven, approval-gated" with "the agent proposes the workflow; you review
it on a canvas and save it". But approvals are inline chat cards, not a persistent
backlog. Its recipe `manifest.json` is trivially thin (`id`, `name`, `version`,
`serviceURL`, `icon`). Adoption claims (100+ OAuth integrations, 5,000+ MCP servers,
90,000+ skills) are marketing and were not verified.

### openfang

https://github.com/RightNow-AI/openfang

18,037 stars, Rust, created 2026-02-24, `v0.6.9` on 2026-05-12, pushed 2026-07-02.
Self-described "The Agent Operating System", 137k LOC, 14 crates, single ~32MB
binary. Their own README says pre-1.0, pin to a commit for production.

Best kernel-level approval implementation found anywhere.
`crates/openfang-types/src/approval.rs`: "When an agent attempts a dangerous
operation, the kernel creates an `ApprovalRequest` and pauses the agent until a
human operator responds."

- `RiskLevel { Low, Medium, High, Critical }`, a real typed risk taxonomy.
- `ApprovalDecision { Approved, Denied, TimedOut }`, fail-closed, `MIN_TIMEOUT_SECS
  = 10`, `MAX_TIMEOUT_SECS = 300`.
- `ApprovalRequest { id: Uuid, agent_id, tool_name, description, action_summary,
  risk_level, requested_at, timeout_secs }`.
- Underneath, `tool_policy.rs` does deny-wins glob-pattern resolution with
  agent-level and global rules, group expansion, `subagent_max_depth`.
- Merkle hash-chain audit trail.
- `HAND.toml` manifest declares `tools` allowlist, `[[requires]]` blocks with
  per-platform install commands, `[[settings]]`.
- The Browser Hand has an `approval_mode` toggle, "Require explicit user
  confirmation before completing any purchase or payment". The Twitter Hand has an
  approval queue.

Diverges: approval keys on tool name and glob pattern, not abstract action type.
`RiskLevel` is attached to the request, not routed. The purchase gate is a per-Hand
boolean, not a system-wide semantic policy. Approval is one of sixteen subsystems
layered onto an autonomy-first design.

### Patchwork OS

https://github.com/Oolab-labs/patchwork-os

28 stars, MIT, created 2026-04-17, TypeScript, 2,091 commits, 107 tags,
`1.1.0-beta.4` on 2026-07-17. Bus factor 1. Its README ends "a star is the only
signal I get that it's helping."

Independently arrived at Samaritan's exact premise: a local runtime that "sits
between an agent's decision and the action" so that "anything consequential stops
and asks you first". Local bridge plus Next.js dashboard on localhost:3200, state
in `~/.patchwork`, telemetry off by default.

Three JSON-Schema'd contracts. Recipes (`schemas/recipe.v1.json`) require `name`,
`trigger`, `steps`, and support `maxConcurrency`, `maxDepth`, `context`, `expect`,
`output`, `on_error`, `budget` (tokensMax and usdMax, halting with
`budget_exceeded`), `servers`. Seven trigger types: webhook, cron, file_watch,
git_hook, on_recipe_save, on_test_run, manual. Recipe packages declare `connectors`,
which is Samaritan's `requires_capabilities`. Plugins declare a `permissions` field
of capability tokens validated against `KNOWN_PLUGIN_CAPABILITIES`, and the docs are
honest that "the allowlist starts empty and grows deliberately as bridge enforcement
for each capability lands" (declared, validated, not yet enforced).

It has a literal approval queue at `/approvals` with per-item detail pages, a
`RiskMeter`, a `CountdownTimer`, batch decide, SSE streaming, mobile push approvals
via PWA, and an explainability endpoint. Requests "arrive sorted by blast radius
with evidence inline". Plus a **worker trust ramp**: named agents "start supervised
and earn independence from their track record. One bad high-stakes action outweighs
a hundred trivial successes."

Two ideas Samaritan does not have: blast-radius sorting of the queue, and earned
autonomy actually implemented. It borrows Claude Code's `allow/ask/deny` instead of
owning a policy engine, and is developer/IDE-centric rather than personal-life
centric. At 28 stars it is a design reference, not a competitor.

## Tier 1: partial matches

| Project | Stars | Overlap | Gap |
|---|---|---|---|
| **nanobot** (HKUDS) | 45,914 | Local gateway on :8765, `~/.nanobot/`, Telegram/Discord/Slack/WeChat/Feishu, cron, MCP, Ollama, ships Agent Skills | No approval inbox anywhere in the tree. No action store |
| **Agent Zero** | 18,457 | Richest `SKILL.md` frontmatter found: `name`, `description`, `version`, `author`, `license`, `tags`, `triggers`, `allowed_tools`, `metadata` | No approval gate at all. Safety is *recovery* (Time Travel snapshots), the philosophical opposite |
| **Goose** (Block) | 51,312 | Four permission modes incl. **Smart Approval** ("risk-based, automatically approve low-risk actions and flag others"). Recipes as YAML manifests with `parameters`, `response` schema, `sub_recipes` | No trigger field, no policy field in the recipe, approvals are inline per-call, no persistent queue |
| **LifeOS** (Miessler) | 16,815 | "Pulse" unified daemon on port 31337: voice, hooks, observability, cron, dashboard, Telegram/iMessage bridges. Typed memory tree, git-backed | Consent is asked at install time. No runtime review inbox, no policy engine, no action store. Cloud-model-primary |
| **LangGraph Agent Inbox** | 1,032 | The Action Center's data model: `HumanInterrupt`, `HumanInterruptConfig` with `allow_ignore/respond/edit/accept`, `HumanResponse` with `accept/ignore/response/edit` | No releases ever. Next.js frontend with no backend, polls a LangGraph deployment, config in browser localStorage |
| **Gumloop** | n/a | The only commercial product with both a documented cross-agent approval queue ("across all your agents in one place") and genuinely typed rendering (email card, GitHub card, code-exec preview). CEL App Rules evaluated at runtime | Rules are author-written, not scored. Reflections confidence scoring is scoped to improving its own instructions, not gating live actions |
| **Lilo** (abi) | 42 | Single-user, self-hosted, Telegram-native, explicitly "not multi-tenant SaaS". Workspace apps with `index.html` plus `manifest.json` is the closest anyone comes to a render schema | Zero approval surface. README warns "the agent has shell, filesystem, and network access. Prompt injection is a real risk" |
| **Istota** | 10 | Strikingly Samaritan-shaped skeleton: scheduler claims tasks from a **SQLite queue**, ingress via chat/IMAP/TASKS.md file watching/REPL/CLI, ~35 skills auto-excluded when deps are missing | Nextcloud-centric, not Obsidian/Notion. "Emissaries" ethics layer is not a review inbox. Unverified in code |
| **Ambiance** (White Matter Labs) | 66 | Strongest philosophical sibling. Python kernel as "a tiny Unix system", `src/sbin/` privileged tools, userspace packages from a registry. Per-channel outbound gating `no`/`ask`/`yes` | "No database. No SaaS. The filesystem is the data structure." Manifest format undocumented. Channel-scoped, not item-scoped |
| **Carapace** | 47 | The security-hardened answer to OpenClaw's CVEs: Ed25519-signed plugins, WASM capability sandbox, resource limits, 127.0.0.1-only, OS keychain | Most rigorous plugin capability model in the field, but no action-item queue and no PKM integration |
| **Orbital** | 107 | Three autonomy presets (Hands-off / Check-in / Supervised), approval cards on desktop and mobile, auto-approve windows, sub-agents register via manifest | Project/coding-agent orchestration. Optional cloud relay for approvals |
| **Dify** | 149,418 | Best capability-permission manifest: `resource.permission.{tool,model,node,endpoint,app,storage}` grants enforced by a plugin daemon. 2026 plugin types now include Triggers and Datasources | ~15 containers, Postgres and Redis mandatory, signature verification on by default. The opposite of local-first. Human Input node closes after first response |
| **n8n** | 197,115 | SQLite by default, `npx n8n`, Send-and-Wait approval across 9 channels including Telegram, usable as an agent tool | Approval is per-paused-execution with no aggregate queue. Node manifests declare no policy. Audit log streaming is Enterprise-only |
| **Khoj** | 35,883 | Closest on the knowledge axis: Obsidian, Notion, local corpus, multi-surface | Agents are UI-configured DB objects, not manifest folders. Automations are query plus cron plus email. No approval surface, no action store |
| **Letta** | 23,872 | Best-specified tool-approval protocol: `default_requires_approval`, `approval_request_message`, `stop_reason: "requires_approval"`, deny-with-reason feeding back to the agent | API-only, no UI. Blocks rather than queues. CLI defaults to unrestricted. Mods can rewrite permission policy. Company abandoned the OS framing and is now "a lab building digital people" |

## The agent-runtime cluster: closer than expected

A late pass over the products usually dismissed as "chat clients with plugin
loaders" found three that are materially closer to Samaritan than the personal-OS
projects above, plus the single sharpest validation finding in the whole scan.

### Goose (Block)

https://github.com/block/goose · 51,312 stars, 5,636 forks, 450 contributors,
Apache-2.0, Rust, `v1.43.0` on 2026-07-14, **45 releases in 2026 alone**. Backed by
Block, free, no paid tier.

**Arguably the single closest system to Samaritan overall.** Store is SQLite at
`~/.local/share/goose/sessions/sessions.db` (migrated from JSONL in v1.10.0), config
at `~/.config/goose/config.yaml`. "goose is a local application and all goose log
files are stored locally. These logs are never sent to external servers." `goose
serve --host 0.0.0.0 --tls` with a server secret is the direct analogue of
Samaritan's Tailscale reach. Ollama supported including a tool-shim for weak local
models.

Four named permission modes, the best-documented in the field: **Completely
Autonomous**, **Manual Approval**, **Smart Approval** ("uses a risk-based approach
to automatically approve low-risk actions and flag others"), **Chat Only**. Set via
`GOOSE_MODE` or `/mode smart_approve`. Under it, per-tool **Always Allow / Ask
Before / Never Allow** persisted in `permission.yaml`. Plus **Adversary Mode**, "a
silent, independent agent reviewer that watches tool calls before they execute",
rules in `~/.config/goose/adversary.md`, returning ALLOW or BLOCK. Plus a `hooks.json`
lifecycle layer where `PreToolUse` can block via exit code 2 or
`{"decision":"block","reason":"..."}`.

Recipes are the manifest analogue: `title`, `description`, `instructions`,
`activities`, `extensions`, `parameters` (with `requirement` in
`required|optional|user_prompt`), **`response.json_schema`** for structured output,
`retry` with `checks` and `on_failure`, `settings`, `sub_recipes`.

Two caveats worth stating plainly. **Autonomous Mode is the default**, and the docs
say so: "goose can execute commands and modify files without your approval." And
**Adversary Mode is fail-open**: "If the reviewer fails for any reason, the tool call
is allowed through." Hooks fail open too.

Diverges on the two load-bearing ideas: manifests declare no emitted action-item
types and no render schema, and approval is a synchronous in-session prompt, not an
async queue. Also developer-workstation-shaped: no Obsidian, Notion, TickTick or
Fireflies story.

### Sim

https://github.com/simstudioai/sim · 29,165 stars, Apache-2.0, `v0.7.39` on
2026-07-18, near-daily releases. YC Spring 2025, $7M Series A announced 2025-11-12,
team of 6.

**The only product with a genuine durable async pause queue.** Two separate tables:
`paused_executions` with `executionSnapshot jsonb`, `pausePoints jsonb`,
`totalPauseCount`, `resumedCount`, `expiresAt`, and `nextResumeAt` (commented "NULL
for human-only pauses"); plus `resume_queue` with `resumeInput jsonb`, `status`
default `'pending'`, `queuedAt`, `claimedAt`, `failureReason`. Separately,
`workflow_execution_logs` is the after-the-fact audit. Samaritan's instinct to keep
the proposal queue and the audit ledger as distinct tables is validated here.

Its `human_in_the_loop` block is a real first-class feature with a notification
config and an `inputFormat` defining the fields the approver fills in, surfaced
through an "Approval Portal" with a unique per-block-instance URL and alerts via
Slack, Gmail, Teams or SMS. Pauses are indefinite.

`BlockConfig` is a rich contract (~250 blocks including `notion.ts`, `obsidian.ts`,
`fireflies.ts`, `telegram.ts`; notably no TickTick) declaring `category`,
`triggerAllowed`, `authMode`, `tools.access`, typed `inputs`/`outputs`, and render
fields (`subBlocks`, `icon`, `bgColor`).

Diverges hard: **approval is opt-in per workflow**, and the surface is a per-run
portal URL rather than a central inbox. Omit the block and agents write to Notion
directly. Self-host needs Postgres with pgvector, 12GB+ RAM, and a sim.ai account
for Chat keys. Audit logging and custom blocks sit behind a proprietary enterprise
license in `apps/sim/ee/`.

### LobeHub (formerly Lobe Chat)

https://github.com/lobehub/lobehub · 80,555 stars, `v2.2.10` on 2026-07-10. **No
longer a chat UI**: "your Chief Agent Operator, organizing your agents into 7x24
operations." License is the non-OSI "LobeHub Community License".

**The most explicitly declarative human-intervention policy found anywhere:**

```ts
export type HumanInterventionPolicy =
  | 'never'      // Never intervene, auto-execute
  | 'required'   // Need intervention (can be bypassed by user's auto-run mode)
  | 'always';    // Always need intervention (cannot be bypassed by auto-run mode)
```

That `always` tier, explicitly non-bypassable by autonomy mode, is Samaritan's
`payment.make` lock expressed as a manifest field. It sits on
`LobeChatPluginApi` alongside `renderDisplayControl` ('collapsed' | 'expand' |
'alwaysExpand') and `work` (`{action: 'create'|'update'|'delete', resourceType:
'document'|'task'}`), with parameter-level matchers (`exact | prefix | wildcard |
regex`), a security blacklist overriding user settings, and global audit resolvers
that run for every tool call. `message_plugins.intervention jsonb` persists
`status` in `pending | approved | rejected | aborted | none`.

Two limits: `humanIntervention` lives on `BuiltinToolManifest` only, so third-party
and MCP manifests do not carry it, and the gate is a prompt on a live run rather
than an async proposal. Deployment is the opposite of Samaritan's: Postgres, Redis,
S3, SearXNG, multi-tenant.

### Kortix (formerly Suna)

`kortix-ai/suna` rebranded to Kortix around 2026-06-06; the Python/Supabase Suna app
is gone, replaced by a TypeScript monorepo wrapping OpenCode. 20,000 stars,
`v0.10.12` on 2026-07-19.

Structurally the closest manifest to Samaritan's. `packages/manifest-schema`
publishes JSON Schema; `kortix.yaml` v2 requires `kortix_version`, `default_agent`,
`agents`. Triggers are declared: `TRIGGER_TYPES = ['cron', 'webhook']` with `slug`,
`session_mode` in `fresh|reuse|pinned`, `prompt_template`, `timezone`, `secret_env`.
**Connectors carry policy**: `policies: [{match, action}]` where
`CONNECTOR_POLICY_ACTIONS = ['always_run', 'require_approval', 'block']`.

Its "Review Center" design doc reads like an Action Center spec: `ReviewKind =
'change' | 'approval' | 'output' | 'decision' | 'batch'`, `ReviewRisk`,
`ReviewStatus` including `'needs_you'`, with the stated goal of "one friendly review
center / inbox where a non-engineer can see what happened and act on it."

**But the design doc's own self-audit says the matching path does not work.**
Tool-call approvals are "Stub. Policy resolves `always_run | require_approval |
block`; on `require_approval` the gateway records `pending_approval` and returns HTTP
202, no UI, no bulk, no resume." Review Center sits behind an experimental flag, and
the default shipped agent prompt says "You don't need approval for routine actions."
Not local-first in any sense: mandatory Supabase, mandatory third-party cloud
sandboxes (Daytona/E2B), mandatory public internet ingress on 80 and 443. Its "fully
air-gapped" README claim is contradicted by its own self-host requirements.

### The sharpest validation finding in the entire scan

**AnythingLLM** (63,585 stars, MIT, SQLite plus LanceDB, genuinely local-first) has
the only approval primitive callable from third-party skill code:
`this.requestToolApproval({payload, description})`, with the skill name
closure-captured "so a skill cannot spoof another tool's name to bypass its own
approval." Its capability contract is a real folder manifest:
`storage/plugins/agent-skills/<hubId>/` with `plugin.json` plus `handler.js`, scanned
at runtime, zero core code changes.

Then the source comment: **"When no approval channel exists (e.g. scheduled jobs) it
resolves approved so the skill still runs."**

Cron-triggered agents auto-approve everything. The one product with a skill-invocable
approval API disables it in exactly the unattended scenario Samaritan exists for.
Its approval is also an in-memory Promise over a live websocket (socket dies,
approval lost) and times out to *denied* rather than *pending*.

The same failure pattern repeats: Kortix's `require_answer` path returns 202 with no
resume, Goose's Adversary Mode and `PreToolUse` hooks both fail open by design, and
ZeroClaw's unanswered approvals equal denied. **Nobody has solved the unattended
case, which is the case Samaritan is entirely built for.** This is a stronger
argument for the Action Center than any feature-gap table.

### Category corrections worth recording

Four premises that are now out of date and should not be repeated:

- **Suna no longer exists.** It is Kortix; kortix.com is the live domain.
- **OpenHands microagents are deprecated**, replaced by AgentSkills.
  `All-Hands-AI/OpenHands` redirects to `OpenHands/OpenHands`, and the code is
  migrating out to `software-agent-sdk` and `agent-canvas`. The 81k-star repo is
  becoming a shell; `agent-canvas` at 201 stars is the real current signal.
- **Lobe Chat is LobeHub**, and is no longer OSI open source.
- **Onit is dormant.** Its default branch has 15 commits total, all in one week of
  June 2026 after a force-reset; getonit.ai 301-redirects to cloudless.so, a voice
  dictation product. Its "Computer Use & Agents" roadmap item is unshipped after two
  years.

Also worth noting for completeness: LibreChat was **acquired by ClickHouse**
(announced 2025-11-04). Its new hash-chained audit log declares categories including
`'approval'` but only `grant.assigned` and `grant.removed` are actually written.
Jan's parent, Menlo Research, appears to have pivoted to robotics and does not
mention Jan anywhere on menlo.ai. ClaraVerse dropped both n8n and ComfyUI, is now a
7-container multi-user Go server with hardcoded tools, and its "zero-knowledge,
browser-local storage" README claim is contradicted by an `ENCRYPTION_MASTER_KEY` for
server-side MongoDB conversations.

## Enterprise and identity clusters: nothing close

**Enterprise agent platforms.** Every vendor implements either admin-authored
deterministic rules or an LLM classifier at one fixed pipeline stage.

- **ServiceNow Intelligent Approvals** (GA May 2026) is the closest: it evaluates
  approvals against policy criteria at runtime with "test-time confidence scoring"
  and routes uncertain decisions to a human. One confidence axis against
  admin-authored policy documents, not decomposed reversibility and blast radius.
- **Google Gemini Enterprise Inbox** is the only genuine cross-agent inbox in the
  enterprise field: "Needs your input", "Errors", "Completed", filterable by agent,
  department or risk level. But HITL is a node a builder inserts, not a scored gate.
- **Microsoft Copilot Studio** multistage approvals are design-time, still in
  preview as of June 2026. Separately, the **Microsoft Agent Governance Toolkit**
  (open source, ~4.9k stars) is the only thing in the entire scan with
  **chained-hash tamper-evident audit records**, a deterministic Rust policy engine
  intercepting tool calls, and `require_approval` with approver groups. Enterprise
  middleware keyed on tool names, and a library you integrate yourself.
- **Windows On-Device Agent Registry** is the most substantive OS-level agent work
  shipped: `odr.exe`, MCP servers in a separate Windows session under a separate
  user account, MSIX identity plus `manifest.json`. But consent is coarse and
  install-time: "Permissions to user files are granted for the host and not per
  server."
- **AWS Bedrock AgentCore Policy** (GA 2026-03-03) uses Cedar with an automated
  reasoning validator that rejects overly permissive or never-satisfiable policies
  *at authoring time*. That is the only load-time policy refusal found anywhere.
  User Confirmation and Return of Control are per-tool design-time flags.
- Workday and Oracle are hardcoded thresholds and "preset guardrails". SAP admits
  Joule Studio is underused and is rushing a 2.0. Salesforce Trust Layer is
  admin-configured guardrails routing into Omni-Channel conversation routing.
  Atlassian Rovo is thin, and Atlassian's stated 2026 direction is "course-
  correction rather than approval gates", i.e. away from Samaritan's premise.

**Agentic identity and authorization.** Auth0's CIBA async authorization (GA
2025-11-19), WorkOS, Descope Agentic Identity Hub 2.5, Stytch Connected Apps, Okta
for AI Agents (GA 2026-04-30), Arcade.dev, Composio, Permit.io. All collapse
"should a human review this" into a static, pre-declared property of a tool or
scope. WorkOS says the quiet part out loud: "your CIBA integration needs a risk
evaluation layer that decides which tool calls need human approval. Start simple: a
static list of tool names that always require approval." Auth0's Rich Authorization
Requests give genuinely typed rendering ("Approve payment of $50.00 to
ExampleCorp"). Arcade's read/draft/commit gradient is the closest thing to
Samaritan's execution modes.

The "agent firewall" category consolidated hard around blocking and DLP, with three
acquisitions in a year (Snyk/Invariant, Cato/Aim, F5/CalypsoAI), and none of the
acquirers pivoted toward a human-approval queue. Stopping bad things is a
structurally different problem from routing uncertain-but-legitimate things.

## The five platform vendors

Scored on the two mechanisms Samaritan cares about: an OS-level human-approval
primitive, and an execution registry mapping abstract action type to provider,
account and mode.

| | Approval primitive | Granularity | Registry | Taxonomy | Accounts | Modes |
|---|---|---|---|---|---|---|
| **Microsoft** | Resource-capability consent + per-agent folder policy (Allow Always / Ask every time / Never allow) | **Per resource class, per host app** | **ODR** (`odr.exe`) + Agent 365 registry | No, app-scoped ids | No | No |
| **Google** | **None at the typed layer.** Docs tell app devs to build their own | n/a | **`AppFunctionSearchSpec`** (category, name, minVersion, live change Flow) | No, empty extension point | No | No |
| **Apple** | `requestConfirmation(conditions:)`, app-initiated, default `[]`; `IntentAuthenticationPolicy` defaults to `.alwaysAllowed` | Per intent, developer-declared | Closed, resolved inside Apple Intelligence | **Yes: 15 schema domains, compiler-enforced** | No | No |
| **OpenAI** | Per-plugin tier (always / before changes / before important changes), **keyed off `destructiveHint` / `readOnlyHint`** | Per plugin, per tool in API | Connector Registry (beta 9 months) | No | Yes, RBAC | Partial, split consumer/API |
| **Anthropic** | 6 modes, allow/ask/deny rules, 30 hook events with `allow\|deny\|ask\|defer`, auto-mode classifier, `user.tool_confirmation` queue | Per tool call, per parameter | MCP registry (metadata only) / vaults | No | **Yes, vaults** | No |

Four things worth taking from this table.

**Nobody has a per-action confirmation that is both mandatory and OS-enforced.**
Microsoft's is per-resource and, in their own words, "granted for the host and
not per server", so one consent transitively covers every MCP server that host
loads. Apple's and Google's are developer-opt-in. OpenAI's and Anthropic's are
host-enforced client-side; Anthropic states plainly that managed settings
"operate as a client-side control, not a security boundary."

**Nobody has all four registry columns.** Google has the best query interface with
nothing to query. Apple has the only real action taxonomy and no way to address
it from another process. OpenAI and Anthropic have the only account bindings,
both in beta. Microsoft has the only shipped OS-level registry and no taxonomy.

**The strongest counter-evidence to Samaritan's premise comes from Anthropic.**
Their measurement of per-action confirmation found users approve roughly **93% of
prompts**. They treat that as a failing control, which is why auto mode exists.
Auto mode's own published numbers: 0.4% false-positive rate on 10,000 real
traffic samples, but **17% false-negative rate on 52 genuinely overeager
actions**. And their unattended product, Routines, has no approval layer at all
("no permission-mode picker and no approval prompts during a run"). If the design
that most resembles a mature version of Samaritan's gate was measured and
abandoned by the vendor that built it, that is worth sitting with.

**Five specific mechanisms worth stealing:**

- **Google's `AppFunctionSearchSpec` query shape** — ask "who implements
  category=note, name=findNotes, version>=2" and get providers with typed
  metadata plus a live change stream. That is the execution registry's read API.
- **Apple's all-or-nothing domain conformance** — support one schema in a domain
  and Xcode errors until you support all of them, with a Fix-It that stubs the
  rest. A capability that claims `notion.*` should have to implement the whole
  namespace.
- **Microsoft's `static_responses` capability pinning** — the manifest carries the
  server's full `initialize` and `tools/list` responses, and a server that
  dynamically changes its tools drops out of contained mode. Structurally defeats
  rug-pull tool poisoning. Samaritan's registry could pin a capability's declared
  emitted types the same way.
- **Anthropic's egress-substituted credentials** — the sandbox holds an opaque
  placeholder; the real secret is injected by the proxy at egress, scoped by
  allowed hosts. "The agent never sees the secret value."
- **Google AP2's open/closed mandate split** — the user signs an *open* mandate
  with constraints when not present, and the agent signs the *closed* one on their
  behalf, with the agent's public key bound via the RFC 7800 `cnf` claim. The best
  formal statement anywhere of "I pre-authorized this shape of action." Caveat:
  AP2's own FAQ says reference implementations only, test with fake payment
  methods. It is cited far more often than it is deployed.

Status notes: Windows "Agent Workspace" was announced at Ignite 2025 and is still
Insider-experimental with no developer API. Android App Functions has been in
alpha for 14 months. Apple has no MCP framework
(`developer.apple.com/documentation/mcp` 404s) and the revamped Siri is still
developer-beta only, 25 months after it was announced. OpenAI killed Operator
(7 months), Atlas (9 months) and AgentKit's Agent Builder (8 months to
deprecation). Google killed Project Mariner (4 May 2026).

## Protocol and manifest prior art

**Agent Skills is the one real standardization event.** The format left Anthropic
and lives at agentskills.io (Apache-2.0, 23,234 stars), adopted by ~45 clients
including Cursor, Copilot, VS Code, Gemini CLI, Codex, Goose, OpenHands, Letta, and
both ZeroClaw and nanobot. The complete normative frontmatter is six fields:
`name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`. Only
the first two are required. `allowed-tools` is experimental and in Claude Code is
prompt suppression, not enforcement.

Everything else declares less. MCP `server.json` has zero permission or policy
fields. MCPB `.mcpb` bundles describe tools as `{name, description}` prose. A2A
Agent Cards declare inbound authentication, not outbound requirements. `agents.json`
and Agent Protocol are both dead (last pushes 2025-08-21 and 2025-04-08).

The single richest published contract is **Microsoft's M365 declarative agent plus
API Plugin manifest v2.4**, the only format where a per-function block carries a
render schema (`capabilities.response_semantics` with an Adaptive Card
`static_template`), a human gate (`capabilities.confirmation` with
`isNonConsequential`), and a policy tag (`security_info.data_handling`:
`GetPublicData | GetPrivateData | DataTransform | DataExport |
ResourceStateUpdate`). Unrecognized properties invalidate the whole document. It
has no triggers, no routing, and no degradation.

Pre-AI prior art is stronger than the agent-era formats on two specific axes.
**Android's `uses-feature android:required="false"`** is the literal ancestor of
`requires_capabilities` plus degrade, and the only manifest attribute anywhere where
soft-requirement degradation is first-class rather than an error path. **VS Code's
`contributes` plus `activationEvents`** (inferred since 1.74) is exactly "declaring
the thing wires the trigger". **Home Assistant** is the only system with a genuine
two-tier dependency semantic: `dependencies` hard-fails, `after_dependencies`
proceeds without it. **Zapier's schema validator**, invoked identically at validate,
build, upload, push and test, is the model for fail-loud manifest validation.

**Faramesh** (arXiv:2601.17744, 96 stars, solo author, Apache-2.0) is the closest
single match to the execution registry idea. A declarative `governance.fms` file in
a DSL with namespaced action identifiers (`service/resource/action`) and
**permit / defer / deny** as first-class decision types, where `defer` means pause
for a human, plus budgets, rate limits, a "non-bypassable Action Authorization
Boundary", a Canonical Action Representation normalizing intent across 13+
frameworks, and hash-chained Decision Provenance Records. It has no manifest half:
policy lives with the operator, not the capability. Its default is deny, the
opposite failure direction. Treat with caution given the solo authorship.

**Claude Code's own permission layer** is the best-shipped analogue to the
execution registry's mode routing, at one abstraction level lower. Rules evaluate
deny then ask then allow, first match wins. Modes are a routed setting. An MCP
server can set `_meta["anthropic/requiresUserInteraction"]: true` in its
`tools/list` entry, and the client then prompts on every call in every mode, never
offers "don't ask again", and allow rules do not skip it. In non-interactive mode
an `allow` result is converted to a deny. Anthropic's own rationale: "Use this for
tools whose permission prompt is itself the point, where auto-approval would mean no
human ever agreed." That is Samaritan's `payment.make` lock, pinned to named tools
rather than an abstract namespace, and failing closed rather than degrading.

**Apple's App Intent Domains** is the closest thing in any market to an abstract
action-type taxonomy shared across applications: standard domains for mail, photos,
browser, files, messages, calendar and reminders that the OS routes to a provider
app without apps coordinating. Paired with `authenticationPolicy` per intent, it is
the strongest consumer-OS precedent for abstract action type plus system-owned
routing plus a per-type human gate.

## What is genuinely unclaimed

1. **An emitted-action-item type with a render schema.** No manifest format anywhere
   declares what a capability *produces* and how a review surface should display it.
   Every format declares what a capability *is*. M365 has the three pieces attached
   to a function rather than to a type registered with the host. LobeHub's
   `renderDisplayControl` is a three-value display hint, not a schema. Sim's
   `subBlocks` render the *configuration form*, not the proposal. This survives 20+
   products and is the sharpest differentiator.

1b. **Approval decoupled from the live run.** Every gate found is either a blocking
   in-conversation prompt (Goose, OpenHands, Cherry Studio, Open WebUI, LibreChat,
   ClaraVerse, ZeroClaw, openfang), an install-time capability grant (Msty, Windows
   ODR, Dreamer), or a per-run portal URL (Sim). Only Sim's `paused_executions` plus
   `resume_queue` is durable and async, and it is opt-in per workflow. Hermes is the
   only project with a restart-surviving multi-item pending store, and it covers two
   subsystems and is off by default.

1c. **The unattended case.** AnythingLLM auto-approves when no approval channel
   exists, which means scheduled jobs. Kortix's `require_approval` returns 202 with
   no resume path. Goose's Adversary Mode and hooks fail open by design. ZeroClaw
   times out to denied. Nobody has a correct answer for "the agent proposed something
   at 3am and nobody was watching," which is Samaritan's entire operating condition.
2. **The execution registry.** Nothing maps an abstract action type to provider plus
   account plus execution mode. Composio and Arcade namespace by provider. UFO's
   `mcp.yaml` routes by app binary. Two 2026 papers name the mechanism (AOS
   arXiv:2606.01508 lists "tool and capability registries"; TopoClaw arXiv:2605.15556
   says "decoupling intent from actuation") and neither ships it.
3. **Degrade to guided.** Universally absent. Claude Code plugin enable fails on a
   missing dependency. Faramesh defaults to deny. agentgateway's ExtMCP returns
   Pass/Mutate/Deny with no approval outcome. Everything fails closed or loud. The
   "no adapter, so show the human what to do" behaviour has no analogue.
4. **Reversibility as a typed schema field** checked structurally at registration,
   independent of a policy author's judgment. No prior art found in code or papers.
5. **Earn-autonomy.** Confirmed absent commercially. Patchwork OS's worker trust ramp
   is the only implementation found, at 28 stars. Gumloop has a manual Review Queue
   to Auto-Apply graduation. Sycamore Labs raised $65M (Coatue, Lightspeed, Sri
   Viswanath) on tiered earned autonomy and is pre-product. Sovereign-OS
   (arXiv:2603.14011) proposes a TrustScore plus a fiscal charter and hardcodes
   Stripe. The best articulation found anywhere is practitioner writing on
   **asymmetric promote/demote**: promotion requires both empirical evidence and
   recorded human authorization; demotion is automatic when quality degrades, without
   waiting for human action.

Weakest novelty claims, where real precedent exists and should be acknowledged:

- **The capability manifest itself.** ZeroClaw's `SOP.toml` shipped triggers, named
  approval policies and typed step input/output. Kortix's `kortix.yaml` shipped
  declared triggers plus connector policies. Msty Claw's `manifest.json` shipped the
  richest permission and `triggerProviders` block. AnythingLLM shipped folder-scanned
  `plugin.json` with zero core code changes.
- **Declarative per-action human-intervention policy.** LobeHub's
  `HumanInterventionPolicy` (`never | required | always`, where `always` explicitly
  cannot be bypassed by auto-run mode) is Samaritan's money lock as a manifest field.
- **Risk-based routing.** Goose's Smart Approval and OpenHands' `ConfirmRisky()` plus
  `LLMSecurityAnalyzer` both score risk per call.
- **A durable pause queue separate from the audit log.** Sim's `paused_executions`
  plus `resume_queue` versus `workflow_execution_logs`.
- **Per-item render plus confirmation plus policy tag.** M365 has all three.
- **Fail-loud manifest validation.** Zapier, M365, Claude Code.
- **Always-human pinning that survives every autonomy mode.** Claude Code's
  `requiresUserInteraction`.

What remains is the *combination*: a capability that declares the typed items it
emits and how to render them, feeding a policy engine that scores each item, routing
through a registry that resolves abstract action types to a provider and a mode, with
a degrade path and structural invariants. No single system has more than three of
those five.

## Market signals that cut against the thesis

**The pure approval-infrastructure play has been tried and abandoned.** HumanLayer
(YC F24) sold exactly this: an API letting agents pause and request human approval
before consequential actions. Its SDK was deprecated and removed; it is now
CodeLayer, an AI coding IDE at $100/user/month. Read it as a warning about
approvals-as-a-product, not approvals-as-an-architecture.

**Relay.app is shutting down.** Announced 2026-07-16, four days before this scan.
Free accounts terminate 2026-08-15, paid 2026-09-14, no acquirer. Its entire
positioning was human-in-the-loop automation, with four HITL step types and
Slack-native interactive approvals. It had finished democratizing HITL across all
plans in March 2026, four months before announcing the shutdown.

**Inbox Zero shipped an approval queue and killed it.** 11,675 stars, AGPL-3.0,
commercially backed, 100+ commits in 90 days. Its Prisma schema still carries the
tombstone:

```prisma
enum ExecutedRuleStatus {
  APPLIED
  APPLYING
  REJECTED // @deprecated - No longer created. Kept for historical data only.
  PENDING  // @deprecated - No longer created. Kept for historical data only.
  SKIPPED
  ERROR
}
```

What replaced it: **Gmail drafts as the approval surface** (the agent writes a
draft; your mail client *is* the review inbox) and **delayed actions**, an
`Action.delayInMinutes` field from 1 minute to 90 days, queued via a
`ScheduledAction` model. A cancel-window rather than an approve-gate. Notably they
**kept the audit ledger and dropped the gate**.

**Dreamer (/dev/agents) survived five weeks.** $56M seed at $500M post in Nov 2024
(Index and CapitalG, angels including Karpathy), founders from Stripe, Android,
Oculus and Google Design. Launched publicly 2026-02-17. Meta acqui-hired the team
around 2026-03-23. Its architecture was the best capability-confinement design in
the category: GUI = dreamer.com, user space = Agents, kernel = Sidekick, drivers =
Tools, with kernel-mediated memory where only Sidekick has full access and agents
receive only the fields they need, checked against their declared purpose.

**LangChain's ambient-agent wave decayed.** `executive-ai-assistant` archived
2026-03-09, `open-agent-platform` archived 2026-02-25, `deep-agents-ui` archived
2026-06-21, `agents-from-scratch` has had one commit in 90 days and it added a
LICENSE. Investment moved to `deepagents` (26,543 stars).

**Home Assistant, the most mature local-first system anywhere, declined to build an
approval layer** and shipped no AI headline feature across all seven 2026 releases.
Its LLM tool calls actuate directly with no confirmation step.

Counterweight: **EU AI Act Article 14 enforcement begins 2026-08-02**, fines up to
€35M or 6% of global turnover, with deployers required to assign oversight to
competent, trained, authorized humans. Gartner named "Guardian Agents" (Market Guide
early March 2026) and Forrester named the "Agentic Control Plane" (Q2 2026, 33
vendors). Both categories are inventory-and-observability-first, not approval-first.

## Concrete things to steal

1. **ZeroClaw's `max_pending_approvals` backpressure.** Triggers deferred, never
   silently dropped. Samaritan's Action Center will hit this failure mode.
2. **openfang's approval timeout.** `TimedOut` as a first-class decision with a
   10-300s bound, failing closed. The only fail-closed default in the field.
   Samaritan has no answer today for an item that sits forever.
3. **LangGraph's `HumanInterruptConfig`.** Per-item `allow_ignore/respond/edit/accept`
   is a richer response vocabulary than approve/edit/reject and is more expressive
   than a per-capability setting.
4. **Patchwork's blast-radius-sorted queue** with evidence inline, and its asymmetric
   trust ramp: "One bad high-stakes action outweighs a hundred trivial successes."
5. **Shadow-git checkpoints** (Vault Operator does this for Obsidian). Approval
   prevents bad writes. It does nothing about approved-but-wrong ones.
6. **LobeHub's non-bypassable tier.** `never | required | always`, where `always`
   "cannot be bypassed by auto-run mode", is a cleaner expression of the money lock
   than checking it in three places, and it generalizes past money.
7. **Sim's two-table split.** `paused_executions` (snapshot, pause points, expiry,
   `nextResumeAt` null for human-only pauses) separate from
   `workflow_execution_logs`. Samaritan already separates these; Sim's schema is
   worth reading for the fields, especially `expiresAt` and resume counters.
8. **Goose's mode vocabulary.** "Smart Approval" as a user-facing name for
   risk-based routing is better than anything in Samaritan's docs, and its per-tool
   Always Allow / Ask Before / Never Allow override layer under the global mode is
   the right shape for eventual earn-autonomy.
9. **Inbox Zero's two escape hatches**, designed in from day one rather than
   discovered after the queue fails: render high-confidence items into their *native*
   surface (a Gmail draft, a calendar hold, a TickTick task) instead of a generic
   inbox row, and support "auto-approve after N minutes unless I object" as a
   first-class policy tier alongside allow/ask/deny. OpenClaw's `auto` mode and
   Orbital's auto-approve windows converged on the same idea independently.

## Correction to the PRFAQ

`docs/PRFAQ.md` claims "agent frameworks give you a loop but no opinion on human
oversight". That is now half wrong. Letta, OpenAI's Agents SDK, LangChain v1's
`HumanInTheLoopMiddleware`, Goose's Smart Approval, and Claude Code all ship
per-tool approval flags. What none of them ship is a policy engine deciding *per
item*, which is a sharper and more defensible claim than the one currently written.

Similarly, "why build this vs buy an off-the-shelf agentic OS" should now name
OpenClaw and ZeroClaw directly rather than gesturing at "off-the-shelf tools",
because both exist, both are enormous, and the honest answer is that they gate on
danger (shell exec, destructiveness) rather than on a declared per-capability policy
over typed proposals.

## Verification gaps

- Star counts of 383k (OpenClaw), 46k (nanobot), 35k (openhuman) and 32k (ZeroClaw)
  all accrued within roughly six months and should be read as hype-curve numbers,
  not adoption numbers.
- Ambiance's `pairegistry` manifest format, Frona's skill file format, and Istota's
  "Emissaries" layer are referenced in docs but undocumented in detail.
- Rewind.ai/Limitless acquisition by Meta, the Manus/NDRC/Meta sequence, and several
  funding figures rest on secondary sources.
- Msty, Cherry Studio, Clara, Onit, Sim, LibreChat, Lobe Chat, AnythingLLM and Jan
  were not field-verified; nothing observed suggests they depart from the
  chat-client-with-plugins pattern, but that is inference.
- Google's consumer agent status (Project Mariner's standing) and Apple's WWDC 2026
  announcements are unverified.
- Faramesh (solo author, self-published preprint) and ACP (arXiv:2603.18829, solo
  author, ten revisions in six weeks) both warrant skepticism.
