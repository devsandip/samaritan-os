/**
 * The indexer's file half (TECH-SPEC §7, "Ingestion").
 *
 * Real temp directories rather than mocks: the walk, the skip list and the
 * relative-path keys are exactly the parts a mock would paper over, and they are
 * what a citation ref is built from. The hash embedder keeps it offline.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config/index.js";
import { HashEmbedder } from "../src/recall/embed.js";
import {
  collectJournals,
  collectVault,
  indexDocuments,
  pruneMissing,
  reindexFiles,
  type Doc,
} from "../src/recall/indexer.js";
import { getSourceState } from "../src/recall/index-store.js";
import { RecallService } from "../src/recall/service.js";
import { openDatabase } from "../src/store/db.js";
import { migrate } from "../src/store/migrate.js";

const CONFIG = {
  embeddings: { provider: "local", model: "hash-test-embedder" },
  recall: { synthesis: "none", account: "default", model: "claude-sonnet-5", context_chunks: 8 },
} as unknown as Config;

const roots: string[] = [];
function tree() {
  const base = mkdtempSync(join(tmpdir(), "recall-idx-"));
  roots.push(base);
  const write = (rel: string, text: string) => {
    const abs = join(base, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, text);
    return abs;
  };
  return { base, write };
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function db() {
  const d = openDatabase(":memory:");
  migrate(d);
  return d;
}

describe("collectVault / collectJournals", () => {
  it("finds every markdown file but skips heavy directories", () => {
    const { base, write } = tree();
    write("note.md", "# Note\n\nvendor pricing\n");
    write("sub/deep.md", "# Deep\n\ncats on the mat\n");
    write("node_modules/pkg/readme.md", "# Skip me\n");
    write("notes.txt", "not markdown");

    const paths = collectVault(base)
      .map((d) => d.sourcePath)
      .sort();
    expect(paths).toEqual(["note.md", join("sub", "deep.md")]);
  });

  it("keeps only files under a journal/ segment", () => {
    const { base, write } = tree();
    write("proj/journal/entries/j1.md", "# Journal\n\nreconciliation\n");
    write("proj/src/code.md", "# Code\n\nnot a journal\n");

    const paths = collectJournals(base).map((d) => d.sourcePath);
    expect(paths).toEqual([join("proj", "journal", "entries", "j1.md")]);
  });
});

describe("indexDocuments", () => {
  const docs = (text: string): Doc[] => [{ sourcePath: "a.md", text }];

  it("indexes, then skips unchanged content, then re-indexes a change", async () => {
    const d = db();
    const embedder = new HashEmbedder();

    const first = await indexDocuments(d, embedder, "obsidian", docs("# A\n\noriginal text here\n"));
    expect(first.tally.indexed).toBe(1);
    expect(first.tally.chunks).toBeGreaterThan(0);
    const hash1 = getSourceState(d, "a.md")?.content_hash;

    const second = await indexDocuments(d, embedder, "obsidian", docs("# A\n\noriginal text here\n"));
    expect(second.tally.skipped).toBe(1);
    expect(second.tally.indexed).toBe(0);
    expect(getSourceState(d, "a.md")?.content_hash).toBe(hash1); // untouched

    const third = await indexDocuments(d, embedder, "obsidian", docs("# A\n\nrewritten entirely\n"));
    expect(third.tally.indexed).toBe(1);
    expect(getSourceState(d, "a.md")?.content_hash).not.toBe(hash1); // re-hashed
  });

  it("prunes a source that the latest walk did not turn up", async () => {
    const d = db();
    const embedder = new HashEmbedder();
    await indexDocuments(d, embedder, "obsidian", [
      { sourcePath: "keep.md", text: "# K\n\nkept\n" },
      { sourcePath: "drop.md", text: "# D\n\ndropped\n" },
    ]);

    const removed = pruneMissing(d, "obsidian", new Set(["keep.md"]));
    expect(removed).toBe(1);
    expect(getSourceState(d, "drop.md")).toBeUndefined();
    expect(getSourceState(d, "keep.md")).toBeDefined();
  });
});

describe("reindexFiles", () => {
  it("indexes vault and journals, and the content is then queryable", async () => {
    const { base: vault, write: wv } = tree();
    wv("Meetings/vendor.md", "# Vendor review\n\n## Pricing\n\nVendor B pricing was volatile.\n");
    const { base: dev, write: wd } = tree();
    wd("proj/journal/retro.md", "# Retro\n\nThe claim before fire pattern held.\n");
    wd("proj/node_modules/x/skip.md", "# skip\n");

    const d = db();
    const embedder = new HashEmbedder();
    const tally = await reindexFiles({ db: d, embedder, vaultDir: vault, journalRoot: dev });
    expect(tally.indexed).toBe(2); // one vault note, one journal, node_modules skipped
    expect(tally.chunks).toBeGreaterThanOrEqual(2);

    const recall = new RecallService({ db: d, config: CONFIG, embedder });
    const answer = await recall.query("vendor pricing volatile");
    expect(answer.citations.map((c) => c.ref)).toContain("Meetings/vendor.md#Pricing");
  });
});
