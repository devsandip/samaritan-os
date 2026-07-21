#!/usr/bin/env node
/**
 * `samaritan index` (TECH-SPEC §7).
 *
 * Fills the Recall index from the vault, the journals and the audit trail, so
 * Ask-Samaritan has something to answer from. Idempotent by content hash, so a
 * re-run only touches what changed — safe to put on a cron.
 *
 *   pnpm index            # index everything, print a tally
 *   pnpm index --stats    # print index coverage only, index nothing
 *
 * The first run with the local embedder downloads the model (~90MB) and takes
 * about a minute; later runs are fast. This is a thin shell: the walk, the
 * chunking and the skip-by-hash all live in src/recall/indexer.ts.
 */
import { createApp } from "../app.js";
import { createEmbedder } from "../recall/embed.js";
import { indexStats } from "../recall/index-store.js";
import { reindex } from "../recall/indexer.js";

const statsOnly = process.argv.slice(2).includes("--stats");
const app = createApp();

try {
  if (statsOnly) {
    const s = indexStats(app.db);
    console.log(
      `sources ${s.sources} · chunks ${s.chunks} · embedded ${s.embedded} · ` +
        `vector index ${s.vector_index ? "on" : "off (scan fallback)"}`,
    );
  } else {
    const { vault, journals } = app.config.paths;
    const embedder = createEmbedder(app.config.embeddings.provider, app.config.embeddings.model);
    console.log(`Indexing ${vault} and journals under ${journals} …`);

    const tally = await reindex({ db: app.db, embedder, vaultDir: vault, journalRoot: journals });
    console.log(
      `Indexed ${tally.indexed}, skipped ${tally.skipped} unchanged, removed ${tally.removed}; ` +
        `${tally.chunks} chunks embedded this run.`,
    );
    const s = indexStats(app.db);
    console.log(`Index now holds ${s.chunks} chunks across ${s.sources} sources.`);
  }
} finally {
  app.close();
}
