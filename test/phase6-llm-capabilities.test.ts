import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run as runPrdReview } from "../capabilities/prd-review/index.js";
import { run as runCalendarScreenshot } from "../capabilities/calendar-from-screenshot/index.js";
import { run as runEmailTriage } from "../capabilities/email-triage/index.js";
import { run as runNewsletterDigest } from "../capabilities/newsletter-digest/index.js";
import { buildServer } from "../src/api/server.js";
import { createApp } from "../src/app.js";
import { repoRoot } from "../src/config/index.js";
import type { RunContext } from "../src/run-layer/context.js";
import { __setSecretForTesting } from "../src/secrets.js";

function makeContext(inputs: Record<string, unknown>): RunContext {
  return {
    capabilityId: "test",
    runId: "run-1",
    inputs,
    trigger: { mode: "manual" },
    emit: async () => ({ id: "item-1", status: "pending" }) as never,
    memory: {
      recall: async () => ({
        question: "test",
        answer: "none",
        citations: [],
        retrieval_path: "semantic",
        synthesized: false,
      }),
    },
    log: () => {},
  };
}

describe("Phase 6: Claude LLM-Backed Capability Upgrades & Fallbacks", () => {
  it("uses Claude structured output in prd-review, calendar-from-screenshot (vision), email-triage, and newsletter-digest when available", async () => {
    // 1. prd-review with Claude multi-lens JSON response
    const prdFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          model: "claude-sonnet-4-20250514",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                findings: [
                  "PM Lens [Claude]: Quantify target activation latency.",
                  "UX Lens [Claude]: Add offline banner state.",
                  "SDE Lens [Claude]: Add composite index on (task_id, cursor).",
                ],
                pm_findings: ["PM Lens [Claude]: Quantify target activation latency."],
                ux_findings: ["UX Lens [Claude]: Add offline banner state."],
                sde_findings: ["SDE Lens [Claude]: Add composite index on (task_id, cursor)."],
                rubric_score: 94,
              }),
            },
          ],
          usage: { input_tokens: 120, output_tokens: 80 },
        }),
        { status: 200 },
      );

    const prdRes = await runPrdReview(
      makeContext({
        prd_title: "Voice Agent v2",
        project: "Samaritan",
        prd_markdown: "# Voice Agent v2\nProblem: slow phone triage.",
        write_artifact: false,
        anthropic_api_key: "sk-ant-test",
        fetchImpl: prdFetch,
      }),
    );
    expect(prdRes.action_items).toHaveLength(1);
    expect(prdRes.action_items[0]!.context.provenance).toContain("claude.multi-lens");
    expect(String(prdRes.action_items[0]!.custom?.["content"])).toContain("94%");
    expect(String(prdRes.action_items[0]!.custom?.["content"])).toContain("PM Lens [Claude]");

    // 2. calendar-from-screenshot with base64 vision block
    let capturedBody = "";
    const visionFetch: typeof fetch = async (_input, init) => {
      capturedBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: "```json\n" +
                JSON.stringify({
                  title: "Founder Dinner at Foreign Cinema",
                  starts_at: "2026-11-10T19:00:00-08:00",
                  ends_at: "2026-11-10T21:00:00-08:00",
                  location: "2534 Mission St, San Francisco",
                  timezone_ambiguous: false,
                  date_ambiguous: false,
                }) +
                "\n```",
            },
          ],
        }),
        { status: 200 },
      );
    };

    const calRes = await runCalendarScreenshot(
      makeContext({
        image_base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        anthropic_api_key: "sk-ant-test",
        fetchImpl: visionFetch,
      }),
    );
    expect(capturedBody).toContain('"type":"image"');
    expect(calRes.action_items).toHaveLength(1);
    expect(calRes.action_items[0]!.context.provenance).toContain("claude.vision");
    expect(calRes.action_items[0]!.custom?.["title"]).toBe("Founder Dinner at Foreign Cinema");
    expect(calRes.action_items[0]!.custom?.["location"]).toBe("2534 Mission St, San Francisco");

    // 3. email-triage with Claude classification and draft
    const emailFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                needsReply: true,
                urgency: "urgent",
                asks: ["Approve the Q4 contractor budget before 5pm"],
                reason: "Direct budget sign-off request from Finance",
                draft_body: "Hi Priya,\n\nApproved for Q4.\n\nSandip",
              }),
            },
          ],
        }),
        { status: 200 },
      );

    const triageRes = await runEmailTriage(
      makeContext({
        "email.message": {
          id: "msg-99",
          from: "Priya <priya@example.com>",
          subject: "Q4 Budget",
          body: "We need your sign-off on the Q4 contractor line item.",
        },
        anthropic_api_key: "sk-ant-test",
        fetchImpl: emailFetch,
      }),
    );
    expect(triageRes.action_items).toHaveLength(1);
    expect(triageRes.action_items[0]!.context.provenance).toContain("claude.triage");
    expect(triageRes.action_items[0]!.custom?.["draft_body"]).toContain("Approved for Q4.");

    // 4. newsletter-digest with Claude scoring
    const newsletterFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                worthActing: true,
                confidence: 0.93,
                matched: ["local-first", "sqlite"],
                summary: "Benchmarks sqlite-vec hybrid RRF latency on Apple Silicon laptops.",
              }),
            },
          ],
        }),
        { status: 200 },
      );

    const digestRes = await runNewsletterDigest(
      makeContext({
        "email.message": {
          id: "nl-42",
          from: "news@example.com",
          subject: "Weekly Systems Issue",
          body: "Deep dive on embedded vector search.",
        },
        anthropic_api_key: "sk-ant-test",
        fetchImpl: newsletterFetch,
      }),
    );
    expect(digestRes.action_items).toHaveLength(1);
    expect(digestRes.action_items[0]!.context.provenance).toContain("claude.digest");
    expect(digestRes.action_items[0]!.custom?.["kind"]).toBe("insight");
    expect(digestRes.action_items[0]!.custom?.["detail"]).toContain("sqlite-vec hybrid RRF");
  });

  it("allows remote POST /api/mcp with mcp:token when web:token is distinct", async () => {
    const app = createApp({ dbPath: ":memory:", capabilitiesDir: join(repoRoot(), "capabilities") });
    const server = buildServer(app);
    __setSecretForTesting("web:token", "web-secret-1");
    __setSecretForTesting("mcp:token", "mcp-secret-2");
    try {
      const denied = await server.inject({
        method: "POST",
        url: "/api/mcp",
        headers: { "x-forwarded-for": "100.64.0.9" },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      });
      expect(denied.statusCode).toBe(401);

      const allowed = await server.inject({
        method: "POST",
        url: "/api/mcp",
        headers: {
          "x-forwarded-for": "100.64.0.9",
          authorization: "Bearer mcp-secret-2",
        },
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json().result.tools).toHaveLength(8);
    } finally {
      __setSecretForTesting("web:token", undefined);
      __setSecretForTesting("mcp:token", undefined);
      await server.close();
      app.close();
    }
  });
});
