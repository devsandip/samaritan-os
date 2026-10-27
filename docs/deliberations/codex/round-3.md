# Codex, round 3: final proposal review

2026-10-20. Reviewed both completed round-2 reports, peer messages, and `consensus/PROPOSAL.md` v1 drafted by Claude at 11:04 IST. This is a review of the exact shared document, not a new competing architecture.

## 1. Recommendation

Accept the shared architecture: Samaritan control layer, existing deterministic functions plus a TypeScript Claude Agent SDK worker, one task and approval authority, source-owned memory, current Mac, meeting-first, and Thornhill as a device service. I request the small amendments below before signing the final text. They fix evidence and sequencing details; no runtime or product decision needs reopening.

## 2. Decision table

| ID | Position | Disposition |
|---|---|---|
| D1 | Samaritan orchestrates; SDK behind start/events/answer/cancel/status; no initial runtime bake-off. | Agree |
| D2 | Extend Now/Inbox/Activity/Tasks/Settings and Ask/Delegate. Add durable task/run history and continuation. | Agree; clarify activity records below |
| D3 | Preserve source ownership, local registered artifacts and curated vault exports. | Agree |
| D4 | Small read/propose/submit MCP facade, clarification-only answers, static context pointers and per-client tests. | Agree |
| D5 | Shared backend, authenticated phone web and bidirectional Telegram. | Agree; fix phase dependencies below |
| D6 | Current Mac and existing AWS services; supervised startup, backups and real connectivity checks. | Agree; user has answered host choice |
| D7 | API/MCP first, staged integration, notes fallback and no live Oura stress claim. | Agree; cite account-dependent integrations |
| D8 | Thornhill owns device execution state and shares user-facing task/approval identity. | Agree |
| D9 | Exact-revision authenticated human approvals; scoped worker authority, cancellation/fencing, silence never approves. | Agree; distinguish process separation from sandboxing |
| D10 | Operating prerequisites, meeting loop with retrieval, then general delegation/MCP/mobile, then domains. | Agree; align first-phase channels with what is implemented |
| C1/G1 | One user-facing authority, separate service-local storage. | Agree |
| G2 | Delivery flush, real cancellation/fencing, correct local dates, actor identity and crash recovery. | Agree |
| C2 | Explicit API billing and spend cap; verified account benefits are optional. | Agree |

## 3. What changed since round 2

I accept a four-table implementation: tasks, runs, artifacts and a generalized activity event ledger. Reuse existing sync_cursors, action_items, action_item_events, executions and delivery_queue. This resolves the earlier schema disagreement without dropping task conversations, event replay or admission deduplication.

I accept operation prerequisites before scheduled meetings. Basic authenticated phone review belongs with the meeting acceptance check; the later mobile phase adds task continuation and installability. No up-front runtime trial remains.

## 4. Requested amendments to proposal v1

1. **Use a bounded build-versus-adopt justification.** Replace "the part no framework ships" with the specific review capabilities Samaritan already implements and that we want to retain. Remove the uncited third-party advisory-count sentence. Current OpenClaw/Hermes have real task, approval and audit features; our recommendation is based on integration cost and product fit, not a universal absence claim.

2. **Correct the Hermes restart description.** An active turn can be interrupted by restart, but its API documents persisted admission/run identities and interrupted/unknown outcomes. Do not say its runs categorically disappear or imply that another framework cannot persist run records. Samaritan still owns the durable user task across worker interruption. Primary source: [Hermes API server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server).

3. **Make the fourth table cover task conversation as well as run progress.** Prefer the agreed name `activity_events`, with task_id, optional run_id, type, monotonic cursor, stable client/event identity and a small redacted payload. It stores task messages/clarifications and run events. Calling it `run_events` is also workable if those exact behaviors are retained; a task can have a user message before any run exists. Give runs stable unique admission keys for manual/client requests as well as scheduled occurrences. Do not deduplicate all jobs merely on a shared `scheduled_for` timestamp.

4. **Fix the phase-1 channel dependencies.** The meeting phase currently promises notes sent on Telegram and a laptop/phone acceptance test, while Telegram inbound and phone web are deferred to phase 2. Move the minimal authenticated private phone review path into phase 1; keep Telegram note capture in phase 2, or explicitly implement its intake earlier. Recent-mail retrieval is optional until the relevant machine credential exists. Pasted notes and vault/Notion context are sufficient baseline inputs. Clarify that guided filing means explicit manual confirmation, while automated task creation needs a provider receipt.

5. **State the isolation limit.** Child processes enable termination and process separation; they do not by themselves remove access to the Mac's files, Keychain, browser sessions or network. Restrict worker tools, filesystem/credential access and write routes. Workers must not receive a human approval session or unrestricted access to the approval UI. Keep the factual audit distinction from round 2: event-table append-only triggers plus application-transaction coupling, not a database trigger on every possible Action Item update.

6. **Record settled user choices and direct sources.** Mark the first workflow and current-Mac choice as answered. Add primary links for runtime capabilities, billing and client connectivity, plus integration claims such as Granola plan access. I independently checked Granola's official material: Basic notes access differs from Business/Enterprise transcript access. [Granola integration](https://www.granola.ai/integrations/chatgpt). Indeed MCP can be omitted unless an available official connection is established; alert emails and existing job_tracker already cover the proposed baseline.

## 5. Questions for the other agents

Claude: please incorporate these amendments in v2 and freeze its architecture text for sign-off. Gemini: the amendments retain your accepted four-table architecture, a single Inbox and all D-row choices. Please review the same version before declaring final consensus.

## 6. Questions for Sandip

No new questions. Meeting-first, current Mac and deliberations-only writes are recorded. Calendar/note provider, task destination, budget and source permissions are implementation inputs, not remaining architecture disputes.

## 7. Sign-off

Pending the corrected proposal version. The architecture is accepted; the v1 wording needs the amendments above.

## Final sign-off, 2026-10-20 11:15 IST

I sign off on **consensus/PROPOSAL.md v2** as of 2026-10-20 11:15 IST. All D1-D10, C1/G1, G2 and C2 decisions: **agree, no remaining reservations**. I read the complete v2 and verified that all six requested amendments are incorporated. This supersedes the pending v1 sign-off above.

The body from `## The answer` up to `## Sign-off` has SHA-256 `3ed4a57c41a47477967b6ef1b5dd331991def78855f688d4fab857afc388069d` at review time. Updating only the header or sign-off table does not change this reviewed body.

Implementation remains a proposal. No changes outside deliberations were made by this research. Waiting for the other participants' final confirmation of this same version before reporting complete three-way convergence to Sandip.

## Convergence verified, 2026-10-20 11:17 IST

Gemini explicitly confirmed reading and signing v2 at 11:16 IST; Claude signed v2 at 11:14 IST. All three now accept the same v2 architecture with no reservations. Final body SHA-256 at completion check: `3ed4a57c41a47477967b6ef1b5dd331991def78855f688d4fab857afc388069d`. Scope remained research-only within deliberations.
