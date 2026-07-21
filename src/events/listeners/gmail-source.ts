/**
 * The Gmail REST source (TECH-SPEC §2.2, §9 "read + compose, never send").
 *
 * The network half the poll loop keeps at arm's length. `GmailPoller` asks a
 * `GmailSource` for mail newer than a mark; this is the real one, talking to the
 * Gmail REST API. Everything with a decision in it — which query to send, how a
 * raw `messages.get` resource collapses into the normalised `GmailMessage` the
 * pure mapper reads — is a function of its inputs and tested against an injected
 * `fetch`, so the only thing that genuinely needs the internet is the socket.
 *
 * It is idle when unconfigured, the vault watch's "no roots" case again: no token
 * in the Keychain means `createGmailSource` returns `undefined`, the poller stays
 * an idle no-op, and the daemon starts regardless. §9 scopes the Gmail grant to
 * read + compose, never send — this only ever reads, and the compose half is a
 * draft the Action Center still gates.
 *
 * v0 carries a bearer access token as the secret (`gmail:<account>`), the same
 * shape TickTick's OAuth gap has: the refresh-token dance is future work, so a
 * 401 surfaces as "reauthorise" rather than being silently swallowed. See
 * DECISIONS.md.
 */
import { log } from "../../logger.js";
import { getSecret } from "../../secrets.js";
import type { GmailMessage } from "./gmail-message.js";

const logger = log("gmail-source");

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** The slice of a `messages.get?format=full` resource this reads. */
export interface RawGmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  internalDate?: string;
  snippet?: string;
  payload?: RawPart;
}
interface RawPart {
  mimeType?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string };
  parts?: RawPart[];
}

/** Base64url-decodes a MIME part's body, or undefined when it carries none. */
function decodePart(part: RawPart | undefined): string | undefined {
  const data = part?.body?.data;
  return data ? Buffer.from(data, "base64url").toString("utf8") : undefined;
}

/** Depth-first search for the first part of `mimeType` that actually has bytes. */
function firstOfType(part: RawPart | undefined, mimeType: string): string | undefined {
  if (!part) return undefined;
  if (part.mimeType === mimeType) {
    const decoded = decodePart(part);
    if (decoded) return decoded;
  }
  for (const child of part.parts ?? []) {
    const found = firstOfType(child, mimeType);
    if (found) return found;
  }
  return undefined;
}

/** Naive tag-strip for the html fallback: enough to triage on, not to render. */
function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Collapses a raw Gmail message into the normalised shape the pure mapper reads:
 * headers keyed by lowercased name, the body preferring `text/plain`, falling
 * back to stripped `text/html`, then the snippet — so the body is never empty
 * just because the sender skipped a plain part. Pure: no network, no clock.
 */
export function normalizeRawMessage(raw: RawGmailMessage): GmailMessage {
  const headers: Record<string, string> = {};
  for (const h of raw.payload?.headers ?? []) headers[h.name.toLowerCase()] = h.value;

  const body =
    firstOfType(raw.payload, "text/plain") ??
    (firstOfType(raw.payload, "text/html") ? stripHtml(firstOfType(raw.payload, "text/html")!) : undefined) ??
    raw.snippet ??
    "";

  return {
    id: raw.id,
    ...(raw.threadId ? { threadId: raw.threadId } : {}),
    ...(raw.labelIds ? { labelIds: raw.labelIds } : {}),
    ...(raw.internalDate ? { internalDate: raw.internalDate } : {}),
    headers,
    body,
  };
}

/**
 * The Gmail search for one poll. After the first mark it narrows to `after:` in
 * epoch **seconds** (Gmail's granularity — the bus dedup absorbs the second-wide
 * overlap that costs); before it, `newer_than:<days>d` bounds the initial
 * backfill so a first run does not drag the whole mailbox in.
 */
export function buildQuery(base: string, sinceEpochMs: number, backfillDays: number): string {
  if (sinceEpochMs > 0) return `${base} after:${Math.floor(sinceEpochMs / 1000)}`.trim();
  return `${base} newer_than:${backfillDays}d`.trim();
}

export interface GmailSourceOptions {
  /** Keychain account: the token is looked up as `gmail:<account>`. */
  account: string;
  /** Gmail search the poll runs, before the time bound. Defaults to `in:inbox`. */
  query?: string;
  /** Initial backfill window when there is no checkpoint yet. Defaults to 1 day. */
  backfillDays?: number;
  /** Cap on messages fetched per poll. Defaults to 25. */
  maxPerPoll?: number;
  /** Test seam: the bearer token, as a value or a thunk. Falls back to the secret. */
  token?: string | (() => string | undefined);
  /** Test seam: the fetch implementation. Defaults to the global. */
  fetchImpl?: typeof fetch;
}

/** A GmailSource, or undefined when no token is configured (poller then idle). */
export function createGmailSource(options: GmailSourceOptions): { fetchSince(since: number): Promise<GmailMessage[]> } | undefined {
  const token =
    typeof options.token === "function"
      ? options.token()
      : (options.token ?? getSecret(`gmail:${options.account}`));
  if (!token) {
    logger.info({ account: options.account }, "no gmail token; source idle");
    return undefined;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const query = options.query ?? "in:inbox";
  const backfillDays = options.backfillDays ?? 1;
  const maxPerPoll = options.maxPerPoll ?? 25;

  async function getJson(url: string): Promise<unknown> {
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    if (response.status === 401) {
      throw new Error("gmail rejected the token (401) — reauthorise gmail:" + options.account);
    }
    if (!response.ok) throw new Error(`gmail ${response.status} for ${url}`);
    return response.json();
  }

  return {
    async fetchSince(since: number): Promise<GmailMessage[]> {
      const q = encodeURIComponent(buildQuery(query, since, backfillDays));
      const list = (await getJson(`${GMAIL_API}/messages?q=${q}&maxResults=${maxPerPoll}`)) as {
        messages?: { id: string }[];
      };
      const messages: GmailMessage[] = [];
      for (const { id } of list.messages ?? []) {
        const raw = (await getJson(`${GMAIL_API}/messages/${id}?format=full`)) as RawGmailMessage;
        messages.push(normalizeRawMessage(raw));
      }
      return messages;
    },
  };
}
