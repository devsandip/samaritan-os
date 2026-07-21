/**
 * The pure core of the Gmail listener (TECH-SPEC §2.2 "Event Bus & listeners",
 * §12 step 18).
 *
 * The poll loop in `gmail-poll.ts` is a thin shell around this one function: it
 * turns a normalised Gmail message into the same `email.received` event a hand
 * `emit-event` posts, so `email-triage` and `newsletter-digest` cannot tell a
 * real inbox from the demo's fixture. Everything with a decision in it — how a
 * `From` header splits into an address and a name, what the event id is, when
 * the mail "happened" — lives here, as a pure function of its input, and is
 * tested without a network or a token, the same split `file-event.ts` made with
 * the disk.
 *
 * The messy half — OAuth, the Gmail REST call, decoding a base64 MIME tree into
 * `body` — is the source adapter's, deliberately downstream of this. A
 * `GmailMessage` is already normalised: headers as a lowercased map, the body as
 * decoded text. So this file never imports `fetch` and never sees a base64
 * part, which is what keeps it pure.
 *
 * The source id is `gmail:<message id>` — Gmail's own stable message id, which
 * is the same whether the message arrived by this poll or a future push webhook,
 * so the Event Bus dedups the two deliveries to one fire (§2.2). That dedup is
 * why the poller can re-see a message on its next tick without double-filing it.
 */
import type { SamaritanEvent } from "../types.js";

/**
 * A Gmail message after the source adapter has normalised it: headers keyed by
 * their lowercased name, the body decoded to text. This is the seam — the shell
 * builds one of these from the raw `users.messages.get` resource, and this file
 * only ever sees the tidy version.
 */
export interface GmailMessage {
  /** Gmail's stable message id — the identity half of the event id. */
  id: string;
  /** Gmail thread id, carried through so a reply can be threaded. */
  threadId?: string;
  /** Gmail label ids (INBOX, UNREAD, …). Exposed so a filter can narrow on them. */
  labelIds?: string[];
  /** Receipt time in epoch **milliseconds**, as Gmail returns it (a string). */
  internalDate?: string;
  /** Headers keyed by lowercased name: `from`, `subject`, `message-id`, … */
  headers: Record<string, string>;
  /** The plain-text body, already decoded from its MIME part. */
  body: string;
}

/**
 * Splits a `From` header into an address and an optional display name.
 * `"Morning Brew <crew@morningbrew.com>"` → `{ from: "crew@morningbrew.com",
 * from_name: "Morning Brew" }`; a bare `"crew@morningbrew.com"` → just the
 * address; the demo's `"@newsletters"` passes straight through. A quoted name
 * (`"\"Doe, John\" <j@x.com>"`) has its quotes stripped. Pure and total: an
 * unparseable header becomes `{ from: <the raw trimmed string> }` rather than
 * throwing, because a weird sender must not stop the mail from being triaged.
 */
export function parseFrom(header: string | undefined): { from: string; from_name?: string } {
  const raw = (header ?? "").trim();
  if (!raw) return { from: "" };

  const angled = raw.match(/^(.*)<([^>]+)>\s*$/);
  if (angled) {
    const name = (angled[1] ?? "").trim().replace(/^"(.*)"$/, "$1").trim();
    const address = (angled[2] ?? "").trim();
    return name ? { from: address, from_name: name } : { from: address };
  }
  return { from: raw };
}

/**
 * Maps a normalised Gmail message to the `email.received` event it should
 * publish. Total — every message becomes an event; unlike the vault watch there
 * is no "this change is not a note" case, because the source only hands over
 * messages it already decided are inbound mail.
 *
 * `occurred_at` is the message's own `internalDate`, not receipt time — the
 * truthful answer to "when did this arrive?" is Gmail's timestamp — and leaving
 * it off when Gmail omits the field keeps the function pure: it reads no clock.
 * The payload is exactly the shape `email-triage` and `newsletter-digest` read
 * (`from`, `subject`, `body`, …), so nothing between here and the capability has
 * to translate.
 */
export function gmailMessageToEvent(message: GmailMessage): SamaritanEvent {
  const { from, from_name } = parseFrom(message.headers.from);
  const receivedMs = message.internalDate ? Number(message.internalDate) : NaN;
  const receivedAt = Number.isFinite(receivedMs) ? new Date(receivedMs).toISOString() : undefined;

  const payload: Record<string, unknown> = {
    id: message.id,
    from,
    subject: message.headers.subject ?? "",
    body: message.body,
    permalink: `https://mail.google.com/mail/u/0/#inbox/${message.id}`,
  };
  if (from_name) payload.from_name = from_name;
  if (message.threadId) payload.thread_id = message.threadId;
  if (message.labelIds) payload.labels = message.labelIds;
  if (receivedAt) payload.received_at = receivedAt;

  return {
    type: "email.received",
    id: `gmail:${message.id}`,
    payload,
    ...(receivedAt ? { occurred_at: receivedAt } : {}),
    source: "gmail",
  };
}
