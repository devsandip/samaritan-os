# Consensus coverage audit

Post-consensus analysis by Codex. These labels describe planning coverage, not implemented functionality.

Final source: [PROPOSAL.md v2](../../consensus/PROPOSAL.md).

## What the audit found

36 concerns: 16 designed; 8 partial; 6 deferred; 2 constrained; 4 missing.

Architecture agreement is complete. Full-life workflow specification is not. Office-arrival/commute events, calendar rearrangement, after-workout events and upcoming interviews lack an explicit end-to-end route in the final plan. Claude's later peer message independently flags these gaps. Schedule ownership and stale-output handling also need specification.

## Designed

An explicit decision or mechanism appears in the final proposal. Implementation and validation are still pending.

### Keep the existing system instead of rebuilding

**Plan location:** D1 / D2

Samaritan retains review/policy/UI; SDK provides the tool-using harness.

**Remaining:** A lower-maintenance outcome has not been measured against an alternative runtime.

Sources: [codex/round-1.md, line 43](../../codex/round-1.md); [consensus/PROPOSAL.md, line 74](../../consensus/PROPOSAL.md).

### Cowork-style delegated tasks and continuation

**Plan location:** D1 / D2 + Phase 2

Separate task/run/action concepts, SDK worker, task messages and answer flow.

**Remaining:** Implement and test continuation across disconnections and clients.

Sources: [gemini/round-1.md, line 117](../../gemini/round-1.md); [consensus/PROPOSAL.md, line 102](../../consensus/PROPOSAL.md).

### See every run, including no-op and failure

**Plan location:** D2 + activity_events

Durable run records and an append-only replayable activity ledger.

**Remaining:** Define exact event schemas and external-agent stale-state reconciliation.

Sources: [codex/round-1.md, line 34](../../codex/round-1.md); [consensus/PROPOSAL.md, line 105](../../consensus/PROPOSAL.md).

### Always-on scheduling and duplicate admissions

**Plan location:** G2 + Phase 0

Supervised daemon, stable admission identities and honest restart state.

**Remaining:** Validate clock/timezone, missed runs and multiple simultaneous admissions.

Sources: [codex/repo-audit.md, line 14](../../codex/repo-audit.md); [consensus/PROPOSAL.md, line 99](../../consensus/PROPOSAL.md).

### Stop and timeout actually revoke worker authority

**Plan location:** D9 / G2

Child-process termination and lease/fencing controls.

**Remaining:** Test late emits and distinguish stopping from a verified terminal outcome.

Sources: [codex/build-blueprint.md, line 42](../../codex/build-blueprint.md); [consensus/PROPOSAL.md, line 82](../../consensus/PROPOSAL.md).

### An assistant must not approve its own write

**Plan location:** D4 / D5 / D9

No MCP approval tool; authenticated human actor and exact payload/account/revision.

**Remaining:** Implement server authority checks and prevent access to human approval sessions.

Sources: [gemini/round-1.md, line 144](../../gemini/round-1.md); [consensus/PROPOSAL.md, line 77](../../consensus/PROPOSAL.md).

### Missed notifications must not authorize writes

**Plan location:** D9

Pending items wait or expire; explicit policy handles preauthorized work.

**Remaining:** Test expired approvals and race conditions across surfaces.

Sources: [claude/round-1.md, line 50](../../claude/round-1.md); [consensus/PROPOSAL.md, line 82](../../consensus/PROPOSAL.md).

### Quiet-hour and retry messages must drain

**Plan location:** G2 + delivery_queue

A scheduled flush and deduplicated delivery outbox are explicit prerequisites.

**Remaining:** Test quiet hours across restart without rerunning the underlying agent.

Sources: [codex/repo-audit.md, line 19](../../codex/repo-audit.md); [consensus/PROPOSAL.md, line 85](../../consensus/PROPOSAL.md).

### Daily notes must use the correct local date

**Plan location:** G2

Fix dailyNotePath's local-date handling before unattended operation.

**Remaining:** Implement a timezone-aware path and verify around local midnight.

Sources: [gemini/messages-to-peers.md, line 9](../../gemini/messages-to-peers.md); [consensus/PROPOSAL.md, line 85](../../consensus/PROPOSAL.md).

### One authoritative home per data type

**Plan location:** D3

Vault for prose, existing Notion/TickTick records, SQLite for operational state; Recall is derived.

**Remaining:** Build source synchronization and correction behavior.

Sources: [codex/round-1.md, line 17](../../codex/round-1.md); [consensus/PROPOSAL.md, line 76](../../consensus/PROPOSAL.md).

### Generated files remain discoverable across assistants

**Plan location:** D3 / D4

Artifact IDs/paths and source-linked tools; static client routing pointers.

**Remaining:** Verify registration, versions and retrieval from fresh sessions.

Sources: [codex/build-blueprint.md, line 7](../../codex/build-blueprint.md); [consensus/PROPOSAL.md, line 77](../../consensus/PROPOSAL.md).

### One laptop/phone/Telegram state and usable controls

**Plan location:** D2 / D5

One backend; separate mute/snooze/pause; phone review before Phase-1 acceptance, inbound Telegram later.

**Remaining:** Test one answer winning across surfaces and in-progress editor safety.

Sources: [codex/round-3.md, line 41](../../codex/round-3.md); [consensus/PROPOSAL.md, line 78](../../consensus/PROPOSAL.md).

### Avoid two competing phone/life brains

**Plan location:** D8 / C1-G1

Shared task/approval authority with Thornhill executor state kept local.

**Remaining:** Build service contracts and shared IDs without duplicate approval flows.

Sources: [gemini/round-1.md, line 25](../../gemini/round-1.md); [consensus/PROPOSAL.md, line 81](../../consensus/PROPOSAL.md).

### Predictable API billing and spend controls

**Plan location:** C2

Explicit API credentials, cost tracking and budget cap; optional verified credits.

**Remaining:** User must supply a ceiling and confirm account eligibility.

Sources: [claude/round-1.md, line 53](../../claude/round-1.md); [consensus/PROPOSAL.md, line 86](../../consensus/PROPOSAL.md).

### Avoid overstating database security

**Plan location:** D9

Final wording distinguishes event-table triggers, application transactions and host isolation.

**Remaining:** The corrected statement is not a security test of the eventual implementation.

Sources: [gemini/round-1.md, line 73](../../gemini/round-1.md); [consensus/PROPOSAL.md, line 82](../../consensus/PROPOSAL.md).

### Meeting context → notes → follow-up tasks

**Plan location:** Phase 1

Minimal cited retrieval, note/transcript intake, review and source filing; five-meeting acceptance scenario.

**Remaining:** Source permissions, task destination and actual provider receipts are unverified.

Sources: [codex/USER-ANSWERS.md, line 5](../../codex/USER-ANSWERS.md); [consensus/PROPOSAL.md, line 118](../../consensus/PROPOSAL.md).

## Partial

The concern is acknowledged, but a mechanism, permission model or verification detail remains incomplete.

### Enforce untrusted-input and credential isolation

**Plan location:** D9

Restricted tools, filesystem paths, credentials and write routes are required; child processes alone are insufficient.

**Remaining:** No concrete sandbox/principal/egress configuration is specified. Must prove those restrictions work.

Sources: [codex/build-blueprint.md, line 48](../../codex/build-blueprint.md); [consensus/PROPOSAL.md, line 82](../../consensus/PROPOSAL.md).

### Provider timeout after a possible committed write

**Plan location:** Execution receipts + runtime criteria

Runs carry admission keys; executions retain receipts; final acceptance calls for no duplicates and reconciled writes.

**Remaining:** The final plan does not fully define an unknown-outcome state machine or each provider's reconciliation algorithm.

Sources: [codex/build-blueprint.md, line 44](../../codex/build-blueprint.md); [consensus/PROPOSAL.md, line 162](../../consensus/PROPOSAL.md).

### Keep professional, personal and health retrieval scoped

**Plan location:** D4 / D9

Static pointers reduce always-loaded leakage; workers have account/path restrictions.

**Remaining:** The final proposal does not spell out retrieval ACLs, domain partitions or employer-data eligibility.

Sources: [codex/build-blueprint.md, line 63](../../codex/build-blueprint.md); [consensus/PROPOSAL.md, line 82](../../consensus/PROPOSAL.md).

### Every Claude/ChatGPT/Gemini surface actually connects

**Plan location:** D4 + Phase 4

Per-client fresh-session tests and separate local/hosted routes are specified.

**Remaining:** Cowork argument behavior, actual Spark availability, mobile clients and account policies remain untested.

Sources: [codex/round-2.md, line 107](../../codex/round-2.md); [consensus/PROPOSAL.md, line 77](../../consensus/PROPOSAL.md).

### Record meetings when existing transcripts are absent

**Plan location:** Meeting notes + user question 3

Pasted notes provide a fallback; Fireflies/Granola can be inputs if available.

**Remaining:** No general local audio capture, transcription or ad-hoc recording pipeline is defined.

Sources: [scratch-pad.md, line 3](../../scratch-pad.md); [consensus/PROPOSAL.md, line 131](../../consensus/PROPOSAL.md).

### Health, auth, outages, backup restoration and retention

**Plan location:** D6 + source credentials

Backups, boot/Keychain checks, source freshness and outage state are included.

**Remaining:** Retention/deletion policy, restore drills and alert ownership are not fully specified.

Sources: [codex/build-blueprint.md, line 61](../../codex/build-blueprint.md); [consensus/PROPOSAL.md, line 79](../../consensus/PROPOSAL.md).

### One owner for each logical schedule across services

**Plan location:** C1/G1 + unique run admission keys

One user-facing planner and per-request admission keys reduce duplicate work.

**Remaining:** A shared scheduler registry or explicit ownership contract is not defined. Two services could still admit the same logical job under different identities.

Sources: [codex/build-blueprint.md, line 9](../../codex/build-blueprint.md); [claude/messages-to-peers.md, line 147](../../claude/messages-to-peers.md); [consensus/PROPOSAL.md, line 99](../../consensus/PROPOSAL.md).

### Rescheduled meetings must invalidate stale scheduled output

**Plan location:** Phase-1 reschedule acceptance + approval revisions

The final plan tests a rescheduled meeting and binds approval to a revision.

**Remaining:** It does not fully define source-version freshness, superseding an old brief or notification, and what happens to work already queued when a meeting changes.

Sources: [codex/build-blueprint.md, line 45](../../codex/build-blueprint.md); [claude/messages-to-peers.md, line 148](../../claude/messages-to-peers.md); [consensus/PROPOSAL.md, line 118](../../consensus/PROPOSAL.md).

## Deferred

A later phase or service dependency owns this capability; it is not delivered by the first milestone.

### Morning plan and reminders for undated backlog

**Plan location:** Phase 3

Listed as a later capability after meetings and the shared control layer.

**Remaining:** No concrete ranking, timing or interruption policy is defined yet.

Sources: [scratch-pad.md, line 5](../../scratch-pad.md); [consensus/PROPOSAL.md, line 120](../../consensus/PROPOSAL.md).

### Oura readiness → Hevy workout adjustment

**Plan location:** Phase 3

Use official APIs and create a routine copy rather than overwrite a plan.

**Remaining:** Live connectors, account access, freshness checks and training rules still need implementation.

Sources: [gemini/round-1.md, line 107](../../gemini/round-1.md); [consensus/PROPOSAL.md, line 141](../../consensus/PROPOSAL.md).

### Email/recruiter drafts and job-fit ranking

**Plan location:** Phase 3

MailMCP/Gmail read/draft plus existing job extraction and alerts.

**Remaining:** Ranking criteria, current resume and source access are not designed in detail.

Sources: [scratch-pad.md, line 20](../../scratch-pad.md); [consensus/PROPOSAL.md, line 135](../../consensus/PROPOSAL.md).

### PRDs, WBRs and PostHog product health

**Plan location:** D3 + Phase 3

Generic delegated artifacts cover documents; WBR and fixed product metrics are named integrations.

**Remaining:** Specialized workflows, actual metric definitions and quality acceptance are still needed.

Sources: [scratch-pad.md, line 6](../../scratch-pad.md); [consensus/PROPOSAL.md, line 120](../../consensus/PROPOSAL.md).

### Important messages, bills, spending and reminders

**Plan location:** Phases 3–4

Read-only message digests and bills from email; money remains guided.

**Remaining:** Coverage, reconciliation, extraction accuracy and actual account/device permissions are unverified.

Sources: [scratch-pad.md, line 13](../../scratch-pad.md); [consensus/PROPOSAL.md, line 142](../../consensus/PROPOSAL.md).

### Commute newsletter podcast on the daily phone

**Plan location:** Nutgraf dependency + Phase 4 music

Nutgraf retains future audio; Samaritan consumes its summary/service outputs.

**Remaining:** Audio is not yet shipped, and a daily-phone player/commute trigger is not specified in the final plan.

Sources: [codex/integration-matrix.md, line 26](../../codex/integration-matrix.md); [consensus/PROPOSAL.md, line 138](../../consensus/PROPOSAL.md).

## Constrained

The original behavior was deliberately removed or restricted. Consensus does not make the original capability available.

### Detect 'stressed right now' and offer music

**Plan location:** D7 / Oura limit

The live-stress trigger was removed because the cited API did not support that claim.

**Remaining:** The original scenario remains unavailable until another valid intraday signal is established.

Sources: [scratch-pad.md, line 35](../../scratch-pad.md); [consensus/PROPOSAL.md, line 140](../../consensus/PROPOSAL.md).

### Autonomous email sends and money movement

**Plan location:** D9 + integration limits

Drafts, manual approvals and human payment are the chosen boundary.

**Remaining:** This is a deliberate scope restriction, not proof of fully autonomous life management.

Sources: [scratch-pad.md, line 8](../../scratch-pad.md); [consensus/PROPOSAL.md, line 134](../../consensus/PROPOSAL.md).

## Missing

The original brief includes this behavior, but the final proposal has no explicit end-to-end route for it.

### Office arrival and commute trigger from your daily phone

**Plan location:** No explicit route in final proposal

An earlier Codex matrix suggested a daily-phone Shortcut; the final plan names a morning plan but no arrival event integration.

**Remaining:** Choose a daily-phone event source, permissions and delivery/playback behavior. The spare phone at home cannot sense this.

Sources: [scratch-pad.md, line 29](../../scratch-pad.md); [codex/integration-matrix.md, line 25](../../codex/integration-matrix.md).

### Auto-arrange the calendar and schedule from screenshots

**Plan location:** Calendar reads only in Phase 1

The final plan gives a calendar sync route. Earlier reports discussed Scrask and tentative holds.

**Remaining:** No final write/optimization workflow, conflict rule, attendee policy or screenshot-to-calendar acceptance criterion is specified.

Sources: [scratch-pad.md, line 4](../../scratch-pad.md); [codex/integration-matrix.md, line 10](../../codex/integration-matrix.md); [consensus/PROPOSAL.md, line 130](../../consensus/PROPOSAL.md).

### Workout completion should trigger the day's plan

**Plan location:** No explicit completion-event route in v2

Phase 3 lists a morning plan and Oura/Hevy proposals. Claude's integration notes had a Hevy workout webhook.

**Remaining:** A timed morning plan is not the requested after-workout event. Choose the event source and define missed/delayed-event behavior.

Sources: [scratch-pad.md, line 28](../../scratch-pad.md); [claude/notes/integrations.md, line 20](../../claude/notes/integrations.md); [claude/messages-to-peers.md, line 148](../../claude/messages-to-peers.md).

### Upcoming interview reminders and preparation

**Plan location:** Jobs are named; interviews are not specified

The brief names upcoming interviews; v2 covers job matches and recruiter drafts without a dedicated interview workflow.

**Remaining:** Define interview detection, calendar linkage, company/role context and the reminder or preparation artifact.

Sources: [scratch-pad.md, line 22](../../scratch-pad.md); [claude/messages-to-peers.md, line 146](../../claude/messages-to-peers.md); [consensus/PROPOSAL.md, line 135](../../consensus/PROPOSAL.md).
