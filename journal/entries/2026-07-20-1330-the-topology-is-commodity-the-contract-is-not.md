# The topology is commodity, the contract is not

2026-07-20 13:30

Previous: [2026-07-20-1055-my-own-fix-was-broken](2026-07-20-1055-my-own-fix-was-broken.md)

I asked whether anyone else is building Samaritan. Eight research agents came
back. The answer is yes on the plumbing and no on the premise, and both halves
are worth writing down.

## What I lost

The topology is gone as a differentiator. OpenClaw has 383,532 stars and is the
most-starred project on GitHub. It is a local Gateway daemon on
`ws://127.0.0.1:18789`, SQLite at `~/.openclaw/state/openclaw.sqlite`, a Control
UI on loopback, 23 messaging channels, remote access over SSH tunnel or
Tailscale, a task ledger and a metadata-only audit ledger. That is my
architecture, line for line, built by someone else, seven months ago, and now
running on more machines than I will ever reach.

ZeroClaw is worse for me. Its `SOP.toml` declares identity, typed triggers,
admission policy, `max_pending_approvals`, and named approval policies with
`quorum` and `escalation_route`. Its `SOP.md` steps carry `requires_confirmation`,
a `policy:` reference, JSONPath guards, and JSON-Schema `input:`/`output:`. That
is most of my manifest, shipped, at 32k stars, in Rust. I had been telling myself
the manifest was the novel part. It is not.

LobeHub has `HumanInterventionPolicy: 'never' | 'required' | 'always'`, where
`always` explicitly cannot be bypassed by auto-run mode. That is my money lock,
expressed as a manifest field, more cleanly than my three-places check.

Goose has four permission modes including a real risk-based one, per-tool
overrides, and a `PreToolUse` hook that can block. openfang has a kernel
`ApprovalRequest` with a typed `RiskLevel` and a `TimedOut` decision that fails
closed. Sim has `paused_executions` plus `resume_queue`, a durable async pause
queue kept separate from the audit log, which is the schema I converged on
independently.

So the honest summary is that I am one of about a dozen people who saw the same
problem, and several of them are further along on pieces I thought were mine.

## What I kept

Nobody declares what a capability emits. Every manifest in the field describes
what a capability *is*. The industry standard, agentskills.io, requires exactly
two fields: `name` and `description`. LobeHub's `renderDisplayControl` is a
three-value display hint. Sim's `subBlocks` render the configuration form, not
the proposal. Twenty products deep, no one has a declared action-item type with
a render schema registered with the host.

Nobody has the execution registry. Nothing maps an abstract action type to a
provider, an account, and an execution mode. Composio and Arcade namespace by
provider. Apple's App Intent Domains is the closest idea anyone has shipped and
it is Apple-only with no account or mode dimension. Two 2026 papers name the
mechanism and neither builds it.

Nobody degrades. Everything fails closed or loud. Claude Code refuses to enable
a plugin with a missing dependency. Faramesh defaults to deny. My
`guided.fallback`, where a missing adapter means the human gets copy-ready text
instead of an error, has no analogue anywhere.

And nobody has solved the unattended case, which is the finding that actually
matters.

## The sentence I did not expect to find

AnythingLLM has the only approval API callable from third-party skill code. Its
source says:

> When no approval channel exists (e.g. scheduled jobs) it resolves approved so
> the skill still runs.

Cron-triggered agents auto-approve everything. Kortix's `require_approval` path
records a pending state, returns HTTP 202, and has no resume; their own design
doc calls it a stub. Goose's Adversary Mode and hooks both fail open by design.
ZeroClaw times out to denied.

The entire field builds approval for a human sitting at a terminal right now.
Samaritan exists for the opposite condition: something proposed at 3am with
nobody watching, waiting until I get to it. That is the gap, and it is a better
argument than any feature table.

## The counter-evidence

I should be honest about the parts that argue against me.

HumanLayer sold approval-as-a-service. Its SDK is deprecated and removed; it is
a coding IDE now. Relay.app, built entirely around human-in-the-loop, announced
a full shutdown four days ago with no acquirer. Dreamer, the best-architected
personal agent OS anyone built, with $56M and founders from Stripe and Android,
launched in February and was acqui-hired by Meta five weeks later. Atlassian's
stated direction is course-correction rather than approval gates. Home Assistant,
the most mature local-first system in existence, deliberately declined to build
an approval layer and shipped no AI headline feature in seven 2026 releases.

Inbox Zero is the sharpest one. They shipped an approval queue and killed it.
The deprecation tombstones are still in their Prisma schema. What replaced it:
Gmail drafts as the approval surface, and a one-minute-to-ninety-day delay window
you can cancel inside. They kept the audit ledger and dropped the gate.

And Anthropic measured their own per-action confirmation and found users approve
about 93% of prompts. They concluded the primitive was failing and replaced it
with a classifier. Their own unattended product, Routines, has no approval layer
at all.

Read together: approvals as a product have failed twice. Approvals as an
architecture are unclaimed. Those are different bets and I am making the second
one. Whether that distinction is real or a story I am telling myself is a
question I should keep open rather than answer today.

## What changes

Four things go on the list.

Backpressure. ZeroClaw's `max_pending_approvals` defers triggers rather than
dropping them. My ingest has no answer for a flood.

Expiry. openfang's `TimedOut` with a 10-300 second bound, failing closed. I have
no answer for an item that sits forever, and "forever" is the default today.

A native-surface escape hatch. Inbox Zero's lesson is that a generic inbox row
is worse than the thing rendered where it belongs. A high-confidence Notion row
could land as a draft I can see in Notion rather than a card in my Inbox. And
"auto-approve in N minutes unless I object" should be a first-class policy tier
next to auto and escalate, not a workaround.

Undo. Approval prevents bad writes. It does nothing about approved-but-wrong
ones. Something like a shadow-git checkpoint for applied writes.

The PRFAQ has been corrected. The claim that agent frameworks have no opinion on
human oversight was true when I wrote it and is not true now, and the
buy-vs-build answer now names OpenClaw and ZeroClaw directly instead of gesturing
at "off-the-shelf tools." A competitive argument that only works if the reader
has not looked is not an argument.

Full scan: `Research/2026-07-20-samaritan-vs-2026-agentic-os-landscape` in the
vault.
