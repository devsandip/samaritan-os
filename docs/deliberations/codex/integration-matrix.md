# Integration feasibility and daily-life coverage

Checked 2026-10-20. Proposed routes are not newly configured integrations. Local source inspection is detailed in [repo-audit.md](repo-audit.md). API access, employer permissions and exact client behavior still require account-level verification.

| Need in the scratch pad | Proposed route | Boundary or unresolved detail |
|---|---|---|
| Pre-meeting context, decisions and follow-ups | Calendar occurrence → source-linked Recall → short brief. Calendar end → note prompt or permitted transcript → existing meeting extraction → Action Center. | Stable IDs and reschedule handling. Calendar end does not prove attendance. User notes are sufficient for the first slice. |
| Record/transcribe meetings and send minutes | Reuse permitted Fireflies transcripts or existing recording workflow. Retrieve transcript after completion; draft minutes. | New recording/automatic attendance is a separate capability. Confirm account access and meeting recording rules. Send minutes only through an authorized action. |
| Calendar from message/screenshot | Reuse Scrask structured extraction, then calendar read/check and proposal. | Preserve timezone, date ambiguity, recurrence and screenshot source. Rescheduling other people's meetings requires explicit policy. |
| Arrange calendar automatically | First propose holds for Sandip's own flexible tasks; check availability again at execution. | Meetings with attendees are not freely movable. Handle optimistic concurrency and conflicts. |
| Tasks and undated backlog | Read existing task source, pending meeting commitments and selected deadlines; rank a small daily list. | Keep source task IDs. Suggest due dates instead of inventing commitments. Existing TickTick adapter is guided. |
| Write/review PRDs | Delegated agent task with scoped project context, citations, editable artifact and versioned feedback. | Keep outputs in artifact registry/vault/project location. Do not silently edit product repositories. |
| Recall past decisions | Query canonical Notion/vault records plus citations and dates; add a correction workflow. | Recall query service is missing; generic chat memory is not an implementation. |
| Email and recruiters | Reuse MailMCP where appropriate, or Gmail API with account-scoped OAuth; classify and draft responses. | Automated daemon auth must be verified. Extraction workers get read/draft scope rather than an unrestricted sender. |
| Product health / PostHog | Fixed, reviewed metric queries and saved insight links; compare with meaningful baselines. | Query access uses project credentials; aggregate before sending context. Distinguish missing data from zero and schema changes from product changes. |
| WhatsApp important messages | Start with explicit forward/share or an opt-in linked-device source. OpenClaw offers a WhatsApp Web bridge if adopted. | A consumer linked-device bridge is different from a business messaging API. Test actual account history/coverage and reconnection. No automatic replies as a side effect of enabling read access. |
| iMessage important messages | Mac-side selected message reader/bridge on the signed-in Messages host. Start read-only, selected conversations. | macOS privacy grants required. Current OpenClaw uses imsg; its old BlueBubbles route was removed. Do not disable system security merely to add reactions/sending. |
| Bills, spending and reminders | Selected invoice emails/PDF uploads or bank exports → structured bill/transaction records → dedupe/review → reminders. | Keep currency, account, source and due-date uncertainty. Expenses and transfers can otherwise be double-counted. Payment stays a human action. |
| WBR from journal | Incremental journal index → weekly synthesis with source links → editable report artifact. | Do not claim metrics the journal does not contain. Separate work and personal retrieval. |
| Claude Code waiting on input | Notification hooks for permission/idle events, plus session end/heartbeat reconciliation. | These report a wait; they do not authorize an agent to answer the permission prompt. Show originating session and a return link. |
| Find and prioritize jobs | Saved-search/recruiter emails, pasted job URLs and allowed feeds → fit ranking → existing job_tracker extraction/save. | Avoid blind scraping/login loops and autonomous applications. Ranking needs current resume/preferences and a reason for each match. |
| Interviews | Calendar + recruiter threads + existing tracker → prep task and reminders. | Source/account identity and changed dates need reconciliation. |
| Oura sleep/readiness → workout | Oura OAuth V2 data after ring/app sync → known training preferences and recent Hevy routine/workout data → proposed adjustment. | Hevy API requires Pro and a key. Start with a draft/copy of a routine rather than overwriting the training plan. HealthAI's present adapters are mocks. |
| Stress-aware music | Offer a check-in or playlist from calendar context and available signals; ask before starting playback. | Oura V2 exposes daily stress summaries, not evidence of a real-time mental-state detector. No guaranteed instantaneous stress trigger. |
| Morning/day plan and first hour at work | Combine calendar, task source, approved priorities and personal constraints; generate a short plan. Arrival can come from a Shortcut on the daily phone. | The home agent phone cannot detect the daily phone's arrival. Do not infer location from its rig. |
| Commute newsletter listening | Nutgraf authenticated summary/story endpoint → future audio artifact/player link. | Existing Nutgraf audio is planned, not verified shipped. Playback happens on the daily phone; start with a user tap rather than assuming remote autoplay. |
| Favorite/high-energy music | Selected music app's official playback control or daily-phone Shortcut. | Provider and subscription unknown. Spotify playback needs Premium and an active device; Apple Music requires a separate route. |
| Give arbitrary Cowork-style tasks | Submit task + attachments + allowed sources; chosen harness plans within tools/budget; questions and artifacts persist across surfaces. | The current imported-prompt runner is insufficient. Raw shell access should not stand in for every integration. |

## Evidence and implications

**Calendar.** Google supports incremental synchronization using persisted sync tokens, with a full resync after token invalidation. Start with periodic sync to avoid adding a public webhook ingress immediately; later add expiring watch channels plus catch-up reads. [Google sync](https://developers.google.com/workspace/calendar/api/guides/sync), [push notifications](https://developers.google.com/workspace/calendar/api/guides/push).

**Gmail.** Notifications use Cloud Pub/Sub and history synchronization. Renew watches and retain cursors; receiving a notification is not receiving a complete email. A modest polling interval is a simpler first local connector. [Gmail push guide](https://developers.google.com/workspace/gmail/api/guides/push).

**Meetings.** Fireflies has a GraphQL API and current webhook documentation. Actual transcript availability remains account-dependent; the first workflow can accept pasted notes. [Fireflies API](https://docs.fireflies.ai/getting-started/introduction).

**Health.** Oura documents OAuth scopes and V2 resources. The fetched official OpenAPI 1.42 schema lists sleep, readiness, daily stress and webhook routes; `PublicDailyStress` contains day, summary and cumulative stress/recovery duration. This does not establish live emotional inference. [Oura auth](https://cloud.ouraring.com/docs/authentication), [V2 schema](https://cloud.ouraring.com/v2/static/json/openapi-1.42.json). Hevy's official API documents workout/routine reads and updates, is Pro-only, and cautions that its API can change. [Hevy API](https://api.hevyapp.com/docs/). These sources establish integration mechanics, not a clinically validated training prescription.

**Messaging.** OpenClaw's WhatsApp implementation uses Baileys/WhatsApp Web; linked account coverage must be tested for passive triage. Its current iMessage path uses imsg on a signed-in Mac, with additional private-API requirements for advanced actions. This is why those bridges should be optional integrations, not the foundation of the first meeting slice. [WhatsApp](https://docs.openclaw.ai/channels/whatsapp), [iMessage](https://docs.openclaw.ai/channels/imessage).

**Coding alerts.** Claude Code Notification hooks include permission and idle events and are intended to forward notifications to services. Use them to populate the shared inbox; keep actual prompt resolution in the originating client unless a dedicated supported control integration is built. [Claude hooks](https://code.claude.com/docs/en/hooks).

**Metrics.** PostHog's Query API supports scoped project queries. Use approved metric definitions rather than asking an agent to invent SQL and product diagnoses on every heartbeat. [PostHog SQL/API](https://posthog.com/docs/sql).

**Daily phone.** Apple Shortcuts supports location arrival/departure triggers. Validate the selected actions, device permissions and locked-device behavior on Sandip's actual phone. [Apple travel triggers](https://support.apple.com/guide/shortcuts/travel-triggers-apd8ebfc4e8e/ios). Spotify's playback endpoint requires Premium and targets the active device. [Spotify playback](https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback).

**Mobile dashboard.** A responsive web app is enough initially. Home Screen web apps can request notification permission following user interaction; HTTPS, install state and feature detection still matter. [WebKit Web Push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/). A PWA does not gain arbitrary access to iOS apps, notifications, health records or location just because it is installed.

## Suggested order after meetings

Morning plan and undated backlog; email/recruiter drafts; coding wait alerts; Nutgraf summaries; PostHog reporting; bill reminders; then health proposals and optional messaging/phone workflows. Reorder based on actual usefulness. Keep notification categories, quiet hours, digest preference, expiry and cooldown per capability. A user who mutes notifications should still see activity in the dashboard.
