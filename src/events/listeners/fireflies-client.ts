/**
 * Fireflies GraphQL Transcript Client (PROPOSAL-v1 Phase 1, D7 Meeting notes).
 *
 * When the Fireflies webhook posts `{ meetingId, eventType: "Transcription completed" }`,
 * the Event Bus publishes `meeting.transcribed` carrying `meeting_id`. This
 * client fetches the meeting's title, date, attendees, summary, action items,
 * and transcript sentences from `https://api.fireflies.ai/graphql` using the
 * Keychain secret `fireflies:api`.
 */
import { getSecret } from "../../secrets.js";

export interface FirefliesTranscriptResult {
  id: string;
  title: string;
  dateIso?: string;
  attendees: string[];
  transcriptText: string;
}

export type FirefliesTranscriptFetcher = (
  meetingId: string,
) => Promise<FirefliesTranscriptResult | undefined>;

let customFetcher: FirefliesTranscriptFetcher | undefined;

/** Test seam to inject a deterministic Fireflies GraphQL fetcher. */
export function setFirefliesTranscriptFetcher(
  fetcher: FirefliesTranscriptFetcher | undefined,
): void {
  customFetcher = fetcher;
}

const TRANSCRIPT_QUERY = `
  query Transcript($id: String!) {
    transcript(id: $id) {
      id
      title
      date
      participants
      summary {
        overview
        action_items
      }
      sentences {
        speaker_name
        text
      }
    }
  }
`;

export async function fetchFirefliesTranscript(
  meetingId: string,
  opts: { account?: string; fetchImpl?: typeof fetch } = {},
): Promise<FirefliesTranscriptResult | undefined> {
  if (customFetcher) {
    return customFetcher(meetingId);
  }

  const token = getSecret(`fireflies:${opts.account ?? "api"}`);
  if (!token) return undefined;

  const fetchFn = opts.fetchImpl ?? fetch;
  const res = await fetchFn("https://api.fireflies.ai/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: TRANSCRIPT_QUERY,
      variables: { id: meetingId },
    }),
  });

  if (!res.ok) {
    throw new Error(`fireflies graphql ${res.status}: ${res.statusText}`);
  }

  const body = (await res.json()) as {
    data?: {
      transcript?: {
        id?: string;
        title?: string;
        date?: number | string;
        participants?: string[];
        summary?: { overview?: string; action_items?: string | string[] };
        sentences?: { speaker_name?: string; text?: string }[];
      };
    };
  };

  const t = body.data?.transcript;
  if (!t) return undefined;

  const lines: string[] = [];
  if (t.summary?.overview) {
    lines.push(t.summary.overview.trim());
  }
  if (t.summary?.action_items) {
    const actions = Array.isArray(t.summary.action_items)
      ? t.summary.action_items
      : String(t.summary.action_items).split(/\r?\n/);
    for (const act of actions) {
      const cleaned = act.replace(/^[\s*-]+/, "").trim();
      if (cleaned) lines.push(`Task: ${cleaned}`);
    }
  }
  for (const s of t.sentences ?? []) {
    if (s.text) {
      lines.push(`${s.speaker_name ? `${s.speaker_name}: ` : ""}${s.text}`);
    }
  }

  const dateIso =
    typeof t.date === "number"
      ? new Date(t.date).toISOString().slice(0, 10)
      : typeof t.date === "string"
        ? t.date.slice(0, 10)
        : undefined;

  return {
    id: t.id ?? meetingId,
    title: t.title?.trim() || "Fireflies Meeting",
    ...(dateIso ? { dateIso } : {}),
    attendees: t.participants ?? [],
    transcriptText: lines.join("\n"),
  };
}
