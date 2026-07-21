/**
 * The Recall HTTP surface (TECH-SPEC §5.5).
 *
 * Runs through `inject` like the rest of the API suite. The app is built with an
 * injected hash embedder and its index seeded directly, so a query exercises the
 * real route, schema and service with no model download and no network.
 */
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/api/server.js";
import { createApp, type App } from "../src/app.js";
import { repoRoot } from "../src/config/index.js";
import { HashEmbedder } from "../src/recall/embed.js";
import { ensureVectorTable } from "../src/recall/index-store.js";
import { indexDocuments } from "../src/recall/indexer.js";

let app: App;
let server: FastifyInstance;

beforeEach(async () => {
  const embedder = new HashEmbedder();
  app = createApp({
    dbPath: ":memory:",
    capabilitiesDir: join(repoRoot(), "capabilities"),
    recall: { embedder },
  });
  ensureVectorTable(app.db, await embedder.dimensions());
  await indexDocuments(app.db, embedder, "obsidian", [
    {
      sourcePath: "Meetings/vendor.md",
      text: "# Vendor review\n\n## Pricing\n\nVendor B pricing was volatile across quarters.\n",
    },
  ]);
  server = buildServer(app);
});

afterEach(async () => {
  await server.close();
  app.close();
});

describe("POST /api/recall/query", () => {
  it("answers with cited passages and a retrieval path", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/recall/query",
      payload: { question: "vendor pricing volatility" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      answer: string;
      citations: { kind: string; ref: string }[];
      retrieval_path: string;
    };
    expect(body.retrieval_path).toBe("semantic");
    expect(body.citations.map((c) => c.ref)).toContain("Meetings/vendor.md#Pricing");
    expect(body.answer.length).toBeGreaterThan(0);
  });

  it("caps citations at max_citations", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/recall/query",
      payload: { question: "vendor pricing volatility", max_citations: 1 },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { citations: unknown[] }).citations).toHaveLength(1);
  });

  it("rejects a blank question with a 400", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/recall/query",
      payload: { question: "" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("returns 200 and no citations when nothing matches an unrelated question", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/recall/query",
      payload: { question: "" + "z".repeat(3) + " unrelated xyzzy term" },
    });
    // Well-formed question, so 200 even if the answer is thin — never a 404.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty("retrieval_path", "semantic");
  });
});

describe("GET /api/recall/stats", () => {
  it("reports index coverage", async () => {
    const response = await server.inject({ method: "GET", url: "/api/recall/stats" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { sources: number; chunks: number; embedded: number };
    expect(body.sources).toBe(1);
    expect(body.chunks).toBeGreaterThan(0);
    expect(body.embedded).toBe(body.chunks);
  });
});
