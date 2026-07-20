/**
 * Chunking and the index (TECH-SPEC §7).
 *
 * The embedder here is the deterministic hash stand-in, not the real model. The
 * real one downloads 90MB on first use and takes a minute, and none of what is
 * tested below depends on the vectors being semantic: it depends on them round
 * tripping through a BLOB column, ranking in the right direction, and staying in
 * step with the FTS mirror.
 */
import { describe, expect, it } from "vitest";
import { chunkMarkdown, chunkPlain, parseFrontmatter } from "../src/recall/chunk.js";
import { HashEmbedder, cosine, fromBlob, toBlob } from "../src/recall/embed.js";
import {
  chunksByRowid,
  deleteSource,
  ensureVectorTable,
  ftsQuery,
  getSourceState,
  hashContent,
  indexStats,
  keywordSearch,
  putSource,
  putVectors,
  vectorSearch,
} from "../src/recall/index-store.js";
import { openDatabase } from "../src/store/db.js";
import { migrate } from "../src/store/migrate.js";

function store() {
  const db = openDatabase(":memory:");
  migrate(db);
  return db;
}

const VAULT_NOTE = `---
date: 2026-06-30
tags: vendor, procurement
---

# Vendor review

Opening notes that belong to the H1 and nothing deeper.

## Pricing

Vendor B's tier pricing was volatile across the last two quarters.

## Decision

We picked Vendor A for the export pipeline.
`;

describe("frontmatter", () => {
  it("splits it off and keeps it out of the body", () => {
    const { frontmatter, body } = parseFrontmatter(VAULT_NOTE);
    expect(frontmatter["date"]).toBe("2026-06-30");
    expect(frontmatter["tags"]).toBe("vendor, procurement");
    expect(body).not.toContain("tags:");
    expect(body.trimStart().startsWith("# Vendor review")).toBe(true);
  });

  it("treats a malformed block as no frontmatter rather than failing the file", () => {
    const source = "---\nthis is not: really: yaml: at all\n---\nbody text";
    expect(parseFrontmatter(source).body).toBe("body text");
  });

  it("leaves a file with no frontmatter alone", () => {
    expect(parseFrontmatter("# Just a heading\n").frontmatter).toEqual({});
  });
});

describe("chunkMarkdown", () => {
  it("splits on headings and carries the full heading path", () => {
    const chunks = chunkMarkdown(VAULT_NOTE);
    const headings = chunks.map((c) => c.heading);

    expect(headings).toContain("Vendor review");
    // The path, not just the leaf: a citation naming only "Pricing" is
    // ambiguous across a vault where many notes have that heading.
    expect(headings).toContain("Vendor review ## Pricing");
    expect(headings).toContain("Vendor review ## Decision");
  });

  it("keeps every chunk's text with its own section", () => {
    const chunks = chunkMarkdown(VAULT_NOTE);
    const pricing = chunks.find((c) => c.heading.endsWith("Pricing"));
    expect(pricing?.text).toContain("volatile");
    expect(pricing?.text).not.toContain("export pipeline");
  });

  it("pops back out of a nested heading rather than nesting forever", () => {
    const source = "# A\n\ntext a\n\n## B\n\ntext b\n\n# C\n\ntext c\n";
    const headings = chunkMarkdown(source).map((c) => c.heading);
    expect(headings).toEqual(["A", "A ## B", "C"]);
  });

  it("splits an oversized section on paragraphs, with overlap", () => {
    // Each paragraph is distinct, so an overlap assertion cannot pass by
    // accidentally matching repeated filler.
    const paragraphs = Array.from(
      { length: 6 },
      (_, i) => `Paragraph ${i} marker${i}. ${`detail${i} `.repeat(120).trim()}`,
    );
    const chunks = chunkMarkdown(`# Big\n\n${paragraphs.join("\n\n")}\n`);

    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk still belongs to the section it came from.
    expect(chunks.every((c) => c.heading === "Big")).toBe(true);
    // Overlap: the tail of one chunk is repeated at the head of the next, so a
    // fact split across the boundary is still retrievable from one side of it.
    expect(chunks[1]!.text).toContain(chunks[0]!.text.slice(-30));
    // And it is a prefix, not just present somewhere.
    expect(chunks[1]!.text.indexOf(chunks[0]!.text.slice(-30))).toBeLessThan(
      Math.ceil(chunks[0]!.text.length * 0.15),
    );
  });

  it("splits a single paragraph that alone blows the cap", () => {
    const chunks = chunkMarkdown(`# X\n\n${"a".repeat(20000)}\n`);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("drops empty sections instead of indexing headings with no content", () => {
    const chunks = chunkMarkdown("# Empty\n\n## Also empty\n\n# Real\n\nhas text\n");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.heading).toBe("Real");
  });

  it("numbers chunks so a citation can point at one", () => {
    const chunks = chunkMarkdown(VAULT_NOTE);
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });
});

describe("chunkPlain", () => {
  it("chunks text with no headings", () => {
    expect(chunkPlain("just some text")).toHaveLength(1);
    expect(chunkPlain("")).toEqual([]);
  });
});

describe("vector round trip", () => {
  it("survives the BLOB column unchanged", async () => {
    const [vector] = await new HashEmbedder(16).embed(["vendor pricing"]);
    const round = fromBlob(toBlob(vector!));
    expect([...round]).toEqual([...vector!]);
  });

  it("scores identical text at 1 and unrelated text well below", async () => {
    const embedder = new HashEmbedder();
    const [a, b, c] = await embedder.embed([
      "vendor pricing volatility",
      "vendor pricing volatility",
      "the cat sat on the mat",
    ]);
    expect(cosine(a!, b!)).toBeCloseTo(1, 5);
    expect(cosine(a!, c!)).toBeLessThan(0.5);
  });
});

describe("the index", () => {
  it("writes chunks, the FTS mirror and the source record together", () => {
    const db = store();
    const chunks = chunkMarkdown(VAULT_NOTE).map((c) => ({
      text: c.text,
      heading: c.heading,
      index: c.index,
    }));

    const rowids = putSource(
      db,
      { path: "Meetings/vendor.md", kind: "obsidian", contentHash: hashContent(VAULT_NOTE) },
      chunks,
    );

    expect(rowids).toHaveLength(chunks.length);
    expect(getSourceState(db, "Meetings/vendor.md")?.chunk_count).toBe(chunks.length);
    expect(keywordSearch(db, "volatile pricing", 10).length).toBeGreaterThan(0);
  });

  it("re-indexing replaces rather than duplicates", () => {
    const db = store();
    const put = (text: string) =>
      putSource(
        db,
        { path: "note.md", kind: "obsidian", contentHash: hashContent(text) },
        chunkMarkdown(text),
      );

    put("# A\n\nfirst version\n");
    put("# A\n\nsecond version\n");

    expect(indexStats(db).chunks).toBe(1);
    // The old text must be gone from FTS too, or a search keeps hitting a
    // version of the file that no longer exists.
    expect(keywordSearch(db, "first", 10)).toHaveLength(0);
    expect(keywordSearch(db, "second", 10)).toHaveLength(1);
  });

  it("deleting a source clears its chunks and its FTS postings", () => {
    const db = store();
    putSource(
      db,
      { path: "gone.md", kind: "obsidian", contentHash: "h" },
      chunkMarkdown("# Gone\n\nephemeral content here\n"),
    );
    deleteSource(db, "gone.md");

    expect(indexStats(db).chunks).toBe(0);
    expect(keywordSearch(db, "ephemeral", 10)).toHaveLength(0);
    expect(getSourceState(db, "gone.md")).toBeUndefined();
  });

  it("actually loads sqlite-vec rather than quietly scanning", () => {
    // The fallback is deliberate but it is not the intended path, and it is
    // invisible: every other test here passes either way. This one fails if the
    // extension stops loading, which is how a silent degrade gets noticed.
    const db = store();
    expect(ensureVectorTable(db, 64)).toBe(true);
    expect(indexStats(db).vector_index).toBe(true);
  });

  it("ranks by vector similarity, whichever path is taken", async () => {
    const db = store();
    const embedder = new HashEmbedder();
    expect(ensureVectorTable(db, await embedder.dimensions())).toBe(true);

    const docs = [
      { path: "a.md", text: "# A\n\nvendor pricing volatility across quarters\n" },
      { path: "b.md", text: "# B\n\nthe cat sat quietly on the woven mat\n" },
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

    const [query] = await embedder.embed(["vendor pricing volatility"]);
    const hits = vectorSearch(db, query!, 2);

    expect(hits).toHaveLength(2);
    const top = chunksByRowid(db, [hits[0]!.rowid]).get(hits[0]!.rowid);
    expect(top?.source_path).toBe("a.md");
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it("marks a source embedded only once its vectors are attached", async () => {
    const db = store();
    const embedder = new HashEmbedder();
    const chunks = chunkMarkdown("# X\n\nsome content\n");
    const rowids = putSource(
      db,
      { path: "x.md", kind: "obsidian", contentHash: "h" },
      chunks,
    );

    expect(getSourceState(db, "x.md")?.embedded).toBe(0);
    expect(indexStats(db).embedded).toBe(0);

    const vectors = await embedder.embed(chunks.map((c) => c.text));
    putVectors(db, "x.md", new Map(rowids.map((id, i) => [id, vectors[i]!])));

    expect(getSourceState(db, "x.md")?.embedded).toBe(1);
    expect(indexStats(db).embedded).toBe(chunks.length);
  });
});

describe("ftsQuery", () => {
  it("quotes every term so FTS5 syntax in a question is read as words", () => {
    // "AND", "NOT" and "*" are operators. A question containing them must not
    // become a different query, or a search for a NOT gate returns nothing.
    expect(ftsQuery("why NOT vendor AND pricing*")).toBe(
      '"why" OR "not" OR "vendor" OR "and" OR "pricing"',
    );
  });

  it("drops words too short to discriminate", () => {
    // Two characters or fewer carry almost no signal and match huge swathes of
    // any index, so they are dropped rather than OR-ed in.
    expect(ftsQuery("is it a go")).toBe("");
    expect(ftsQuery("is it a good idea")).toBe('"good" OR "idea"');
  });

  it("survives a question that is all punctuation", () => {
    expect(ftsQuery("??? !!!")).toBe("");
    const db = store();
    expect(keywordSearch(db, "???", 5)).toEqual([]);
  });
});
