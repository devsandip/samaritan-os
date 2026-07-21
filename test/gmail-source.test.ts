import { describe, expect, it } from "vitest";
import {
  buildQuery,
  createGmailSource,
  normalizeRawMessage,
  type RawGmailMessage,
} from "../src/events/listeners/gmail-source.js";

/**
 * The source adapter's decisions — which query, how a raw message parses — are
 * exercised here against an injected fetch. The one thing not covered is the
 * socket to googleapis.com itself, which no unit test can stand in for; see
 * DECISIONS.md on verifying that against a real inbox.
 */

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64url");

function rawMultipart(): RawGmailMessage {
  return {
    id: "m1",
    threadId: "t1",
    labelIds: ["INBOX", "UNREAD"],
    internalDate: "1753000000000",
    snippet: "snippet fallback",
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "From", value: "Ada Lovelace <ada@example.com>" },
        { name: "Subject", value: "The deck" },
      ],
      parts: [
        { mimeType: "text/plain", body: { data: b64("Could you review the deck?") } },
        { mimeType: "text/html", body: { data: b64("<p>Could you review the deck?</p>") } },
      ],
    },
  };
}

describe("normalizeRawMessage", () => {
  it("prefers text/plain and lowercases headers", () => {
    const m = normalizeRawMessage(rawMultipart());
    expect(m).toMatchObject({
      id: "m1",
      threadId: "t1",
      labelIds: ["INBOX", "UNREAD"],
      internalDate: "1753000000000",
      body: "Could you review the deck?",
    });
    expect(m.headers.from).toBe("Ada Lovelace <ada@example.com>");
    expect(m.headers.subject).toBe("The deck");
  });

  it("falls back to stripped html when there is no plain part", () => {
    const raw: RawGmailMessage = {
      id: "m2",
      payload: {
        mimeType: "text/html",
        headers: [{ name: "From", value: "x@y.com" }],
        body: { data: b64("<style>a{}</style><p>Hello <b>there</b></p>") },
      },
    };
    expect(normalizeRawMessage(raw).body).toBe("Hello there");
  });

  it("falls back to the snippet when there is no body part at all", () => {
    const raw: RawGmailMessage = {
      id: "m3",
      snippet: "just the snippet",
      payload: { headers: [{ name: "From", value: "x@y.com" }] },
    };
    expect(normalizeRawMessage(raw).body).toBe("just the snippet");
  });
});

describe("buildQuery", () => {
  it("bounds a first run by newer_than days", () => {
    expect(buildQuery("in:inbox", 0, 3)).toBe("in:inbox newer_than:3d");
  });

  it("narrows to after: in epoch seconds once there is a mark", () => {
    expect(buildQuery("in:inbox", 1753000000000, 1)).toBe("in:inbox after:1753000000");
  });
});

describe("createGmailSource", () => {
  it("is idle (undefined) with no token", () => {
    expect(createGmailSource({ account: "nope", token: () => undefined })).toBeUndefined();
  });

  it("lists then fetches each message and normalises it", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (url.includes("/messages?")) {
        return { ok: true, status: 200, json: async () => ({ messages: [{ id: "m1" }] }) };
      }
      return { ok: true, status: 200, json: async () => rawMultipart() };
    }) as unknown as typeof fetch;

    const source = createGmailSource({ account: "default", token: "tok", fetchImpl });
    expect(source).toBeDefined();
    const messages = await source!.fetchSince(1753000000000);

    expect(calls[0]).toContain("q=in%3Ainbox%20after%3A1753000000");
    expect(calls[1]).toContain("/messages/m1?format=full");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: "m1", body: "Could you review the deck?" });
  });

  it("throws a reauthorise error on 401", async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const source = createGmailSource({ account: "default", token: "stale", fetchImpl });
    await expect(source!.fetchSince(0)).rejects.toThrow(/reauthorise/);
  });
});
