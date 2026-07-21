import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  firefliesEventToSamaritan,
  verifyFirefliesSignature,
  type FirefliesWebhookBody,
} from "../src/events/listeners/fireflies-webhook.js";
import { SamaritanEvent } from "../src/events/types.js";

const SECRET = "whsec_test";
const sign = (body: string): string =>
  `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`;

describe("verifyFirefliesSignature", () => {
  it("accepts a signature computed over the exact raw body", () => {
    const raw = JSON.stringify({ meetingId: "m1", eventType: "Transcription completed" });
    expect(verifyFirefliesSignature(SECRET, raw, sign(raw))).toBe(true);
  });

  it("rejects a signature over different bytes (a re-serialised body)", () => {
    const raw = '{"meetingId":"m1"}';
    const tampered = '{"meetingId":"m1"} ';
    expect(verifyFirefliesSignature(SECRET, tampered, sign(raw))).toBe(false);
  });

  it("rejects the wrong secret", () => {
    const raw = '{"meetingId":"m1"}';
    const bad = `sha256=${createHmac("sha256", "nope").update(raw).digest("hex")}`;
    expect(verifyFirefliesSignature(SECRET, raw, bad)).toBe(false);
  });

  it("fails closed on a missing or malformed header", () => {
    const raw = '{"meetingId":"m1"}';
    expect(verifyFirefliesSignature(SECRET, raw, undefined)).toBe(false);
    expect(verifyFirefliesSignature(SECRET, raw, "")).toBe(false);
    expect(verifyFirefliesSignature(SECRET, raw, "sha256=short")).toBe(false);
  });
});

describe("firefliesEventToSamaritan", () => {
  const body = (overrides: Partial<FirefliesWebhookBody> = {}): FirefliesWebhookBody => ({
    meetingId: "AS-2026-07-21",
    eventType: "Transcription completed",
    ...overrides,
  });

  it("maps a completed transcription to a bus-valid meeting.transcribed event", () => {
    const event = firefliesEventToSamaritan(body({ title: "Storage review", clientReferenceId: "c1" }));
    expect(event).not.toBeNull();
    expect(event).toMatchObject({
      type: "meeting.transcribed",
      id: "fireflies:AS-2026-07-21",
      source: "fireflies",
    });
    expect(event!.payload).toMatchObject({
      meeting_id: "AS-2026-07-21",
      title: "Storage review",
      client_reference_id: "c1",
    });
    expect(() => SamaritanEvent.parse(event)).not.toThrow();
  });

  it("is case-insensitive on the event type", () => {
    expect(firefliesEventToSamaritan(body({ eventType: "transcription completed" }))).not.toBeNull();
    expect(firefliesEventToSamaritan(body({ eventType: "TRANSCRIPTION COMPLETED" }))).not.toBeNull();
  });

  it("ignores events that are not a ready transcript", () => {
    expect(firefliesEventToSamaritan(body({ eventType: "Meeting started" }))).toBeNull();
    expect(firefliesEventToSamaritan(body({ eventType: undefined }))).toBeNull();
  });

  it("ignores a body with no meetingId", () => {
    expect(firefliesEventToSamaritan({ eventType: "Transcription completed" })).toBeNull();
  });

  it("omits optional fields it was not given", () => {
    const event = firefliesEventToSamaritan(body());
    expect(event!.payload).not.toHaveProperty("title");
    expect(event!.payload).not.toHaveProperty("client_reference_id");
  });
});
