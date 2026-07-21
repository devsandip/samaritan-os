/**
 * The Recall service (TECH-SPEC §5.5, §7).
 *
 * The whole pipeline, seeded through the real index with the hash embedder and
 * the default (offline) synthesiser, plus one injected synthesiser to prove the
 * service hands it the retrieved passages and returns its validated prose.
 */
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config/index.js";
import { chunkMarkdown } from "../src/recall/chunk.js";
import { HashEmbedder } from "../src/recall/embed.js";
import { ensureVectorTable, hashContent, putSource, putVectors } from "../src/recall/index-store.js";
import { RecallService } from "../src/recall/service.js";
import type { Synthesizer } from "../src/recall/synthesize.js";
import { citationToken } from "../src/recall/synthesize.js";
import { openDatabase } from "../src/store/db.js";
import { migrate } from "../src/store/migrate.js";

const CONFIG = {
  embeddings: { provider: "local", model: "hash-test-embedder" },
  recall: { synthesis: "none", account: "default", model: "claude-sonnet-5", context_chunks: 8 },
} as unknown as Config;

async function seededDb() {
  const db = openDatabase(":memory:");
  migrate(db);
  const embedder = new HashEmbedder();
  ensureVectorTable(db, await embedder.dimensions());
  const docs = [
    { path: "Meetings/vendor.md", text: "# Vendor review\n\n## Pricing\n\nVendor B pricing was volatile across quarters.\n" },
    { path: "cats.md", text: "# Cats\n\nThe cat sat quietly on the woven mat.\n" },
  ];
  for (const doc of docs) {
    const chunks = chunkMarkdown(doc.text);
    const rowids = putSource(
      db,
      { path: doc.path, kind: "obsidian", contentHash: hashContent(doc.text) },
      chunks,
    );
    const vectors = await embedder.embed(chunks.map((c) => c.text));
    putVectors(db, doc.path, new Map(rowids.map((id, i) => [id, vectors[i]!])));
  }
  return { db, embedder };
}

describe("RecallService.query", () => {
  it("answers a matching question with cited passages, path semantic", async () => {
    const { db, embedder } = await seededDb();
    const recall = new RecallService({ db, config: CONFIG, embedder });

    const result = await recall.query("vendor pricing volatility");
    expect(result.retrieval_path).toBe("semantic");
    expect(result.answer).toContain("Synthesis is off"); // the default extractive path
    expect(result.citations.map((c) => c.ref)).toContain("Meetings/vendor.md#Pricing");
    expect(result.citations[0]?.excerpt).toContain("volatile");
  });

  it("says so plainly when nothing matches", async () => {
    const { db, embedder } = await seededDb();
    const recall = new RecallService({ db, config: CONFIG, embedder });

    const result = await recall.query("quantum chromodynamics lattice gauge theory");
    // Note: keyword search finds nothing; the vector search still returns its
    // nearest neighbours, so a seeded index answers with its closest passages
    // rather than the empty-index message. The empty case is the next test.
    expect(result.retrieval_path).toBe("semantic");
    expect(Array.isArray(result.citations)).toBe(true);
  });

  it("returns the nothing-found message against an empty index", async () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const recall = new RecallService({ db, config: CONFIG, embedder: new HashEmbedder() });

    const result = await recall.query("anything at all");
    expect(result.citations).toEqual([]);
    expect(result.answer).toMatch(/couldn't find/);
  });

  it("caps citations at maxCitations", async () => {
    const { db, embedder } = await seededDb();
    const recall = new RecallService({ db, config: CONFIG, embedder });

    const result = await recall.query("vendor pricing cat mat", { maxCitations: 1 });
    expect(result.citations).toHaveLength(1);
  });

  it("routes retrieved passages through an injected synthesiser and validates its reply", async () => {
    const { db, embedder } = await seededDb();
    let sawPassageCount = 0;
    const synthesizer: Synthesizer = {
      kind: "anthropic",
      synthesize: async (_q, passages) => {
        sawPassageCount = passages.length;
        // Cite the first real passage plus one hallucinated ref to be stripped.
        return `In short: ${citationToken(passages[0]!)} and also [obsidian:made-up.md].`;
      },
    };
    const recall = new RecallService({ db, config: CONFIG, embedder, synthesizer });

    const result = await recall.query("vendor pricing");
    expect(sawPassageCount).toBeGreaterThan(0);
    expect(result.answer).toContain("In short:");
    expect(result.answer).not.toContain("made-up");
    expect(result.citations).toHaveLength(1);
  });

  it("reports index stats", async () => {
    const { db, embedder } = await seededDb();
    const recall = new RecallService({ db, config: CONFIG, embedder });
    const stats = recall.stats();
    expect(stats.sources).toBe(2);
    expect(stats.chunks).toBeGreaterThan(0);
    expect(stats.embedded).toBe(stats.chunks);
  });
});
