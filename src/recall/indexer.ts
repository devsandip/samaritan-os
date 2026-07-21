/**
 * The indexer (TECH-SPEC §7, "Ingestion").
 *
 * An index that nothing fills answers every question with silence, so this is the
 * job that walks the sources and puts chunks in front of retrieval: the Obsidian
 * vault, the per-project journals, and (in the audit half, below) the Action
 * Store's own trail. It is idempotent by content hash — a source whose text has
 * not changed since it was last embedded is skipped, so a re-run is cheap and a
 * cron can call it every few minutes without re-embedding the whole vault.
 *
 * Deletion is handled by absence: whatever `recall_sources` holds for a kind that
 * the walk did not turn up this run is pruned, so a note deleted on disk leaves
 * the index rather than lingering as a citation to a file that is gone.
 *
 * The walk itself is deliberately plain — no glob dependency, a hand-rolled
 * descent that skips the heavy directories (`node_modules`, `.git`) a naive
 * recursive read would drown in.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { log } from "../logger.js";
import type { Db } from "../store/db.js";
import { chunkMarkdown, chunkPlain } from "./chunk.js";
import type { Embedder } from "./embed.js";
import {
  deleteSource,
  ensureVectorTable,
  getSourceState,
  hashContent,
  listSourcePaths,
  putSource,
  putVectors,
  type SourceKind,
} from "./index-store.js";

const logger = log("recall.indexer");

export interface Doc {
  /** Stable key and citation base: a path relative to its root, or `audit/<id>`. */
  sourcePath: string;
  /** A source that cites by its own id rather than by path (audit, action item). */
  ref?: string;
  text: string;
}

export interface IndexTally {
  indexed: number;
  skipped: number;
  removed: number;
  chunks: number;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".obsidian", ".trash", ".vitepress"]);

/** Descends `root`, returning every `.md` file (as text) whose rel path `keep`s. */
export function collectMarkdown(root: string, keep: (rel: string) => boolean = () => true): Doc[] {
  const docs: Doc[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // an unreadable directory is skipped, not fatal to the whole walk
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(abs);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const rel = relative(root, abs);
        if (!keep(rel)) continue;
        try {
          docs.push({ sourcePath: rel, text: readFileSync(abs, "utf8") });
        } catch {
          // A file that vanished between readdir and read simply drops out.
        }
      }
    }
  }
  return docs;
}

export const collectVault = (vaultDir: string): Doc[] => collectMarkdown(vaultDir);

/** Journals are the `journal/` folders §6 watches, wherever they sit under a root. */
export const collectJournals = (root: string): Doc[] =>
  collectMarkdown(root, (rel) => rel.split(sep).includes("journal"));

/**
 * Indexes a list of docs of one kind, skipping any whose content hash is
 * unchanged and already embedded. Returns the tally and the set of paths seen,
 * which the caller uses to prune what has since been deleted.
 */
export async function indexDocuments(
  db: Db,
  embedder: Embedder,
  kind: SourceKind,
  docs: Doc[],
): Promise<{ tally: IndexTally; seen: Set<string> }> {
  const tally: IndexTally = { indexed: 0, skipped: 0, removed: 0, chunks: 0 };
  const seen = new Set<string>();
  const isMarkdown = kind === "obsidian" || kind === "journal";

  for (const doc of docs) {
    seen.add(doc.sourcePath);
    const contentHash = hashContent(doc.text);
    const existing = getSourceState(db, doc.sourcePath);
    if (existing && existing.content_hash === contentHash && existing.embedded) {
      tally.skipped += 1;
      continue;
    }

    const chunks = isMarkdown ? chunkMarkdown(doc.text) : chunkPlain(doc.text);
    if (!chunks.length) {
      // Nothing to embed. If a source that used to have chunks is now empty,
      // drop it rather than leave stale chunks pointing at deleted content.
      if (existing) {
        deleteSource(db, doc.sourcePath);
        tally.removed += 1;
      } else {
        tally.skipped += 1;
      }
      continue;
    }

    const rowids = putSource(
      db,
      { path: doc.sourcePath, kind, contentHash, ...(doc.ref ? { ref: doc.ref } : {}) },
      chunks,
    );
    const vectors = await embedder.embed(chunks.map((c) => c.text));
    putVectors(db, doc.sourcePath, new Map(rowids.map((id, i) => [id, vectors[i]!])));
    tally.indexed += 1;
    tally.chunks += chunks.length;
  }
  return { tally, seen };
}

/** Deletes every indexed source of `kind` that the latest walk did not turn up. */
export function pruneMissing(db: Db, kind: SourceKind, seen: Set<string>): number {
  let removed = 0;
  for (const path of listSourcePaths(db, kind)) {
    if (!seen.has(path)) {
      deleteSource(db, path);
      removed += 1;
    }
  }
  return removed;
}

export interface ReindexDeps {
  db: Db;
  embedder: Embedder;
  vaultDir: string;
  journalRoot?: string;
}

/** Reindexes the file sources (vault + journals) and prunes what is gone. */
export async function reindexFiles(deps: ReindexDeps): Promise<IndexTally> {
  ensureVectorTable(deps.db, await deps.embedder.dimensions());

  const total: IndexTally = { indexed: 0, skipped: 0, removed: 0, chunks: 0 };
  const kinds: [SourceKind, Doc[]][] = [["obsidian", collectVault(deps.vaultDir)]];
  if (deps.journalRoot) kinds.push(["journal", collectJournals(deps.journalRoot)]);

  for (const [kind, docs] of kinds) {
    const { tally, seen } = await indexDocuments(deps.db, deps.embedder, kind, docs);
    total.indexed += tally.indexed;
    total.skipped += tally.skipped;
    total.chunks += tally.chunks;
    total.removed += tally.removed + pruneMissing(deps.db, kind, seen);
  }

  logger.info(total, "reindexed files");
  return total;
}
