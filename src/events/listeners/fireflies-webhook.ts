/**
 * The pure core of the Fireflies listener (TECH-SPEC §2.2, §12 step 18).
 *
 * The bus's first *inbound* front end. Where the Gmail poller reaches out on a
 * timer, this is reached *into*: Fireflies posts to a webhook when a meeting
 * transcript is ready, and the route in `src/api/webhooks.ts` is a thin shell
 * that verifies the request came from Fireflies and normalises it into a
 * `meeting.transcribed` event on the same bus the vault watch and the poller use.
 *
 * Both decisions live here as pure functions, tested without a socket: is this
 * request authentic (the HMAC), and what event does its body become. The route
 * only reads the raw bytes, calls these two, and publishes — nothing it does is
 * worth a test the way these are.
 *
 * The source id is `fireflies:<meetingId>` — Fireflies' own id — so a webhook
 * redelivered (they retry on non-2xx) dedups to one fire on the bus, the same
 * claim-before-dispatch every other listener leans on.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { SamaritanEvent } from "../types.js";

/**
 * Verifies a Fireflies webhook signature. Fireflies signs the exact request body
 * with HMAC-SHA256 under your webhook secret and sends it as `sha256=<hex>`. The
 * comparison is constant-time, and a missing or wrong-length header fails closed
 * rather than throwing — an unauthenticated caller must not be able to tell a
 * malformed signature from a merely incorrect one.
 *
 * The raw body matters: re-serialising the parsed JSON would reorder keys and
 * drop whitespace and break the HMAC, which is why the route keeps the bytes.
 */
export function verifyFirefliesSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | undefined,
): boolean {
  if (!signatureHeader) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
  const given = Buffer.from(signatureHeader);
  const want = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, so guard it; the expected length
  // is fixed for sha256, so the early return leaks nothing an attacker can use.
  return given.length === want.length && timingSafeEqual(given, want);
}

/** The slice of the Fireflies webhook body this reads. */
export interface FirefliesWebhookBody {
  meetingId?: string;
  eventType?: string;
  clientReferenceId?: string;
  title?: string;
}

/** The one event Fireflies fires that carries a ready transcript. */
const TRANSCRIPT_READY = "transcription completed";

/**
 * Maps a Fireflies webhook body to the `meeting.transcribed` event it should
 * publish, or `null` when it is not one to act on — a missing `meetingId`, or an
 * `eventType` other than the transcript-ready one (Fireflies can fire others).
 * Returning `null` keeps the route a straight `if (event) publish(event)`, and
 * the route answers 202 either way so Fireflies does not retry a message we
 * deliberately ignored.
 *
 * The payload carries the meeting id, not the transcript itself: the webhook only
 * announces readiness, and fetching the transcript is a separate authenticated
 * call a consumer makes. So this event is the *notice*, and a capability that
 * subscribes decides whether to pull the transcript and extract it.
 */
export function firefliesEventToSamaritan(body: FirefliesWebhookBody): SamaritanEvent | null {
  if (!body.meetingId) return null;
  if ((body.eventType ?? "").trim().toLowerCase() !== TRANSCRIPT_READY) return null;

  const payload: Record<string, unknown> = {
    meeting_id: body.meetingId,
    event_type: body.eventType,
  };
  if (body.title) payload.title = body.title;
  if (body.clientReferenceId) payload.client_reference_id = body.clientReferenceId;

  return {
    type: "meeting.transcribed",
    id: `fireflies:${body.meetingId}`,
    payload,
    source: "fireflies",
  };
}
