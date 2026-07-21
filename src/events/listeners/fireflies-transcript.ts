/**
 * The pure core of the Fireflies transcript consumer (TECH-SPEC §2.2, §5.2).
 *
 * The webhook (`fireflies-webhook.ts`) only announces that a transcript is
 * ready — its `meeting.transcribed` event carries the meeting id, not the words.
 * Fetching the transcript is a second, authenticated call, and this file is the
 * decision-bearing half of it: which GraphQL query to send, how Fireflies'
 * response collapses into a normalised `FirefliesTranscript`, how its own
 * AI-extracted action items split into rows, and what review items those become.
 * All pure, all tested without a socket — the socket lives in
 * `fireflies-source.ts`, the same split the Gmail listener makes with the network.
 *
 * Fireflies runs its own extraction (`summary.action_items`, `summary.overview`),
 * so the consumer does no language work of its own: it normalises what Fireflies
 * already decided and files each piece behind the same review gate the manual
 * `/meeting` skill uses. The model that read the transcript was Fireflies';
 * Samaritan's job is to make its output reviewable, not to redo it.
 */
import type { ActionItemContext, DraftActionItem } from "../../types/index.js";

/** The GraphQL request for one transcript. Pure: builds the string and vars. */
export function firefliesTranscriptQuery(meetingId: string): {
  query: string;
  variables: { transcriptId: string };
} {
  const query = `query SamaritanTranscript($transcriptId: String!) {
  transcript(id: $transcriptId) {
    id
    title
    dateString
    transcript_url
    summary { overview action_items }
  }
}`;
  return { query, variables: { transcriptId: meetingId } };
}

/** The slice of a Fireflies `transcript` this reads. */
export interface RawFirefliesTranscript {
  id?: string;
  title?: string;
  dateString?: string;
  transcript_url?: string;
  summary?: {
    overview?: string | null;
    action_items?: string | null;
  } | null;
}

/** A Fireflies transcript after normalisation: the fields the mapper needs. */
export interface FirefliesTranscript {
  id: string;
  title: string;
  /** ISO date string, or "" when Fireflies omits it. */
  date: string;
  /** The transcript's web URL, for the review item's source link. */
  url: string;
  /** Fireflies' own summary paragraph, or "" when absent. */
  overview: string;
  /** Fireflies' own action-item block, verbatim, or "" when absent. */
  actionItemsRaw: string;
}

/**
 * Collapses a raw Fireflies transcript into the shape the mapper reads. Pure and
 * total: missing fields default to empty strings so a sparse transcript still
 * normalises rather than throwing. The id falls back to the passed `meetingId`
 * so a transcript that omits its own id still carries one for dedup and links.
 */
export function normalizeTranscript(
  raw: RawFirefliesTranscript | null | undefined,
  meetingId: string,
): FirefliesTranscript {
  const id = raw?.id || meetingId;
  return {
    id,
    title: raw?.title || "Untitled meeting",
    date: raw?.dateString || "",
    url: raw?.transcript_url || `https://app.fireflies.ai/view/${id}`,
    overview: raw?.summary?.overview || "",
    actionItemsRaw: raw?.summary?.action_items || "",
  };
}

/** One extracted action item: its text, and the assignee when Fireflies named one. */
export interface ActionItemLine {
  text: string;
  owner?: string;
}

const OWNER_HEADING = /^\s*\*\*(.+?)\*\*\s*:?\s*$/; // "**Jane Doe**" on its own line
const LEADING_BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/; // "- ", "* ", "• ", "1. ", "2) "
const TRAILING_TIMESTAMP = /\s*[([]\d{1,2}:\d{2}(?::\d{2})?[)\]]\s*$/; // "(12:34)" / "[1:02:03]"

/**
 * Splits Fireflies' `action_items` string into rows. Fireflies groups items
 * under a bold assignee heading (`**Name**`) and prefixes each with a bullet and
 * a trailing timestamp; this strips both and carries the current heading onto
 * each item below it. A flat, headingless list still parses — every non-empty
 * line becomes an ownerless item. Pure and total: junk in yields fewer rows, not
 * a throw.
 */
export function parseActionItems(raw: string): ActionItemLine[] {
  const lines = (raw ?? "").split(/\r?\n/);
  const items: ActionItemLine[] = [];
  let owner: string | undefined;

  for (const line of lines) {
    const heading = line.match(OWNER_HEADING);
    if (heading) {
      owner = heading[1]!.trim().replace(/:$/, "");
      continue;
    }
    const text = line.replace(LEADING_BULLET, "").replace(TRAILING_TIMESTAMP, "").trim();
    if (!text) continue;
    items.push(owner ? { text, owner } : { text });
  }
  return items;
}

const CAPABILITY_ID = "meeting-notes";
const REVIEW_TYPE = "meeting-note-item";

/** Builds one review item's uniform context (§4.2). */
function itemContext(
  transcript: FirefliesTranscript,
  kind: "task" | "note",
  title: string,
  actionCount: number,
): ActionItemContext {
  const dateLabel = transcript.date ? transcript.date.slice(0, 10) : "undated";
  return {
    what_happened: `Fireflies transcribed "${transcript.title}" (${dateLabel}) and extracted ${actionCount} follow-up(s)`,
    source: { kind: "meeting", id: `fireflies:${transcript.id}`, link: transcript.url },
    provenance: ["meeting.transcribed", "meeting-notes.run"],
    // Fireflies' AI read a transcript nobody in the room wrote down — the same
    // second-hand inference risk the manual /meeting path escalates on.
    why_flagged: "extraction from a meeting transcript always gets a review gate",
    trigger_reason: "action_type",
    confidence: 0.75,
    decision_needed:
      kind === "note"
        ? `Save the summary of "${transcript.title}"?`
        : `File this follow-up from "${transcript.title}"?`,
    decision_surface: "inbox",
    execution_surface: kind === "note" ? "obsidian" : "ticktick",
    outcome_preview: `Files "${title}" as a ${kind}`,
    // A filed task or note is a local row either way — undoable, so policy
    // gates it on the second-hand source (action_type), not on reversibility.
    reversibility: "reversible",
  };
}

/**
 * Maps a normalised transcript to the review items it should file: one task per
 * action item Fireflies extracted, plus one note carrying the overview when there
 * is one. Every item is escalated for review by the manifest — this only decides
 * what the rows are, never whether they are gated.
 *
 * Returns `[]` when Fireflies extracted nothing, which the entrypoint reports as
 * a clean "nothing to file" rather than an error: a meeting with no follow-ups
 * is a real, valid outcome. `dedupe_key` is stable per (transcript, kind, index)
 * so a redelivered webhook that slips past the bus dedup still upserts one row.
 */
export function transcriptToDraftItems(transcript: FirefliesTranscript): DraftActionItem[] {
  const actions = parseActionItems(transcript.actionItemsRaw);
  const items: DraftActionItem[] = [];

  actions.forEach((action, index) => {
    items.push({
      capability_id: CAPABILITY_ID,
      type: REVIEW_TYPE,
      context: itemContext(transcript, "task", action.text, actions.length),
      custom: {
        kind: "task",
        title: action.text,
        detail: "",
        owner: action.owner ?? "",
        meeting_title: transcript.title,
        meeting_date: transcript.date,
        transcript_url: transcript.url,
      },
      dedupe_key: `fireflies:${transcript.id}:task:${index}`,
    });
  });

  const overview = transcript.overview.trim();
  if (overview) {
    items.push({
      capability_id: CAPABILITY_ID,
      type: REVIEW_TYPE,
      context: itemContext(transcript, "note", `Summary of ${transcript.title}`, actions.length),
      custom: {
        kind: "note",
        title: `Summary of ${transcript.title}`,
        detail: overview,
        owner: "",
        meeting_title: transcript.title,
        meeting_date: transcript.date,
        transcript_url: transcript.url,
      },
      dedupe_key: `fireflies:${transcript.id}:note`,
    });
  }

  return items;
}
