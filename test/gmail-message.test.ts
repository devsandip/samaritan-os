import { describe, expect, it } from "vitest";
import {
  gmailMessageToEvent,
  parseFrom,
  type GmailMessage,
} from "../src/events/listeners/gmail-message.js";
import { SamaritanEvent } from "../src/events/types.js";

/**
 * The pure half of the Gmail listener. The poll loop is exercised against a fake
 * source in gmail-poll.test.ts; here the decisions — how a From header splits,
 * what the event looks like — are pinned without a network or a token.
 */

function message(overrides: Partial<GmailMessage> = {}): GmailMessage {
  return {
    id: "18f2abc",
    threadId: "t-1",
    internalDate: "1753000000000",
    headers: { from: "Ada Lovelace <ada@example.com>", subject: "Could you review the deck?" },
    body: "Could you review the deck before Friday? Thanks.",
    ...overrides,
  };
}

describe("parseFrom", () => {
  it("splits a display name and an address", () => {
    expect(parseFrom("Morning Brew <crew@morningbrew.com>")).toEqual({
      from: "crew@morningbrew.com",
      from_name: "Morning Brew",
    });
  });

  it("returns just the address when there is no name", () => {
    expect(parseFrom("crew@morningbrew.com")).toEqual({ from: "crew@morningbrew.com" });
    expect(parseFrom("<crew@morningbrew.com>")).toEqual({ from: "crew@morningbrew.com" });
  });

  it("strips quotes around a display name", () => {
    expect(parseFrom('"Doe, John" <j@x.com>')).toEqual({ from: "j@x.com", from_name: "Doe, John" });
  });

  it("passes an unparseable/demo sender straight through", () => {
    expect(parseFrom("@newsletters")).toEqual({ from: "@newsletters" });
  });

  it("is total on empty or missing input", () => {
    expect(parseFrom(undefined)).toEqual({ from: "" });
    expect(parseFrom("   ")).toEqual({ from: "" });
  });
});

describe("gmailMessageToEvent", () => {
  it("maps an inbound message to a bus-valid email.received event", () => {
    const event = gmailMessageToEvent(message());

    expect(event.type).toBe("email.received");
    expect(event.id).toBe("gmail:18f2abc");
    expect(event.source).toBe("gmail");
    expect(event.payload).toMatchObject({
      id: "18f2abc",
      from: "ada@example.com",
      from_name: "Ada Lovelace",
      subject: "Could you review the deck?",
      body: "Could you review the deck before Friday? Thanks.",
      thread_id: "t-1",
      permalink: "https://mail.google.com/mail/u/0/#inbox/18f2abc",
    });
    // It must survive the same validation the bus applies at POST /api/events.
    expect(() => SamaritanEvent.parse(event)).not.toThrow();
  });

  it("derives occurred_at and received_at from internalDate", () => {
    const event = gmailMessageToEvent(message({ internalDate: "1753000000000" }));
    const iso = new Date(1753000000000).toISOString();
    expect(event.occurred_at).toBe(iso);
    expect(event.payload.received_at).toBe(iso);
  });

  it("omits occurred_at when Gmail gives no internalDate", () => {
    const { internalDate, ...rest } = message();
    void internalDate;
    const event = gmailMessageToEvent(rest);
    expect(event.occurred_at).toBeUndefined();
    expect(event.payload.received_at).toBeUndefined();
  });

  it("carries labels through so a filter can narrow on them", () => {
    const event = gmailMessageToEvent(message({ labelIds: ["INBOX", "UNREAD"] }));
    expect(event.payload.labels).toEqual(["INBOX", "UNREAD"]);
  });

  it("omits thread_id, from_name and labels when the message lacks them", () => {
    const event = gmailMessageToEvent({
      id: "bare",
      headers: { from: "noreply@service.io" },
      body: "hello",
    });
    expect(event.payload.from).toBe("noreply@service.io");
    expect(event.payload).not.toHaveProperty("from_name");
    expect(event.payload).not.toHaveProperty("thread_id");
    expect(event.payload).not.toHaveProperty("labels");
    expect(event.payload.subject).toBe("");
  });

  it("produces the exact from a newsletter-digest filter matches on (@newsletters)", () => {
    // newsletter-digest narrows email.received with `from_in: ["@newsletters"]`,
    // an exact match. A Gmail message whose From is literally that reaches it the
    // same way the demo's hand-emitted event does — the poller is not a side door.
    const event = gmailMessageToEvent(message({ headers: { from: "@newsletters", subject: "x" } }));
    expect(event.payload.from).toBe("@newsletters");
  });
});
