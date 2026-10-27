/**
 * The pure core of the Slack Events API webhook listener (TECH-SPEC §2.2, §12 step 18).
 *
 * Verifies Slack's `v0=<hmac>` request signature with 5-minute replay protection
 * over `v0:<timestamp>:<rawBody>`, handles `url_verification` challenges, and
 * normalises `message` and `app_mention` callbacks into `slack.message` and
 * `slack.app_mention` events on the Samaritan Event Bus.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { SamaritanEvent } from "../types.js";

const MAX_CLOCK_SKEW_SECONDS = 300;

export function verifySlackSignature(
  signingSecret: string,
  rawBody: string,
  timestampHeader: string | undefined,
  signatureHeader: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!timestampHeader || !signatureHeader) return false;
  const ts = Number.parseInt(timestampHeader, 10);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > MAX_CLOCK_SKEW_SECONDS) {
    return false;
  }

  const baseString = `v0:${timestampHeader}:${rawBody}`;
  const expected = `v0=${createHmac("sha256", signingSecret).update(baseString, "utf8").digest("hex")}`;
  const given = Buffer.from(signatureHeader);
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}

export interface SlackEventPayload {
  type?: string;
  subtype?: string;
  bot_id?: string;
  user?: string;
  text?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
}

export interface SlackWebhookBody {
  type?: "url_verification" | "event_callback" | string;
  challenge?: string;
  event_id?: string;
  event_time?: number;
  team_id?: string;
  event?: SlackEventPayload;
}

export function slackEventToSamaritan(body: SlackWebhookBody): SamaritanEvent | null {
  if (body.type !== "event_callback" || !body.event) return null;
  const ev = body.event;
  if (ev.bot_id || ev.subtype === "bot_message") return null;
  if (ev.type !== "message" && ev.type !== "app_mention") return null;

  const channel = ev.channel ?? "unknown";
  const ts = ev.ts ?? String(body.event_time ?? Date.now());
  const eventId = body.event_id ?? `${channel}:${ts}`;
  const occurredAt = body.event_time
    ? new Date(body.event_time * 1000).toISOString()
    : new Date().toISOString();

  return {
    id: `slack:${eventId}`,
    type: ev.type === "app_mention" ? "slack.app_mention" : "slack.message",
    source: "slack",
    occurred_at: occurredAt,
    payload: {
      event_id: eventId,
      team_id: body.team_id,
      channel,
      user: ev.user ?? "unknown",
      text: ev.text ?? "",
      ts,
      ...(ev.thread_ts ? { thread_ts: ev.thread_ts } : {}),
    },
  };
}
