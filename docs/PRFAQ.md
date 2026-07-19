---
title: Samaritan — PRFAQ (Press Release + FAQ)
subtitle: Working backwards from the Action Center
owner: Sandip Dev
status: Draft v0.1
date: 2026-07-19
---

# Samaritan — PRFAQ (Press Release + FAQ)

*Companion to PRD.md, TECH-REQUIREMENTS.md, TECH-SPEC.md, UI-SPEC.md. Written working-backwards, Amazon PRFAQ discipline — scoped to a personal project: the "customer" is Sandip and PM-type power users like him, not an enterprise buyer. The FAQ splits Sandip's questions as a user from his harder questions as the builder.*

---

## Press Release

### Samaritan Ships the Action Center: One Inbox for Everything That Needs Sandip

*A universal human-in-the-loop layer stops agents from writing to Notion before Sandip's seen the row — and replaces seven bots' worth of bespoke notifications with one.*

**OCTOBER 12, 2026** — Sandip Dev today shipped v0 of the Action Center, the core of Samaritan, his personal agentic operating system. The Action Center is a single inbox where everything Samaritan's agents propose that actually needs Sandip's judgment shows up — and nothing else does. The first two capabilities routed through it, `meeting` and `wrap`, are also the two most likely to get something wrong: every Notion row or TickTick task they extract now waits for Sandip to approve, edit, or reject before it's written, instead of landing in his systems of record unreviewed.

Before this, Samaritan's agents had two settings. Zero-inference skills like `capture` and `log` wrote exactly what Sandip told them to — safe, but limited. `meeting` and `wrap`, the two skills that read raw material and decide what counts as a decision, a task, or a person, wrote straight to Notion and TickTick with no check at all — so a mis-extracted task or a hallucinated decision sat in the system of record until Sandip happened to notice. Every new capability he considered — a newsletter digest, an email triage — meant the same design question from scratch: build it a bespoke approval flow, or ship without one and hope. There was no shared answer to "this needs a human"; each agent reinvented the same plumbing, inconsistently.

The Action Center is that shared answer. Capabilities plug in by declaring what they do, what they might get wrong, and how a review should look, in a manifest — not by hand-building their own approval logic. A policy engine reads each proposed action's confidence, reversibility, and blast radius and decides, per item, whether to complete it automatically or put it in front of Sandip. Escalated items land in one Dashboard and Inbox, rendered to match their type — a proposed Notion row looks different from a calendar conflict — and every decision, automatic or approved, is logged and later queryable through Ask Samaritan.

Capabilities run on a schedule, an event, or a command like `/meeting`, and hand their output to the policy engine instead of writing directly to Notion or TickTick. Low-risk, reversible, high-confidence items execute automatically; anything uncertain or irreversible escalates to the Inbox with the context behind it — what happened, why it was flagged, what happens if approved. Sandip reviews from his laptop or, through Telegram, from his phone; his response drives execution in guided, assisted, or automated mode. Money never moves automatically, by policy, regardless of confidence.

> "I didn't want an agent that files a Notion row I have to go find and fix later, and I didn't want to hand-build a notification flow for every new skill," said Sandip Dev, who built Samaritan. "The Action Center is what made me trust adding an eighth capability. I'm not reviewing more — the goal is that meeting and wrap escalate less over time — I'm reviewing the right few things instead of guessing which of fifty might be wrong."

> "Most personal-agent setups I've tried are all-or-nothing — either they ask about everything, which is more work than doing it myself, or they act and I find out afterward," said Jordan Reyes, a product manager who piloted an early build of the Action Center on his own meeting notes. "Seeing a proposed Notion row next to the transcript line it came from, with a one-tap edit before it commits, is the first setup that's felt like it reports to me instead of the other way around."

The Action Center runs today alongside Samaritan's other skills, with no change to how `/meeting` or `/wrap` are invoked — the only difference is the proposed row now waits in the Inbox first. A new capability plugs in by dropping a `manifest.yaml` and an entrypoint into `capabilities/`; the OS discovers, validates, and wires it in with no core code changes. The manifest spec and the Action-Item contract are documented in this project's PRD.

The Action Center doesn't make Samaritan do more. It makes Samaritan something Sandip can hand more to — because now there's exactly one place to check, and it only shows up when it actually needs him.

---

## Customer FAQ

**What is Samaritan?**
Samaritan is Sandip's personal agentic OS: a set of capabilities — skills and scheduled agents — that capture thoughts, process meetings, file structured knowledge to Notion and Obsidian, and answer questions across his tools. Its centerpiece is the Action Center, a single inbox where anything an agent proposes that needs Sandip's judgment shows up, gets reviewed, and gets executed. Everything else — safe, reversible, low-stakes actions — happens without him.

**Who is it for?**
One person: Sandip. It's built and tuned around his stack (Obsidian, Notion, TickTick, Fireflies, Gmail, Telegram) and his workflows as a PM — meetings, decisions, weekly reviews, a job search. It's architected the way a platform PM would design something for many capabilities and many users, but it ships single-user by design; who else it might serve is an open question addressed honestly in the Internal FAQ, not a v0/v1 goal.

**How is it different from just using ChatGPT/Claude, or from Zapier/Make, or from a to-do app?**
A chat assistant has no memory of what it filed yesterday and no standing permission to act between sessions — every conversation starts from zero. Zapier/Make will move data between apps all day, but they don't reason about content (was this transcript line actually a decision?) and they don't know when to stop and ask — they always fire or never do. A to-do app is passive; nothing populates or clears it for you. Samaritan reasons like the assistant, executes like the automation tool, and reserves the to-do-list experience for the fraction of items a policy engine — not a person — decided needed a human.

**Do agents act without me?**
Yes, for the low-stakes work: a capture, a log entry, a task that's clearly correct and reversible executes automatically, by policy. Anything the policy engine scores as low-confidence, irreversible, or high blast-radius — which today means every `meeting` and `wrap` extraction, before it reaches Notion or TickTick — doesn't act; it proposes, and sits in the Inbox until Sandip decides. The v0 bar is explicit and binary: no `meeting` or `wrap` row hits Notion without an approve or an edit.

**What happens to money or irreversible actions?**
They're locked to guided mode by policy, independent of how confident the agent is. `payment.make` has no automated or assisted path at all — only a deep link Sandip has to act on himself — and that's a hard rule in the routing config, not a threshold that can quietly drift as confidence scores improve. Irreversible actions more broadly (sending, not drafting; deleting; anything with real blast radius) default to escalate even when the agent is confident.

**Where does my data live? (privacy)**
Local-first, by default and by necessity — Samaritan reads Sandip's Obsidian vault, dev journals, and messages, none of which exist anywhere but his machine. The daemon, the action store, and the web UI run on his own hardware (a laptop today; an always-on Mac mini or home server is the near-term target). Remote access is via Telegram plus a private tunnel (Tailscale or Cloudflare Tunnel), not a hosted server; a cloud VPS was considered and explicitly not chosen for v0/v1 because it would mean tokens and data leaving the machine that owns them.

**What apps does it work with?**
Today: Obsidian, Notion, TickTick, Fireflies, and Telegram, with Gmail and Google Calendar coming online as v1 capabilities. The Execution Registry also lists iMessage and WhatsApp for guided-mode delivery — Samaritan can tell Sandip what to send, it doesn't send WhatsApp messages itself yet. Each integration is registered once, centrally, so adding an app doesn't mean re-plumbing every capability that might use it.

**What does it automate vs. ask me about?**
A policy engine decides per action, not per capability, using confidence, reversibility, and value: roughly, high-confidence + low-blast-radius + reversible auto-completes, everything else escalates. Explicit, zero-inference actions (`capture`, `log`, `file` — Sandip already said exactly what to write) auto-commit with just an audit trail. Extraction actions (`meeting`, `wrap` deciding what counts as a decision or a task) escalate by design today, until the policy engine is mature enough to trust the easy cases automatically — that trust has to be earned, not assumed.

**Does it get better over time?**
That's the intent, not yet the reality. The design goal — "earn-autonomy," thresholds that auto-tune from Sandip's approval history so a capability that's been right fifty times in a row needs him less on the fifty-first — is on the backlog, not in v0/v1. What does exist today is the audit log every decision writes to, which is the raw material that loop will eventually train on.

**What does it cost, and what do I need to run it?**
No new spend beyond what's already running: Claude usage, the Notion/TickTick/Fireflies/Telegram accounts Sandip already has, and a machine that can stay on. v0 leans on Claude's built-in scheduled-tasks feature rather than a custom scheduler, so there's no separate infrastructure for the cron part. A persistent daemon is required for event-driven triggers and push notifications, which means it works best on a machine that's on most of the time — a laptop that's frequently closed will miss events until it reopens.

**What can it NOT do yet?**
No earn-autonomy — every threshold is manually set and static. No remote hosting — it runs where the files are, reached via Telegram and a tunnel, not a hosted service. Single-user only, even though the routing layer is shaped as if it weren't. Only `meeting` and `wrap` are wired through the review gate at launch; newsletter, calendar, email-triage, and job-search capabilities are v1, not v0. And WhatsApp/iMessage sends are guided-only — Samaritan drafts, Sandip sends.

---

## Internal / Stakeholder FAQ

**Why build this vs. buy an off-the-shelf agentic OS?**
Because the interesting problem isn't "run an agent," it's "decide, per action, whether this needs a human, and if so, show it to them in a way that matches the action" — and that's exactly the layer off-the-shelf tools skip. Zapier/Make automate without judgment; agent frameworks give you a loop but no opinion on human oversight; consumer AI assistants don't persist state or own a review surface at all. Building it also turns Sandip's own thinking about platforms — manifests, contracts, policy — into something concrete and testable, which is most of the point of a project like this.

**Why now?**
Because the failure mode showed up empirically, not hypothetically — `meeting` and `wrap` are already writing rows to Notion with no gate, and the OpenClaw confidence-gate prototype already proved the underlying pattern works for one narrow case. The gap between "one prototype for one capability" and "every future capability reinvents this" was about to compound; better to generalize it at seven skills than at twenty.

**What's the single riskiest assumption?**
That a thick manifest — a capability fully declaring its triggers, render schema, and policy up front — is worth the authoring cost, compared to an OS that infers more and asks less of capability authors. If writing a manifest is more friction than just calling the Notion API directly, capabilities won't get built, and a platform with no capabilities isn't a platform. This is untested past two capabilities; v1's newsletter, calendar, email-triage, and job-search additions are the real test of whether the manifest earns its cost at capability five through eight.

**What's the MVP, and why that anchor (the meeting/wrap review gate)?**
v0 is the Action Center, the Action-Item contract, a thin-slice manifest loader, and `wrap` plus `meeting` as the first two producers, with a hard review gate before any Notion or TickTick write. Success is defined narrowly: zero `wrap`/`meeting` rows hit Notion without Sandip's approve or edit. Those two are the anchor because they're the only high-inference skills today — the other five are either zero-inference (safe to auto-commit) or read-only — so the first version of the gate gets tested against real risk instead of a toy case.

**How does pluggability actually work (the contract)?**
A capability is a folder — `capabilities/<id>/manifest.yaml` plus a standard entrypoint, `run(context) -> {action_items, execution_requests, status, logs}`. The manifest declares identity, trigger, context needs, the action-item types it emits (render schema, custom attributes, allowed responses, execution mode, per-type policy), and which execution capabilities it requires. On install, the OS validates the manifest, wires the trigger into the Run Layer, registers the emitted types with the Action Center, and checks requirements against the Execution Registry — a missing integration degrades that action to guided mode rather than failing closed. No core code changes for a new capability, ever — that's the actual test of pluggability.

**What's genuinely hard here (the 20%)?**
Two things. The policy engine's escalation logic — confidence, reversibility, and value are each simple alone, but combining them into thresholds that don't flood the inbox or silently commit garbage is a tuning problem with no shortcut except real usage data. And render schemas that actually generalize — a payment approval, a Notion-row diff, and a calendar conflict are different enough that "card / form / document / diff" may not be an exhaustive set, and getting that wrong means every new capability needs a new render type instead of reusing the four.

**How will we know it's working? (success metrics)**
v0 has one binary condition: zero `wrap`/`meeting` rows land in Notion without an approve or edit. Past that: escalation rate (want it down over time, without losing quality), median decision latency (how long items sit before Sandip acts), edit rate and reject rate (how often the proposal was wrong), and the one to watch hardest — false negatives, things auto-committed that Sandip later has to correct, which is the metric that would mean the policy engine is too permissive. Escalation rate is never optimized alone; a system that escalates nothing and is often wrong is worse than one that escalates a lot and is right.

**What are we explicitly NOT doing in v0/v1?**
Earn-autonomy — designed for, deferred to backlog. Remote or server hosting — local machine only, reached via Telegram and a tunnel, not a hosted VPS. Multi-user or delegation — single-user, even though the routing layer is shaped as if it weren't. And the Action Center doesn't rewrite any existing skill's internal logic; it wraps `meeting` and `wrap`, it doesn't re-architect how they extract.

**What's the path from personal tool to something others could use?**
Honestly, not the current goal — this is a personal tool with platform architecture, not a platform-for-others wearing a personal skin, and pretending otherwise would be over-scoping a project whose actual customer is one person. If it ever went there, the manifest contract and Action-Item schema are the pieces built to survive contact with someone else's tool stack, and the routing config already separates "what a capability needs" from "which account/provider fills that need" — the seam a multi-tenant version would grow from. But that's speculative; nothing in v0/v1 is built with a second user in mind.
