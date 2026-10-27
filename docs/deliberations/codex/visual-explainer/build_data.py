"""Build a source-linked account of the saved deliberation. Writes here only."""
from pathlib import Path
import hashlib
import json
import re

OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[1]
FILES = {
    "c1": "claude/round-1.md", "c2": "claude/round-2.md", "c3": "claude/round-3.md",
    "g1": "gemini/round-1.md", "g2": "gemini/round-2.md", "g3": "gemini/round-3.md",
    "x1": "codex/round-1.md", "x2": "codex/round-2.md", "x3": "codex/round-3.md",
    "xb": "codex/build-blueprint.md", "xi": "codex/integration-matrix.md",
    "xa": "codex/repo-audit.md", "cm": "claude/messages-to-peers.md",
    "gm": "gemini/messages-to-peers.md", "xm": "codex/messages-to-peers.md",
    "plan": "consensus/PROPOSAL.md", "v1": "consensus/PROPOSAL-v1.md",
    "protocol": "PROTOCOL.md", "brief": "scratch-pad.md", "answers": "codex/USER-ANSWERS.md",
    "ci": "claude/notes/integrations.md",
}
SOURCES = {}
MISSING = []
for key, path in FILES.items():
    text = (ROOT / path).read_text()
    SOURCES[key] = {"path": path, "text": text, "sha256": hashlib.sha256(text.encode()).hexdigest()}


def ref(key, needle):
    lines = SOURCES[key]["text"].splitlines()
    hits = [i for i, line in enumerate(lines) if needle.casefold() in line.casefold()]
    if not hits:
        MISSING.append(f"{key}: {needle}")
        return {"doc": key, "line": 1, "find": needle}
    index = hits[0]
    return {"doc": key, "line": index + 1, "find": needle}


def cell(label, why, key, needle):
    return {"label": label, "why": why, "evidence": ref(key, needle)}


def trail(id, title, kind, decision, start, challenge, action, revision, outcome, refs, coverage):
    return dict(id=id, title=title, kind=kind, decision=decision, start=start,
                challenge=challenge, action=action, revision=revision, outcome=outcome,
                evidence=[ref(*r) for r in refs], coverage=coverage)


TRAILS = [
    trail("runtime", "Trial another runtime first?", "Design disagreement", "D1 / D10",
        [cell("SDK first; no new core", "Reuse the TypeScript run layer and existing review product. Another core creates integration work.", "c1", "D1 Runtime"),
         cell("SDK + an early trial", "An SDK worker was the initial choice, but a two-day OpenClaw comparison could reverse it if it removed more code than its bridge added.", "x1", "A runtime trial"),
         cell("SDK; other workers optional", "Keep Samaritan above interchangeable SDK/CLI or framework workers. No mandatory comparison before the meeting slice.", "g1", "**D1**")],
        "Claude and Gemini challenged Codex's up-front two-day trial.",
        "They compared the meeting-first scope with the integration work a second runtime introduces.",
        "Codex withdrew the prerequisite in round 2. In round 3, the concrete missing capability, rather than a fixed candidate ranking, determines a future trial.",
        "Start with the Claude Agent SDK. Trial Hermes or OpenClaw only after a demonstrated gap; keep the worker adapter replaceable.",
        [("c2", "4.1 Codex"), ("g2", "2-day OpenClaw"), ("x2", "I remove the mandatory"), ("plan", "## When to revisit")], "Designed; comparative performance remains untested."),
    trail("approval", "Can another assistant approve?", "Design disagreement", "D4 / D9",
        [cell("One human review inbox", "The round-1 MCP list had task-answering tools, but no explicit universal approval tool.", "c1", "D4 Cross-assistant"),
         cell("Assistants propose; you approve", "Do not expose the human approval capability to the same model that proposes a write. Derive identity on the server.", "xb", "Do not automatically grant"),
         cell("MCP includes samaritan_act", "A general tool could approve, edit, defer or reject an action through the same audited state machine.", "g1", "samaritan_act")],
        "Codex identified self-approval risk; Claude independently backed the objection in round 2.",
        "They followed the authority path: a prompt-injected client could both propose and approve its own side effect.",
        "Gemini removed samaritan_act in round 2 and separated clarification answers from final authorization.",
        "MCP tools read, propose and submit. Only an authenticated human surface can approve an exact action revision.",
        [("x2", "Human approval must"), ("c2", "4.2 Gemini"), ("g2", "Removed `samaritan_act`"), ("plan", "D4 Cross-assistant")], "Addressed in the design; authority separation still needs implementation tests."),
    trail("silence", "Does silence become approval?", "Design disagreement", "D9",
        [cell("Optional countdown tier", "Round 1 suggested auto-approval after a delay for low-risk work unless Sandip objected.", "c1", "auto-approve after"),
         cell("Human-required work waits", "Approvals are attributable to a human action; expired or changed approvals require revalidation.", "xb", "Approvals bind"),
         cell("Quarantine and review", "The initial report emphasized gated execution. It did not propose a countdown-to-approval tier.", "g1", "**D9**")],
        "Both Codex and Gemini objected to treating a missed notification as consent.",
        "They separated explicitly preauthorized low-risk policy from actions already escalated for a human decision.",
        "Claude removed the countdown tier in round 3.",
        "Silence never approves. Escalated items wait or expire; preauthorized low-risk items use explicit policy.",
        [("x2", "countdown-to-auto-approve"), ("g2", "Pushback on Claude"), ("c3", "No countdown"), ("plan", "D9 Trust")], "Addressed in the design; timeout behavior must be tested."),
    trail("context", "Live memory file or static pointer?", "Design disagreement", "D3 / D4",
        [cell("A shared instructions file", "One document in the vault referenced by client instructions; round 1 did not specify a live regenerated payload.", "c1", "D4 Cross-assistant"),
         cell("Static routing + live tools", "Keep always-loaded instructions about where to ask and find artifacts, rather than copying the contents of a life into every session.", "xb", "Publish a short canonical"),
         cell("Regenerate BRAIN_INDEX", "Refresh every 15 minutes with calendar, priorities and recent actions, then point global assistant instructions at it.", "g1", "Auto-Generated")],
        "Claude and Codex challenged the live index's scope, privacy and staleness.",
        "They compared global instruction loading with on-demand, scoped retrieval.",
        "Gemini explicitly accepted the static-file rule in round 3.",
        "Global files contain short static routing instructions. get_context/search retrieve current, relevant state when needed.",
        [("c2", "4.3 Gemini"), ("g3", "static context file"), ("plan", "D4 Cross-assistant")], "Addressed in the design; cross-domain retrieval permissions remain partly specified."),
    trail("schema", "How much new database machinery?", "Design disagreement", "D2 / D9",
        [cell("Add tasks and activity", "A delegated-task verb and a shared activity ledger were needed; round 1 did not enumerate a full schema.", "c1", "activity ledger"),
         cell("Separate lifecycle records", "Proposed tasks, messages, runs, events, artifacts, questions, approvals, admission receipts, source events and an outbox.", "xb", "Proposed records"),
         cell("Tasks beside Action Items", "Introduce a first-class tasks table and keep questions/approvals visible in the existing inbox.", "g1", "Add First-Class Tasks")],
        "Gemini's round 2 challenged duplicated questions/approvals/outbox and proposed four new tables, including source_cursors.",
        "Codex and Claude inspected migration 1 and found sync_cursors already existed. Codex retained the needed replay/conversation behavior through a generalized event ledger.",
        "All three accepted four additions: tasks, runs, artifacts and activity_events; reuse existing cursor, audit, execution and delivery tables.",
        "A smaller schema retains task conversations, run progress, stable admission keys and one approval inbox.",
        [("g2", "10-table SQLite"), ("xm", "round-3 schema resolution"), ("gm", "4-table Migration 6 refinement"), ("plan", "## Data model changes")], "Addressed at schema level; detailed migration and concurrency behavior are untested."),
    trail("ownership", "One brain or one database?", "Scope clarification", "C1 / G1 / D8",
        [cell("Fold Thornhill's brain in", "One planner, user task store and bot; source applications retain authoritative data.", "c1", "C1 One brain"),
         cell("One task/approval authority", "Keep Thornhill as executor and Nutgraf as domain service; avoid duplicate user-facing planners.", "x1", "D8 Phone control"),
         cell("One SQLite store and bot", "Round-1 consolidation wording could imply merging all storage, not just user-facing task authority.", "g1", "only run one task store")],
        "Codex clarified that one authority need not mean one physical database or no local domain planning.",
        "The group examined existing Nutgraf state and Thornhill's need for job receipts, locks and routines.",
        "Gemini and Claude accepted service-local storage with shared task/run IDs in round 2 and the final plan.",
        "Samaritan owns the user's goal and final approval. Services keep their own internal state and execution logic.",
        [("x2", "One brain is an ownership"), ("g2", "One Brain vs One Database"), ("plan", "C1/G1 One brain")], "Addressed in the design; API contracts and migration of existing plans remain to be built."),
    trail("audit", "What does the audit actually guarantee?", "Fact correction", "D9",
        [cell("Structural governance emphasized", "The existing policy, audit and money lock were the main reason to preserve Samaritan.", "c1", "hard, unusual part"),
         cell("Application path has limits", "Noted that in-process capabilities can bypass the registry and that an append-only local table is not a hardened host boundary.", "xb", "A local append-only"),
         cell("DB blocks unaudited transitions", "Round 1 overstated triggers as rejecting any Action Item transition without an audit event.", "g1", "SQLite triggers abort")],
        "Codex checked the exact SQL and transition() implementation.",
        "Only action_item_events has no-update/no-delete triggers. The status/event pair is coupled by an application transaction.",
        "Gemini corrected the claim in round 2. The precise limit was inserted into the final v2 trust decision.",
        "Retain useful audit controls; add scoped authority and a broker. Do not present them as universal DB or host isolation.",
        [("x2", "Actual migrations"), ("g2", "Corrected the SQLite"), ("plan", "Audit today means")], "Factual overclaim corrected; security depends on future enforcement, not the audit alone."),
    trail("stop", "Does a child process make work safe?", "Fact correction", "G2 / D9",
        [cell("A real Stop is needed", "Confirmed that Promise.race stops waiting while the original run continues.", "cm", "Confirmed: `withTimeout`"),
         cell("Termination plus fencing", "Stopping a process and revoking its authority are separate; late results and unknown provider writes need honest recovery.", "xb", "Claim runs with leases"),
         cell("Abort or terminate worker", "Flagged the same timeout and queued-delivery defects as prerequisites to unattended operation.", "g1", "**G2**")],
        "Round 2 adopted child workers, leases and fencing. Codex then flagged a final-draft wording risk: a child process is not an OS sandbox.",
        "They separated cancellation, authority, filesystem/credential restrictions and an already-committed external side effect.",
        "Plan v2 explicitly restricts tools, paths, credentials, write routes and access to human approval sessions.",
        "A Stop request must become a verified outcome. Child-process separation alone does not secure host resources or undo completed writes.",
        [("g2", "WorkerAdapter"), ("x3", "State the isolation limit"), ("plan", "Child processes give")], "Addressed as requirements; exact isolation configuration is still a build/validation task."),
    trail("oura", "Can Oura trigger live stress music?", "Capability constraint", "D7",
        [cell("Daily summary, not live", "The API did not establish an instantaneous stress signal; suggest music from known context.", "c1", "Oura stress is a daily summary"),
         cell("No evidence for live trigger", "Inspected the official daily_stress schema and distinguished daily totals from a current mental-state detector.", "xi", "daily stress"),
         cell("Poll summary every 30m", "Recognized the summary limit but still proposed a periodic stress-spike nudge.", "g1", "30m poll")],
        "Claude and Codex rejected polling frequency as proof of signal freshness or real-time meaning.",
        "They used the actual API fields and sync dependency, rather than inferring capability from the app's UI.",
        "Gemini removed the thirty-minute stress-watch proposal in round 2.",
        "No 'stressed right now' automation. Use optional calendar-context offers or check-ins until an appropriate signal is verified.",
        [("c2", "stress-watch"), ("g2", "Dropped 30-minute"), ("plan", "No \"stressed right now\"")], "Original live-stress scenario is deliberately constrained, not delivered."),
    trail("evidence", "Were OpenClaw and Hermes judged fairly?", "Fact correction", "D1",
        [cell("Reject core; safety concerns", "Acknowledged dashboards, but repeated an off-by-default Hermes approval claim and a third-party OpenClaw advisory count.", "c1", "off by default"),
         cell("Verify current capabilities", "Checked actual Workboard, Hermes dashboard and run API; described documented capabilities rather than a hands-on benchmark.", "x1", "documentation-verified"),
         cell("Samaritan has stronger gates", "An initial comparison understated Hermes approval coverage and overstated the exclusive safety guarantees of the custom system.", "g1", "write_approval.py")],
        "Codex verified the current official security docs and challenged advisory counts without release/applicability context.",
        "Hermes documented smart approvals and deny for unattended prompts. The group separated deployment trust boundaries from feature lists.",
        "Both peers corrected the claims. The final rationale became integration cost/product fit; the advisory-count sentence was removed.",
        "Preserve Samaritan for this user's existing review workflow. Neither framework is dismissed as featureless, and no comparative benchmark was performed.",
        [("x2", "Hermes comparison"), ("c3", "Hermes approvals"), ("g2", "Hermes's current"), ("plan", "choice is integration cost")], "Evidence corrected; SDK-versus-framework maintenance/performance remains an untested judgment."),
    trail("billing", "Can subscription limits fund agents?", "Fact correction", "C2",
        [cell("Credits path; conflicting sources", "Flagged tension between older third-party restrictions and the current support article. Asked for independent verification.", "c1", "C2 Billing"),
         cell("Do not assume entitlements", "Keep budgeted API operation separate from unverified consumer-plan coverage.", "x1", "consumer subscription entitlements"),
         cell("SDK workers; billing open", "Round 1 selected workers but did not establish the account's subscription or credit eligibility.", "g1", "**D1**")],
        "Claude asked peers to resolve the policy conflict rather than choose the convenient article.",
        "Codex fetched the current official support article and its linked credit terms. Gemini adopted the verified policy.",
        "The group stopped using a historical blanket ban as a runtime-selection argument.",
        "Use explicit Console/API billing with spend caps. Apply credits only after verifying plan eligibility and linking the organization.",
        [("cm", "conflict: Anthropic"), ("x2", "Billing and client access"), ("g2", "**C2 Billing**"), ("plan", "C2 Billing")], "Architecture settled; actual plan, credits and budget remain user inputs."),
    trail("clients", "Which clients can reach the shared brain?", "Fact correction", "D4",
        [cell("Web-only reach overstated", "Round 1 generalized public HTTPS requirements to ChatGPT and treated Gemini native availability in India as unavailable.", "c1", "ChatGPT only reaches"),
         cell("Separate local and hosted", "Local desktop/CLI MCP was verified; hosted and native clients needed their own connection and account checks.", "xb", "ChatGPT desktop/local Work"),
         cell("Small MCP works everywhere", "The initial six-tool design assumed broad client reach and borrowed a small-toolset workaround from Thornhill's observed Cowork failure.", "g1", "6-tool")],
        "Codex supplied current official OpenAI local-MCP docs and Google's July India rollout announcement.",
        "The group separated protocol support from actual client version, account availability, network route and permission grants.",
        "Claude corrected local MCP in round 2 and Gemini availability in round 3. The final plan requires fresh-session tests per client.",
        "Use a small facade and static pointers. Local clients connect locally; hosted clients need a reachable authenticated route. Test Cowork/native apps explicitly.",
        [("x2", "ChatGPT only"), ("xm", "Gemini India correction"), ("c3", "Gemini Spark"), ("plan", "D4 Cross-assistant")], "Designed; universal client interoperability is not yet demonstrated."),
    trail("sequence", "What has to ship before meetings?", "Sequencing correction", "D5 / D10",
        [cell("Daemon, then meetings", "Proposed minimal operation first, then the selected loop and later broad delegation.", "c1", "D10 Sequence"),
         cell("Meetings, then hardening", "Initial staging put the useful meeting slice before the fuller durable background-operation stage.", "x1", "Build order and effort"),
         cell("Broad rollout in 20 days", "Round 1 put meetings in days 1-4 and many integrations before full Recall.", "g1", "Days 1-4")],
        "Claude challenged scheduling without reliable operation; Codex challenged late retrieval and fixed all-features timelines.",
        "The group traced prerequisites and accepted failure cases: missing notes, reschedules, duplicate events and restart after approval.",
        "Codex's final v1 review caught phone acceptance before phone web and Telegram note capture before inbound support. v2 corrected the order.",
        "Operating prerequisites first; minimal retrieval and authenticated phone review with meetings; general task UI/Telegram intake next; expand sources incrementally.",
        [("c2", "4.5 Codex"), ("x2", "Recall after"), ("x3", "phase-1 channel dependencies"), ("plan", "## Build sequence")], "Dependency plan corrected; effort estimates and five-meeting acceptance remain unvalidated."),
    trail("newsletter", "Who should own newsletter audio?", "Service boundary", "D7 / C1",
        [cell("Nutgraf owns its output", "The round-1 integration notes place podcast audio in Nutgraf's future phase, with machine access still needed.", "ci", "Nutgraf |"),
         cell("Consume a service contract", "Reuse the authenticated summary API, establish a machine credential and do not assume a podcast already exists.", "xa", "Nutgraf"),
         cell("Samaritan generates TTS", "Initial proposal fetched summaries through API/DynamoDB and synthesized the commute podcast inside Samaritan.", "g1", "Generates 5-min audio")],
        "Claude and Codex challenged rebuilding domain logic in the control layer and relying on interactive AWS credentials.",
        "They inspected Nutgraf's API/build plan and separated user login from unattended service access.",
        "The final plan leaves ranking/audio in Nutgraf and puts orchestration in Samaritan.",
        "A machine-authenticated summary service comes first. Audio generation and daily-phone playback remain later dependencies.",
        [("c2", "generating TTS"), ("x2", "Nutgraf audio remains"), ("plan", "Nutgraf |")], "Summary integration is deferred; the original commute-audio experience is not yet fully specified."),
    trail("livecode", "Did existing code match the READMEs?", "Shared evidence check", "D7 / G2",
        [cell("Nearby HealthAI: PRD only", "An early peer message described healthAI as having no code, based on stale documentation.", "cm", "healthAI"),
         cell("Check implementation paths", "Found real coaching/web/mobile code, but mocked Oura/Hevy sources. Also identified the uncalled delivery flush and non-cancelling timeout.", "xa", "healthAI"),
         cell("Reuse code; verify connectors", "Its report distinguished actual coaching code from the two mock health adapters.", "g1", "27-line mocks")],
        "Codex asked peers to verify source files rather than trust repository status prose.",
        "Claude re-read the implementation and acknowledged that the application existed while the health connectors still returned fixtures.",
        "All three distinguished reusable domain code from live integrations. This was factual coordination already during round 1, not a completely blind experiment.",
        "Reuse the existing systems, but budget for live credentials, sync, freshness and failure handling; do not treat demo badges as proof.",
        [("cm", "you were right"), ("gm", "27-line mocks"), ("plan", "G2 Fix first")], "Inventory corrected; live connector capability remains to be built and verified."),
]


def audit(id, concern, disposition, plan_part, answer, remaining, refs, trail_id=None):
    return dict(id=id, concern=concern, disposition=disposition, plan_part=plan_part,
                answer=answer, remaining=remaining, evidence=[ref(*r) for r in refs], trail=trail_id)


AUDIT = [
    audit("core", "Keep the existing system instead of rebuilding", "Designed", "D1 / D2", "Samaritan retains review/policy/UI; SDK provides the tool-using harness.", "A lower-maintenance outcome has not been measured against an alternative runtime.", [("x1", "OpenClaw, Hermes"), ("plan", "D1 Runtime")], "runtime"),
    audit("goals", "Cowork-style delegated tasks and continuation", "Designed", "D1 / D2 + Phase 2", "Separate task/run/action concepts, SDK worker, task messages and answer flow.", "Implement and test continuation across disconnections and clients.", [("g1", "Add First-Class Tasks"), ("plan", "activity_events")], "schema"),
    audit("activity", "See every run, including no-op and failure", "Designed", "D2 + activity_events", "Durable run records and an append-only replayable activity ledger.", "Define exact event schemas and external-agent stale-state reconciliation.", [("x1", "Latest-run telemetry"), ("plan", "Activity and task threads")], "schema"),
    audit("scheduler", "Always-on scheduling and duplicate admissions", "Designed", "G2 + Phase 0", "Supervised daemon, stable admission identities and honest restart state.", "Validate clock/timezone, missed runs and multiple simultaneous admissions.", [("xa", "Crons are declared"), ("plan", "unique admission key")], "sequence"),
    audit("stop", "Stop and timeout actually revoke worker authority", "Designed", "D9 / G2", "Child-process termination and lease/fencing controls.", "Test late emits and distinguish stopping from a verified terminal outcome.", [("xb", "Use child processes"), ("plan", "Cancelled or timed-out")], "stop"),
    audit("selfapprove", "An assistant must not approve its own write", "Designed", "D4 / D5 / D9", "No MCP approval tool; authenticated human actor and exact payload/account/revision.", "Implement server authority checks and prevent access to human approval sessions.", [("g1", "samaritan_act"), ("plan", "No approve tool")], "approval"),
    audit("silence", "Missed notifications must not authorize writes", "Designed", "D9", "Pending items wait or expire; explicit policy handles preauthorized work.", "Test expired approvals and race conditions across surfaces.", [("c1", "auto-approve after"), ("plan", "Silence never approves")], "silence"),
    audit("outbox", "Quiet-hour and retry messages must drain", "Designed", "G2 + delivery_queue", "A scheduled flush and deduplicated delivery outbox are explicit prerequisites.", "Test quiet hours across restart without rerunning the underlying agent.", [("xa", "flush()"), ("plan", "TelegramDelivery.flush()")], "livecode"),
    audit("dates", "Daily notes must use the correct local date", "Designed", "G2", "Fix dailyNotePath's local-date handling before unattended operation.", "Implement a timezone-aware path and verify around local midnight.", [("gm", "UTC date bug"), ("plan", "local-date fix")]),
    audit("knowledge", "One authoritative home per data type", "Designed", "D3", "Vault for prose, existing Notion/TickTick records, SQLite for operational state; Recall is derived.", "Build source synchronization and correction behavior.", [("x1", "D3 Second brain"), ("plan", "D3 Second brain")], "ownership"),
    audit("artifacts", "Generated files remain discoverable across assistants", "Designed", "D3 / D4", "Artifact IDs/paths and source-linked tools; static client routing pointers.", "Verify registration, versions and retrieval from fresh sessions.", [("xb", "artifacts"), ("plan", "read_artifact")], "context"),
    audit("controls", "One laptop/phone/Telegram state and usable controls", "Designed", "D2 / D5", "One backend; separate mute/snooze/pause; phone review before Phase-1 acceptance, inbound Telegram later.", "Test one answer winning across surfaces and in-progress editor safety.", [("x3", "phase-1 channel dependencies"), ("plan", "D5 Surfaces")], "sequence"),
    audit("phoneauthority", "Avoid two competing phone/life brains", "Designed", "D8 / C1-G1", "Shared task/approval authority with Thornhill executor state kept local.", "Build service contracts and shared IDs without duplicate approval flows.", [("g1", "**G1**"), ("plan", "D8 Phone")], "ownership"),
    audit("billbudget", "Predictable API billing and spend controls", "Designed", "C2", "Explicit API credentials, cost tracking and budget cap; optional verified credits.", "User must supply a ceiling and confirm account eligibility.", [("c1", "C2 Billing"), ("plan", "C2 Billing")], "billing"),
    audit("securityclaims", "Avoid overstating database security", "Designed", "D9", "Final wording distinguishes event-table triggers, application transactions and host isolation.", "The corrected statement is not a security test of the eventual implementation.", [("g1", "SQLite triggers abort"), ("plan", "Audit today means")], "audit"),
    audit("meetings", "Meeting context → notes → follow-up tasks", "Designed", "Phase 1", "Minimal cited retrieval, note/transcript intake, review and source filing; five-meeting acceptance scenario.", "Source permissions, task destination and actual provider receipts are unverified.", [("answers", "First workflow"), ("plan", "Five real meetings")], "sequence"),
    audit("isolation", "Enforce untrusted-input and credential isolation", "Partial", "D9", "Restricted tools, filesystem paths, credentials and write routes are required; child processes alone are insufficient.", "No concrete sandbox/principal/egress configuration is specified. Must prove those restrictions work.", [("xb", "same Node process"), ("plan", "not a sandbox")], "stop"),
    audit("unknownwrite", "Provider timeout after a possible committed write", "Partial", "Execution receipts + runtime criteria", "Runs carry admission keys; executions retain receipts; final acceptance calls for no duplicates and reconciled writes.", "The final plan does not fully define an unknown-outcome state machine or each provider's reconciliation algorithm.", [("xb", "unknown outcome"), ("plan", "reconciled writes")]),
    audit("domainacl", "Keep professional, personal and health retrieval scoped", "Partial", "D4 / D9", "Static pointers reduce always-loaded leakage; workers have account/path restrictions.", "The final proposal does not spell out retrieval ACLs, domain partitions or employer-data eligibility.", [("xb", "Apply access/domain filters"), ("plan", "filesystem paths")], "context"),
    audit("clients", "Every Claude/ChatGPT/Gemini surface actually connects", "Partial", "D4 + Phase 4", "Per-client fresh-session tests and separate local/hosted routes are specified.", "Cowork argument behavior, actual Spark availability, mobile clients and account policies remain untested.", [("x2", "freshly fetched official"), ("plan", "Cowork included")], "clients"),
    audit("recording", "Record meetings when existing transcripts are absent", "Partial", "Meeting notes + user question 3", "Pasted notes provide a fallback; Fireflies/Granola can be inputs if available.", "No general local audio capture, transcription or ad-hoc recording pipeline is defined.", [("brief", "record notes"), ("plan", "Pasted notes")]),
    audit("freshness", "Health, auth, outages, backup restoration and retention", "Partial", "D6 + source credentials", "Backups, boot/Keychain checks, source freshness and outage state are included.", "Retention/deletion policy, restore drills and alert ownership are not fully specified.", [("xb", "Preserve source deletion"), ("plan", "Show source freshness")]),
    audit("dailyplan", "Morning plan and reminders for undated backlog", "Deferred", "Phase 3", "Listed as a later capability after meetings and the shared control layer.", "No concrete ranking, timing or interruption policy is defined yet.", [("brief", "backlog"), ("plan", "morning plan and undated")]),
    audit("health", "Oura readiness → Hevy workout adjustment", "Deferred", "Phase 3", "Use official APIs and create a routine copy rather than overwrite a plan.", "Live connectors, account access, freshness checks and training rules still need implementation.", [("g1", "mockOuraSnapshot"), ("plan", "Hevy |")], "livecode"),
    audit("mailjobs", "Email/recruiter drafts and job-fit ranking", "Deferred", "Phase 3", "MailMCP/Gmail read/draft plus existing job extraction and alerts.", "Ranking criteria, current resume and source access are not designed in detail.", [("brief", "Job search"), ("plan", "Jobs |")]),
    audit("prdmetrics", "PRDs, WBRs and PostHog product health", "Deferred", "D3 + Phase 3", "Generic delegated artifacts cover documents; WBR and fixed product metrics are named integrations.", "Specialized workflows, actual metric definitions and quality acceptance are still needed.", [("brief", "PRDs"), ("plan", "PostHog pulse")]),
    audit("messagesbills", "Important messages, bills, spending and reminders", "Deferred", "Phases 3–4", "Read-only message digests and bills from email; money remains guided.", "Coverage, reconciliation, extraction accuracy and actual account/device permissions are unverified.", [("brief", "read bills"), ("plan", "Bills |")]),
    audit("audio", "Commute newsletter podcast on the daily phone", "Deferred", "Nutgraf dependency + Phase 4 music", "Nutgraf retains future audio; Samaritan consumes its summary/service outputs.", "Audio is not yet shipped, and a daily-phone player/commute trigger is not specified in the final plan.", [("xi", "Commute newsletter"), ("plan", "Audio is Nutgraf")], "newsletter"),
    audit("stress", "Detect 'stressed right now' and offer music", "Constrained", "D7 / Oura limit", "The live-stress trigger was removed because the cited API did not support that claim.", "The original scenario remains unavailable until another valid intraday signal is established.", [("brief", "when i am stressed"), ("plan", "No \"stressed right now\"")], "oura"),
    audit("autosend", "Autonomous email sends and money movement", "Constrained", "D9 + integration limits", "Drafts, manual approvals and human payment are the chosen boundary.", "This is a deliberate scope restriction, not proof of fully autonomous life management.", [("brief", "preparing responses"), ("plan", "Never send automatically")], "silence"),
    audit("arrival", "Office arrival and commute trigger from your daily phone", "Missing", "No explicit route in final proposal", "An earlier Codex matrix suggested a daily-phone Shortcut; the final plan names a morning plan but no arrival event integration.", "Choose a daily-phone event source, permissions and delivery/playback behavior. The spare phone at home cannot sense this.", [("brief", "when i reach office"), ("xi", "Arrival can come from")]),
    audit("calendarwrite", "Auto-arrange the calendar and schedule from screenshots", "Missing", "Calendar reads only in Phase 1", "The final plan gives a calendar sync route. Earlier reports discussed Scrask and tentative holds.", "No final write/optimization workflow, conflict rule, attendee policy or screenshot-to-calendar acceptance criterion is specified.", [("brief", "auto arrange"), ("xi", "Arrange calendar automatically"), ("plan", "Google Calendar |")]),
    audit("workouttrigger", "Workout completion should trigger the day's plan", "Missing", "No explicit completion-event route in v2", "Phase 3 lists a morning plan and Oura/Hevy proposals. Claude's integration notes had a Hevy workout webhook.", "A timed morning plan is not the requested after-workout event. Choose the event source and define missed/delayed-event behavior.", [("brief", "after workout"), ("ci", "Webhook: workout done"), ("cm", "after-workout triggers")]),
    audit("interviews", "Upcoming interview reminders and preparation", "Missing", "Jobs are named; interviews are not specified", "The brief names upcoming interviews; v2 covers job matches and recruiter drafts without a dedicated interview workflow.", "Define interview detection, calendar linkage, company/role context and the reminder or preparation artifact.", [("brief", "upcoming interviews"), ("cm", "upcoming interviews"), ("plan", "Jobs |")]),
    audit("scheduleowner", "One owner for each logical schedule across services", "Partial", "C1/G1 + unique run admission keys", "One user-facing planner and per-request admission keys reduce duplicate work.", "A shared scheduler registry or explicit ownership contract is not defined. Two services could still admit the same logical job under different identities.", [("xb", "Exactly one component"), ("cm", "one owner per schedule"), ("plan", "unique admission key")]),
    audit("staleoutput", "Rescheduled meetings must invalidate stale scheduled output", "Partial", "Phase-1 reschedule acceptance + approval revisions", "The final plan tests a rescheduled meeting and binds approval to a revision.", "It does not fully define source-version freshness, superseding an old brief or notification, and what happens to work already queued when a meeting changes.", [("xb", "missed morning brief"), ("cm", "stale scheduled output"), ("plan", "Five real meetings")]),
]

ROUNDS = [
    {"id": 1, "name": "Independent recommendations", "outcome": "Same core, different implementation bets",
     "agreement": ["Retain Samaritan and use an existing agent harness.", "One shared review surface and knowledge access.", "Meeting-first on the current Mac (your answers).", "Thornhill executes phone tasks; Nutgraf retains newsletters."],
     "open": ["Whether to trial OpenClaw before building.", "MCP approval authority and live context loading.", "Autonomy limits, data model and build dependencies."],
     "actions": ["Read source code and compare it with status docs.", "Research current runtime and integration documentation.", "Publish independent recommendations and explicit D1–D10 positions.", "Exchange factual findings through status/message files."],
     "caution": "Independent reports, shared factual observations: round 1 was not a fully blind experiment.",
     "models": [
         {"name": "Claude", "emphasis": "Preserve governance; finish operational plumbing", "position": "SDK inside Samaritan; add daemon, scheduler, activity and task delegation.", "distinct": ["Countdown approval option for low-risk work.", "Suggested a tight initial rollout.", "Flagged conflicting billing sources."], "evidence": ref("c1", "Recommendation")},
         {"name": "ChatGPT / Codex", "emphasis": "Distinguish working code, demos and plans", "position": "Samaritan + SDK, with a bounded OpenClaw trial before a permanent runtime decision.", "distinct": ["Task/run/action split and detailed recovery records.", "Explicit worker authority and receipt limits.", "Current off-the-shelf dashboards deserve a fair comparison."], "evidence": ref("x1", "## Recommendation")},
         {"name": "Gemini", "emphasis": "Connect the existing applications into one experience", "position": "Samaritan kernel with replaceable SDK/CLI workers and an Ask/Delegate command centre.", "distinct": ["Six-tool MCP, including an approve tool.", "Live BRAIN_INDEX refreshed every 15 minutes.", "Concrete day-in-the-life schedule and broad rollout."], "evidence": ref("g1", "Recommendation")},
     ]},
    {"id": 2, "name": "Peer challenge and revision", "outcome": "Architecture aligned; trust, scope and evidence corrected",
     "agreement": ["Claude Agent SDK is the initial worker; no up-front bake-off.", "Tasks, runs and Action Items are different objects.", "Assistants propose; authenticated humans approve.", "One user-facing authority, with separate service-local storage."],
     "open": ["Minimal schema versus a larger record set.", "Static versus regenerated context (made explicit in round 3).", "Final phase order, isolation language and account-specific details."],
     "actions": ["Read the other two reports and cite specific disagreements.", "Check SQL, call sites, timeout behavior and mock adapters.", "Re-fetch official billing, client and security documentation.", "Withdraw or narrow claims rather than average incompatible designs."],
     "caution": "Agreement on a design did not produce a live framework benchmark or integration test.",
     "models": [
         {"name": "Claude", "emphasis": "Combine the strongest requirements; order prerequisites", "position": "Adopts task/run/action separation, artifacts, fencing, payload-bound approvals and the Ask/Delegate bar.", "distinct": ["Rejects the MCP approve tool and a global live-data file.", "Moves operating prerequisites before scheduled meetings.", "Pushes newsletter audio back to Nutgraf and monitoring to native hooks."], "evidence": ref("c2", "What changed")},
         {"name": "ChatGPT / Codex", "emphasis": "Verify claims and authority boundaries", "position": "Withdraws the mandatory runtime trial; accepts SDK first and proposes a smaller behavioral foundation.", "distinct": ["Corrects DB audit and Hermes approval claims.", "Verifies current billing and local/native client support.", "Challenges silence-as-approval and real-time Oura inference."], "evidence": ref("x2", "What changed")},
         {"name": "Gemini", "emphasis": "Simplify the implementation without losing the shared inbox", "position": "Drops self-approval and stress polling; adopts worker fencing, exact payload binding and coding hooks.", "distinct": ["Challenges the larger schema; proposes four additions.", "Rejects countdown approval and the up-front trial.", "Clarifies one brain does not require one physical database."], "evidence": ref("g2", "What changed")},
     ]},
    {"id": 3, "name": "Exact proposal review and sign-off", "outcome": "Plan v1 → six amendments → signed plan v2",
     "agreement": ["All D1–D10, C1/G1, G2 and C2 decisions accepted.", "Four tables: tasks, runs, artifacts, activity_events.", "Static context, human-only approval and scoped workers.", "Operating prerequisites → meetings → delegation → incremental domains."],
     "open": ["No architecture reservations remained at sign-off.", "Budget, accounts and some provider choices are still user inputs.", "Coverage audit below identifies deferred or incomplete capabilities."],
     "actions": ["Claude drafts one shared proposal instead of three competing finals.", "Codex reviews v1 against the prior objections and dependencies.", "Gemini endorses the refinements; Claude incorporates them into v2.", "All three read/sign v2; the saved body hash confirms the reviewed version."],
     "caution": "Final signatures record agreement on a proposal, not implemented or tested functionality.",
     "models": [
         {"name": "Claude", "emphasis": "Synthesize and maintain the single final proposal", "position": "Drafts v1, incorporates all six final-review amendments, preserves v1 and signs v2.", "distinct": ["Corrected Hermes defaults and native-client availability.", "Removed the advisory-count argument and countdown tier.", "Kept account benefits conditional and added source references."], "evidence": ref("cm", "All six Codex amendments")},
         {"name": "ChatGPT / Codex", "emphasis": "Check that the agreed design is internally consistent", "position": "Accepts the architecture; requests narrow changes to evidence, activity history, isolation and Phase-1 channels.", "distinct": ["Retains task messages and scoped admission identities in the small schema.", "Distinguishes a child process from a sandbox.", "Signs the corrected v2 with no reservations."], "evidence": ref("x3", "Requested amendments")},
         {"name": "Gemini", "emphasis": "Confirm the merged schema and shared implementation choices", "position": "Accepts static pointers, the existing sync_cursors table and activity_events; confirms v2 in full.", "distinct": ["Endorses all six final-review amendments.", "Confirms no remaining design disagreements.", "Signs the same v2 after its revisions."], "evidence": ref("gm", "Final confirmation")},
     ]},
]

DATA = {
    "title": "How three models reached one plan", "date": "20 October 2026",
    "modelOrder": ["Claude", "ChatGPT / Codex", "Gemini"],
    "rounds": ROUNDS, "trails": TRAILS, "audit": AUDIT, "sources": SOURCES,
    "statusDefinitions": {
        "Designed": "An explicit decision or mechanism appears in the final proposal. Implementation and validation are still pending.",
        "Partial": "The concern is acknowledged, but a mechanism, permission model or verification detail remains incomplete.",
        "Deferred": "A later phase or service dependency owns this capability; it is not delivered by the first milestone.",
        "Constrained": "The original behavior was deliberately removed or restricted. Consensus does not make the original capability available.",
        "Missing": "The original brief includes this behavior, but the final proposal has no explicit end-to-end route for it.",
    },
    "signoffs": [
        {"name": "Claude", "time": "11:14 IST", "evidence": ref("plan", "Claude: signed v2")},
        {"name": "ChatGPT / Codex", "time": "11:15 IST", "evidence": ref("plan", "Codex: signed v2")},
        {"name": "Gemini", "time": "11:16 IST", "evidence": ref("plan", "Gemini: signed v2")},
    ],
    "amendments": [
        "Replace the universal framework/security claim with integration cost and product fit.",
        "Distinguish persisted Hermes run identities from interruption of an active turn.",
        "Keep task messages, replay and scoped admission keys in the four-table design.",
        "Move basic phone review into Phase 1; keep Telegram intake after inbound support; make mail optional and guided filing explicit.",
        "State that child processes are not sandboxes and that the current database audit has limits.",
        "Record your settled workflow/host choices and cite primary sources for the remaining claims.",
    ],
    "method": [
        "The three research rounds and both proposal versions are the primary record. Summaries describe stated recommendations and reported rationale.",
        "Initial factual observations were shared during round 1, even though each report was written before reading peer round reports.",
        "Round order and saved versions establish sequence. Some early estimated timestamps were later corrected, so elapsed research-time comparisons would be misleading.",
        "The coverage labels are Codex's post-consensus audit, not a second three-model sign-off or a claim that code has shipped.",
        "No model was scored, ranked or assigned an invented agreement percentage. No unseen internal reasoning is reconstructed.",
        "Sources are embedded with line references and hashes. The final plan was a design/documentation exercise, not a hands-on comparison of installed frameworks.",
    ],
}

# Validate internal references and produce a static, reproducible data snapshot.
if MISSING:
    raise ValueError("Missing evidence:\n" + "\n".join(MISSING))
assert len({t["id"] for t in TRAILS}) == len(TRAILS)
assert len({a["id"] for a in AUDIT}) == len(AUDIT)
assert all(a["disposition"] in DATA["statusDefinitions"] for a in AUDIT)
assert all(not a["trail"] or any(t["id"] == a["trail"] for t in TRAILS) for a in AUDIT)
(OUT / "evidence.json").write_text(json.dumps(DATA, ensure_ascii=False, indent=2) + "\n")
template = (OUT / "deliberation-map.fragment.html.in").read_text()
encoded = json.dumps(DATA, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")
assert template.count("__DELIBERATION_DATA__") == 1
fragment = template.replace("__DELIBERATION_DATA__", encoded)
assert len(fragment.encode()) < 1_000_000
(OUT / "deliberation-map.html").write_text(fragment)

counts = {s: sum(a["disposition"] == s for a in AUDIT) for s in DATA["statusDefinitions"]}
report = ["# Consensus coverage audit", "", "Post-consensus analysis by Codex. These labels describe planning coverage, not implemented functionality.", "",
          "Final source: [PROPOSAL.md v2](../../consensus/PROPOSAL.md).", "",
          "## What the audit found", "", f"{len(AUDIT)} concerns: " + "; ".join(f"{n} {s.lower()}" for s, n in counts.items()) + ".", "",
          "Architecture agreement is complete. Full-life workflow specification is not. Office-arrival/commute events, calendar rearrangement, after-workout events and upcoming interviews lack an explicit end-to-end route in the final plan. Claude's later peer message independently flags these gaps. Schedule ownership and stale-output handling also need specification.", ""]
for status, definition in DATA["statusDefinitions"].items():
    report += [f"## {status}", "", definition, ""]
    for item in (a for a in AUDIT if a["disposition"] == status):
        report += [f"### {item['concern']}", "", f"**Plan location:** {item['plan_part']}", "", item["answer"], "", f"**Remaining:** {item['remaining']}", ""]
        refs = []
        for r in item["evidence"]:
            path = SOURCES[r["doc"]]["path"]
            refs.append(f"[{path}, line {r['line']}](../../{path})")
        report += ["Sources: " + "; ".join(refs) + ".", ""]
(OUT / "coverage-audit.md").write_text("\n".join(report))
print(json.dumps({"sources": len(SOURCES), "trails": len(TRAILS), "concerns": len(AUDIT), "dispositions": counts,
                  "fragment_bytes": len(fragment.encode())}, indent=2))
