/**
 * Indexing the audit trail (TECH-SPEC §7 names it a first-class RAG source).
 *
 * renderAuditDoc is pure, so it is asserted directly; reindexAudit then goes
 * through the real store — a created item and its trail — to prove the rendered
 * block is retrievable, which is the whole reason to index it.
 */
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config/index.js";
import { HashEmbedder } from "../src/recall/embed.js";
import { reindexAudit, renderAuditDoc } from "../src/recall/indexer.js";
import { RecallService } from "../src/recall/service.js";
import { createActionItem, listAuditTrail } from "../src/store/action-items.js";
import { testContext, testDraft, testStore } from "./helpers.js";

const CONFIG = {
  embeddings: { provider: "local", model: "hash-test-embedder" },
  recall: { synthesis: "none", account: "default", model: "claude-sonnet-5", context_chunks: 8 },
} as unknown as Config;

describe("renderAuditDoc", () => {
  it("renders an item and its trail into a searchable block keyed by id", () => {
    const db = testStore();
    const item = createActionItem(
      db,
      testDraft({ context: testContext({ what_happened: "Wrapped the vendor pricing session" }) }),
    );
    const doc = renderAuditDoc(item, listAuditTrail(db, item.id));

    expect(doc.sourcePath).toBe(`audit/${item.id}`);
    expect(doc.ref).toBe(item.id);
    expect(doc.text).toContain("Wrapped the vendor pricing session");
    expect(doc.text).toContain("Status: pending");
    expect(doc.text).toContain("Decision: File this decision to Notion?");
    expect(doc.text).toContain("Trail:"); // the creation event at least
  });
});

describe("reindexAudit", () => {
  it("indexes the trail so a past decision is queryable, cited as audit", async () => {
    const db = testStore();
    createActionItem(
      db,
      testDraft({
        context: testContext({
          what_happened: "Decided to use SQLite for the store",
          decision_needed: "File this storage decision?",
        }),
        custom: { title: "Use node:sqlite", kind: "decision" },
      }),
    );

    const embedder = new HashEmbedder();
    const tally = await reindexAudit({ db, embedder });
    expect(tally.indexed).toBeGreaterThan(0);

    const recall = new RecallService({ db, config: CONFIG, embedder });
    const answer = await recall.query("sqlite storage decision");
    expect(answer.citations.length).toBeGreaterThan(0);
    expect(answer.citations[0]?.kind).toBe("audit");
  });

  it("skips an unchanged trail on a second run", async () => {
    const db = testStore();
    createActionItem(db, testDraft());
    const embedder = new HashEmbedder();

    const first = await reindexAudit({ db, embedder });
    expect(first.indexed).toBe(1);
    const second = await reindexAudit({ db, embedder });
    expect(second.indexed).toBe(0);
    expect(second.skipped).toBe(1);
  });
});
