import { createFirefliesSource } from "../../src/events/listeners/fireflies-source.js";
import { transcriptToDraftItems } from "../../src/events/listeners/fireflies-transcript.js";
import type { RunContext, RunResult } from "../../src/run-layer/context.js";

/**
 * Meeting Notes (TECH-SPEC §2.2, §5.2).
 *
 * The consumer half of the Fireflies loop. The webhook publishes
 * `meeting.transcribed` carrying only a meeting id; the Event Bus dispatches it
 * here because this capability subscribes to that type; and this pulls the
 * transcript Fireflies has by then finished and files each follow-up it
 * extracted, behind the review gate the manifest sets.
 *
 * Thin on purpose. The GraphQL query, the authenticated fetch, and the mapping
 * from transcript to review rows all live in `src/events/listeners/` and are
 * separately tested. This reads the id off the event, asks the source for the
 * transcript, hands it to the mapper, and returns the rows. When Fireflies is
 * unconfigured (no `fireflies:api` token) it skips cleanly rather than failing —
 * the same idle shape the Gmail poller has without a token.
 *
 * The token lives in the Keychain as `fireflies:api` (or the env override the
 * secret resolver reads); `SAMARITAN_FIREFLIES_API_BASE` overrides the endpoint,
 * which verification uses to point at a local fixture without a real account.
 */
export async function run(context: RunContext): Promise<RunResult> {
  const payload = (context.trigger.payload ?? {}) as Record<string, unknown>;
  const meetingId = typeof payload.meeting_id === "string" ? payload.meeting_id : "";
  if (!meetingId) {
    return {
      action_items: [],
      status: "error",
      logs: ["no meeting_id on the meeting.transcribed event; nothing to fetch"],
    };
  }

  const apiBase = process.env.SAMARITAN_FIREFLIES_API_BASE;
  const source = createFirefliesSource({
    account: "api",
    ...(apiBase ? { apiBase } : {}),
  });
  if (!source) {
    return {
      action_items: [],
      status: "ok",
      logs: ["fireflies:api token not configured; skipping transcript fetch"],
    };
  }

  const transcript = await source.fetchTranscript(meetingId);
  const action_items = transcriptToDraftItems(transcript);
  return {
    action_items,
    status: "ok",
    logs: [`filed ${action_items.length} item(s) from "${transcript.title}"`],
  };
}
