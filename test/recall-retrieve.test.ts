/**
 * The semantic retrieval path (TECH-SPEC §7 step 3).
 *
 * HashEmbedder again — deterministic, no download — because what is under test is
 * the plumbing: that both retrievers feed the fusion, that the survivors hydrate
 * into cited passages, and that losing either retriever degrades the result
 * rather than emptying it. The vectors only have to rank in the right direction,
 * which token-hash cosine does.
 */
import { describe, expect, it } from "vitest";
import { HashEmbedder } from "../src/recall/embed.js";
import {
  ensureVectorTable,
  hashContent,
  putSource,
  putVectors,
  type SourceKind,
} from "../src/recall/index-store.js";
import { chunkMarkdown } from "../src/recall/chunk.js";
import { citationRef, retrieve } from "../src/recall/retrieve.js";
import { openDatabase } from "../src/store/db.js";
import { migrate } from "../src/store/migrate.js";

const DOCS: { path: string; kind: SourceKind; text: string }[] = [
  {
    path: "Meetings/vendor.md",
    kind: "obsidian",
    text: "# Vendor review\n\n## Pricing\n\nVendor B pricing was volatile across quarters.\n\n## Decision\n\nWe picked Vendor A for the export pipeline.\n",
  },
  { path: "cats.md", kind: "obsidian", text: "# Cats\n\nThe cat sat quietly on the woven mat.\n" },
  {
    path: "journal/retro.md",
    kind: "journal",
    text: "# Retrospective\n\nThe claim before fire pattern held again for reconciliation.\n",
  },
];

async function seed(embed: boolean) {
  const db = openDatabase(":memory:");
  migrate(db);
  const embedder = new HashEmbedder();
  if (embed) ensureVectorTable(db, await embedder.dimensions());
  for (const doc of DOCS) {
    const chunks = chunkMarkdown(doc.text);
    const rowids = putSource(
      db,
      { path: doc.path, kind: doc.kind, contentHash: hashContent(doc.text) },
      chunks,
    );
    if (embed) {
      const vectors = await embedder.embed(chunks.map((c) => c.text));
      putVectors(db, doc.path, new Map(rowids.map((id, i) => [id, vectors[i]!])));
    }
  }
  return { db, embedder };
}

describe("retrieve", () => {
  it("fuses both retrievers and cites the top passage by path#heading", async () => {
    const { db, embedder } = await seed(true);
    const passages = await retrieve(db, embedder, "vendor pricing volatility");

    expect(passages[0]?.source_path).toBe("Meetings/vendor.md");
    expect(passages[0]?.heading).toContain("Pricing");
    expect(passages[0]?.ref).toBe("Meetings/vendor.md#Pricing");
    expect(passages[0]?.kind).toBe("obsidian");
    // The Pricing chunk matches on both words and both vectors, so both
    // retrievers surface it — the strongest possible signal.
    expect(passages[0]?.retrievers.sort()).toEqual(["keyword", "vector"]);
    expect(passages[0]?.text).toContain("volatile");
  });

  it("degrades to keyword-only when nothing is embedded", async () => {
    const { db, embedder } = await seed(false); // putSource, no putVectors
    const passages = await retrieve(db, embedder, "vendor pricing");

    expect(passages.length).toBeGreaterThan(0);
    expect(passages[0]?.source_path).toBe("Meetings/vendor.md");
    // No vectors in the index, so every hit came from keyword search alone.
    expect(passages.every((p) => p.retrievers.length === 1 && p.retrievers[0] === "keyword")).toBe(
      true,
    );
  });

  it("degrades to vector-only when the question is all stopwords", async () => {
    const { db, embedder } = await seed(true);
    // Every token is <= 2 chars, so ftsQuery yields nothing and keyword search
    // returns []. Only "on" overlaps a chunk, so the vector search still ranks.
    const passages = await retrieve(db, embedder, "is it on");

    expect(passages.length).toBeGreaterThan(0);
    expect(passages[0]?.source_path).toBe("cats.md");
    expect(passages.every((p) => p.retrievers.length === 1 && p.retrievers[0] === "vector")).toBe(
      true,
    );
  });

  it("keeps at most `limit` passages", async () => {
    const { db, embedder } = await seed(true);
    const passages = await retrieve(db, embedder, "vendor pricing pipeline reconciliation", {
      limit: 1,
    });
    expect(passages).toHaveLength(1);
  });

  it("returns nothing for a blank question or an empty index", async () => {
    const { db, embedder } = await seed(true);
    expect(await retrieve(db, embedder, "   ")).toEqual([]);

    const empty = openDatabase(":memory:");
    migrate(empty);
    expect(await retrieve(empty, embedder, "anything at all")).toEqual([]);
  });
});

describe("citationRef", () => {
  it("cites a markdown chunk by path and nearest heading", () => {
    expect(
      citationRef({
        source_kind: "obsidian",
        source_path: "Meetings/vendor.md",
        source_ref: null,
        heading: "Vendor review ## Pricing",
      }),
    ).toBe("Meetings/vendor.md#Pricing");
  });

  it("cites a headingless markdown chunk by path alone", () => {
    expect(
      citationRef({
        source_kind: "journal",
        source_path: "journal/retro.md",
        source_ref: null,
        heading: null,
      }),
    ).toBe("journal/retro.md");
  });

  it("prefers a source's own ref when it has one", () => {
    expect(
      citationRef({
        source_kind: "audit",
        source_path: "audit/act_123",
        source_ref: "act_123",
        heading: null,
      }),
    ).toBe("act_123");
  });
});
