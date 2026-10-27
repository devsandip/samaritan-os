import { loadConfig } from "../../src/config/index.js";
import type { RunContext, RunResult } from "../../src/run-layer/context.js";

/**
 * Meeting Notes Nudge (PROPOSAL Phase 1). One card per ended meeting, keyed by
 * the calendar event, so a repeated poll or a restart never asks twice. The
 * link opens the notes form with the meeting already chosen.
 */
export async function run(context: RunContext): Promise<RunResult> {
  const payload = (context.trigger.payload ?? context.inputs ?? {}) as Record<string, unknown>;
  const eventId = typeof payload["event_id"] === "string" ? payload["event_id"] : "";
  const title = typeof payload["title"] === "string" && payload["title"] ? payload["title"] : "";
  if (!eventId || !title) {
    return { action_items: [], status: "ok", logs: ["no event_id or title; nothing to nudge"] };
  }
  const endedAt = typeof payload["ends_at"] === "string" ? payload["ends_at"] : context.trigger.firedAt;
  const attendees = Array.isArray(payload["attendees"]) ? payload["attendees"].map(String) : [];
  const { host, port, public_url } = loadConfig().server;
  const base = public_url ? public_url.replace(/\/+$/, "") : `http://${host}:${port}`;
  const notesUrl = `${base}/now?meeting=${encodeURIComponent(eventId)}`;

  return {
    action_items: [
      {
        capability_id: "meeting-followup",
        type: "meeting-notes-request",
        context: {
          what_happened: `"${title}" ended at ${endedAt}`,
          source: { kind: "calendar", id: eventId, link: notesUrl },
          provenance: ["calendar.meeting_ended", "meeting-followup.run"],
          why_flagged: "decisions and next steps from a meeting are lost unless someone writes them down",
          trigger_reason: "policy",
          confidence: 0.7,
          decision_needed: `Add notes for "${title}"?`,
          decision_surface: "inbox",
          execution_surface: "samaritan",
          outcome_preview: "Paste the notes and Samaritan extracts decisions and tasks for your review",
        },
        custom: {
          event_id: eventId,
          meeting_title: title,
          ended_at: endedAt,
          attendees: attendees.join(", "),
          attendee_count: `${attendees.length} attendee(s)`,
          prompt: "Paste your notes or a transcript, or say there are none.",
          notes_url: notesUrl,
        },
        dedupe_key: `meeting-followup:${eventId}`,
      },
    ],
    status: "ok",
    logs: [`asked for notes for ${title} (${eventId})`],
  };
}
