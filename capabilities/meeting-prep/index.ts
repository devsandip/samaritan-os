import { dailyNotePath } from "../../src/execution/adapters/obsidian.js";
import type { RunContext, RunResult } from "../../src/run-layer/context.js";

/**
 * Pre-Meeting Recall Brief capability entrypoint (PROPOSAL Phase 1).
 *
 * Queries Recall for prior decisions, notes, and open tasks related to the
 * meeting title and attendees, and emits a reviewable brief card in the Inbox.
 */
export async function run(context: RunContext): Promise<RunResult> {
  const payload = (context.trigger.payload ?? context.inputs ?? {}) as Record<string, unknown>;
  const eventId = typeof payload["event_id"] === "string" && payload["event_id"] ? payload["event_id"] : "";
  const title = typeof payload["title"] === "string" && payload["title"] ? payload["title"] : "";
  const startsAt =
    typeof payload["starts_at"] === "string" && payload["starts_at"]
      ? payload["starts_at"]
      : context.trigger.firedAt;
  const endsAt =
    typeof payload["ends_at"] === "string" && payload["ends_at"]
      ? payload["ends_at"]
      : context.trigger.firedAt;
  const isEnded =
    payload["event_type"] === "calendar.meeting_ended" ||
    Boolean(payload["nudge_after_end"]);
  const attendeesRaw = payload["attendees"];
  const attendeesList = Array.isArray(attendeesRaw)
    ? attendeesRaw.map(String)
    : typeof attendeesRaw === "string" && attendeesRaw
      ? attendeesRaw.split(",").map((s) => s.trim())
      : [];

  if (!eventId || !title) {
    return {
      action_items: [],
      status: "ok",
      logs: ["no event_id or title supplied; meeting-prep idle"],
    };
  }

  if (isEnded) {
    const targetNotePath = dailyNotePath(new Date(endsAt));
    const nudgeMessage = `Meeting "${title}" ended at ${endsAt}. Jot down notes or paste a transcript in the Command Centre.`;
    return {
      action_items: [
        {
          capability_id: "meeting-prep",
          type: "meeting-notes-nudge",
          context: {
            what_happened: `Meeting "${title}" just ended`,
            source: { kind: "calendar", id: `${eventId}:ended` },
            provenance: ["calendar.meeting_ended", "meeting-prep.run"],
            why_flagged: "post-meeting note nudge (PROPOSAL-v1 Phase 1)",
            trigger_reason: "policy",
            confidence: 0.9,
            decision_needed: `Jot down notes for "${title}"?`,
            decision_surface: "inbox",
            execution_surface: "obsidian",
            outcome_preview: `Appends meeting note stub for "${title}" to ${targetNotePath}`,
          },
          custom: {
            event_id: eventId,
            meeting_title: title,
            ends_at: endsAt,
            attendee_count: `${attendeesList.length} attendee(s)`,
            nudge_message: nudgeMessage,
            path: targetNotePath,
            content: `\n### Meeting Notes: ${title} (${endsAt})\n- \n`,
          },
          dedupe_key: `meeting-nudge:${eventId}`,
        },
      ],
      status: "ok",
      logs: [`emitted post-meeting nudge for ${title} (${eventId})`],
    };
  }

  let recallSummary = "No prior vault or Notion passages matched this meeting topic.";
  const citations: string[] = [];

  if (context.memory.recall) {
    try {
      const query = `${title} ${attendeesList.join(" ")}`.trim();
      const res = await context.memory.recall(query);
      if (res.answer) recallSummary = res.answer;
      for (const c of res.citations.slice(0, 5)) {
        citations.push(`- [${c.kind}] \`${c.ref}\`${c.excerpt ? `: ${c.excerpt.slice(0, 140)}` : ""}`);
      }
    } catch {
      // Recall is optional if unindexed; still produce the meeting prep card.
    }
  }

  const briefLines = [
    `### Pre-Meeting Brief: ${title}`,
    `- **Starts at**: ${startsAt}`,
    `- **Attendees**: ${attendeesList.length ? attendeesList.join(", ") : "None listed"}`,
    "",
    "#### Context from Recall",
    recallSummary,
    ...(citations.length ? ["", "#### Citations", ...citations] : []),
  ];
  const briefMarkdown = briefLines.join("\n");
  const targetNotePath = dailyNotePath(new Date(startsAt));

  return {
    action_items: [
      {
        capability_id: "meeting-prep",
        type: "meeting-prep-brief",
        context: {
          what_happened: `Upcoming meeting "${title}" starts at ${startsAt}`,
          source: { kind: "calendar", id: eventId },
          provenance: ["calendar.meeting_upcoming", "meeting-prep.run"],
          why_flagged: `Pre-meeting brief prepared with ${citations.length} citation(s)`,
          trigger_reason: "policy",
          confidence: 0.9,
          decision_needed: `Review prep brief for "${title}"`,
          decision_surface: "inbox",
          execution_surface: "obsidian",
          outcome_preview: `Appends brief for "${title}" to ${targetNotePath}`,
        },
        custom: {
          event_id: eventId,
          meeting_title: title,
          starts_at: startsAt,
          attendees: attendeesList.join(", "),
          attendee_count: `${attendeesList.length} attendee(s)`,
          brief_markdown: briefMarkdown,
          path: targetNotePath,
          content: `\n${briefMarkdown}\n`,
        },
        dedupe_key: `meeting-prep:${eventId}`,
      },
    ],
    status: "ok",
    logs: [`prepared brief for ${title} (${eventId})`],
  };
}
