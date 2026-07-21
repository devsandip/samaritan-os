/**
 * The Fireflies source adapter (TECH-SPEC §2.2, §9).
 *
 * The adapter's decisions — the request it sends, how it reads the response,
 * how it fails — are exercised here against an injected fetch. The one thing not
 * covered is the socket to api.fireflies.ai itself, which no unit test stands in
 * for; see DECISIONS.md on verifying that against a real account.
 */
import { describe, expect, it } from "vitest";
import { createFirefliesSource } from "../src/events/listeners/fireflies-source.js";

interface FakeCall {
  url: string;
  init: RequestInit;
}

/** A fetch that records its call and answers with the given status/body. */
function fakeFetch(
  status: number,
  body: unknown,
): { fetchImpl: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const OK_BODY = {
  data: {
    transcript: {
      id: "ff-7",
      title: "Kickoff",
      dateString: "2026-07-18T09:00:00.000Z",
      transcript_url: "https://app.fireflies.ai/view/ff-7",
      summary: { overview: "We started.", action_items: "- Do it (00:10)" },
    },
  },
};

describe("createFirefliesSource", () => {
  it("is idle (undefined) with no token", () => {
    expect(createFirefliesSource({ account: "nope", token: () => undefined })).toBeUndefined();
  });

  it("posts an authenticated GraphQL query and normalises the transcript", async () => {
    const { fetchImpl, calls } = fakeFetch(200, OK_BODY);
    const source = createFirefliesSource({ account: "api", token: "tok", fetchImpl });
    expect(source).toBeDefined();

    const transcript = await source!.fetchTranscript("ff-7");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.fireflies.ai/graphql");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(String(calls[0]!.init.body)).toContain("$transcriptId");
    expect(String(calls[0]!.init.body)).toContain("ff-7");

    expect(transcript).toMatchObject({
      id: "ff-7",
      title: "Kickoff",
      overview: "We started.",
      actionItemsRaw: "- Do it (00:10)",
    });
  });

  it("honours an apiBase override so verification can hit a local fixture", async () => {
    const { fetchImpl, calls } = fakeFetch(200, OK_BODY);
    const source = createFirefliesSource({
      account: "api",
      token: "tok",
      fetchImpl,
      apiBase: "http://127.0.0.1:9999/graphql",
    });
    await source!.fetchTranscript("ff-7");
    expect(calls[0]!.url).toBe("http://127.0.0.1:9999/graphql");
  });

  it("throws a reauthorise error on 401", async () => {
    const { fetchImpl } = fakeFetch(401, {});
    const source = createFirefliesSource({ account: "api", token: "stale", fetchImpl });
    await expect(source!.fetchTranscript("ff-7")).rejects.toThrow(/reauthorise fireflies:api/);
  });

  it("throws on a non-ok status", async () => {
    const { fetchImpl } = fakeFetch(503, {});
    const source = createFirefliesSource({ account: "api", token: "tok", fetchImpl });
    await expect(source!.fetchTranscript("ff-7")).rejects.toThrow(/fireflies 503/);
  });

  it("surfaces a GraphQL errors array returned under a 200", async () => {
    const { fetchImpl } = fakeFetch(200, { errors: [{ message: "invalid transcript id" }] });
    const source = createFirefliesSource({ account: "api", token: "tok", fetchImpl });
    await expect(source!.fetchTranscript("ff-7")).rejects.toThrow(/invalid transcript id/);
  });
});
