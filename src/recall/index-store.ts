/**
 * The Recall index: chunk rows, their FTS mirror, and the vector table (§7).
 *
 * Three stores kept in step for one logical thing:
 *  - `recall_chunks` is the record of truth, with the text and its citation ref.
 *  - `recall_chunks_fts` is the FTS5 mirror for the keyword half of retrieval.
 *    It is an external-content table, so it is written explicitly rather than by
 *    trigger, and a delete has to pass the old text back to FTS5 to undo the
 *    posting list.
 *  - `vec_recall_chunks` is the sqlite-vec kNN index, created on demand because
 *    it only exists when the extension is loaded.
 *
 * Everything degrades if sqlite-vec is missing: `vectorSearch` scans and sorts
 * in JS instead. At one person's vault that is milliseconds, and a Recall that
 * works without a native extension is worth more than one that refuses to start.
 */
import { createHash } from "node:crypto";
import type { Db } from "../store/db.js";
import { log } from "../logger.js";
import { fromBlob, toBlob } from "./embed.js";

const logger = log("recall.index");

export type SourceKind = "obsidian" | "journal" | "action_item" | "audit";

export interface ChunkRow {
  rowid: number;
  source_kind: SourceKind;
  source_path: string;
  source_ref: string | null;
  heading: string | null;
  chunk_text: string;
  chunk_index: number;
}

export interface PendingChunk {
  text: string;
  heading: string;
  index: number;
}

export function hashContent(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Which connections have sqlite-vec loaded.
 *
 * Per connection, not per process. Extension loading is a property of the
 * SQLite handle, so caching it in a module-level flag makes the second
 * connection claim an extension it never loaded, and the first query against it
 * fails with "no such module: vec0" long after the misleading success.
 */
const loaded = new WeakMap<object, boolean>();

/**
 * Loads sqlite-vec into this connection, once.
 *
 * The extension is what makes kNN an index lookup rather than a scan. It is
 * genuinely optional: a missing binary degrades the search, it does not break
 * it, so this reports rather than throws.
 */
export function loadVectorExtension(db: Db): boolean {
  const known = loaded.get(db);
  if (known !== undefined) return known;
  try {
    // `db.raw`, not `db`. The wrapper has no `enableLoadExtension`, so calling
    // it through an optional chain on the wrapper silently does nothing and the
    // load below fails in a way that looks like a missing binary.
    const raw = db.raw as unknown as { enableLoadExtension(on: boolean): void };
    raw.enableLoadExtension(true);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sqliteVec = require("sqlite-vec") as { load(db: unknown): void };
    sqliteVec.load(db.raw);
    db.prepare("SELECT vec_version()").get();
    loaded.set(db, true);
    logger.info("sqlite-vec loaded");
  } catch (err) {
    loaded.set(db, false);
    logger.warn(
      { err: String(err) },
      "sqlite-vec unavailable; falling back to a scan for vector search",
    );
  }
  return loaded.get(db) === true;
}

/** True once this connection has the extension. Does not attempt to load it. */
function hasVector(db: Db): boolean {
  return loaded.get(db) === true;
}

/**
 * Creates the vec0 table if the extension is available.
 *
 * Not a migration: a migration that referenced vec0 would make the database
 * unopenable on a machine without the extension, which is a much worse failure
 * than a slower search.
 */
export function ensureVectorTable(db: Db, dimensions: number): boolean {
  if (!loadVectorExtension(db)) return false;
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS vec_recall_chunks
       USING vec0(embedding float[${dimensions}])`,
  );
  return true;
}

export interface SourceState {
  source_path: string;
  content_hash: string;
  chunk_count: number;
  embedded: number;
}

export function getSourceState(db: Db, sourcePath: string): SourceState | undefined {
  return db
    .prepare<SourceState>(
      "SELECT source_path, content_hash, chunk_count, embedded FROM recall_sources WHERE source_path = ?",
    )
    .get(sourcePath);
}

export function listSourcePaths(db: Db, kind?: SourceKind): string[] {
  const rows = kind
    ? db
        .prepare<{ source_path: string }>(
          "SELECT source_path FROM recall_sources WHERE source_kind = ?",
        )
        .all(kind)
    : db.prepare<{ source_path: string }>("SELECT source_path FROM recall_sources").all();
  return rows.map((r) => r.source_path);
}

/** Removes a source and everything derived from it, keeping all three stores in step. */
export function deleteSource(db: Db, sourcePath: string): void {
  db.transaction(() => {
    const rows = db
      .prepare<{ rowid: number; chunk_text: string; source_kind: string }>(
        "SELECT rowid, chunk_text, source_kind FROM recall_chunks WHERE source_path = ?",
      )
      .all(sourcePath);

    for (const row of rows) {
      // FTS5 external-content tables need the original values handed back on
      // delete, or the posting list keeps pointing at a rowid that is gone and
      // the next search returns a phantom hit.
      db.prepare(
        `INSERT INTO recall_chunks_fts(recall_chunks_fts, rowid, chunk_text, source_path, source_kind)
         VALUES ('delete', ?, ?, ?, ?)`,
      ).run(BigInt(row.rowid), row.chunk_text, sourcePath, row.source_kind);

      if (hasVector(db)) {
        try {
          db.prepare("DELETE FROM vec_recall_chunks WHERE rowid = ?").run(BigInt(row.rowid));
        } catch {
          // The vec table may not exist yet on a database that has chunks but
          // has never embedded. Nothing to unlink in that case.
        }
      }
    }

    db.prepare("DELETE FROM recall_chunks WHERE source_path = ?").run(sourcePath);
    db.prepare("DELETE FROM recall_sources WHERE source_path = ?").run(sourcePath);
  });
}

/**
 * Replaces a source's chunks. Returns the rowids written, in chunk order, so the
 * caller can attach vectors without re-reading them.
 */
export function putSource(
  db: Db,
  source: { path: string; kind: SourceKind; ref?: string; contentHash: string },
  chunks: PendingChunk[],
): number[] {
  return db.transaction(() => {
    deleteSource(db, source.path);

    const now = new Date().toISOString();
    const insert = db.prepare(
      `INSERT INTO recall_chunks
         (source_kind, source_path, source_ref, heading, chunk_text, chunk_index, content_hash, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const intoFts = db.prepare(
      `INSERT INTO recall_chunks_fts(rowid, chunk_text, source_path, source_kind)
       VALUES (?, ?, ?, ?)`,
    );

    const rowids: number[] = [];
    for (const chunk of chunks) {
      const result = insert.run(
        source.kind,
        source.path,
        source.ref ?? null,
        chunk.heading || null,
        chunk.text,
        chunk.index,
        source.contentHash,
        now,
      );
      const rowid = Number(result.lastInsertRowid);
      rowids.push(rowid);
      intoFts.run(BigInt(rowid), chunk.text, source.path, source.kind);
    }

    db.prepare(
      `INSERT INTO recall_sources (source_path, source_kind, content_hash, chunk_count, embedded, indexed_at)
       VALUES (?, ?, ?, ?, 0, ?)
       ON CONFLICT(source_path) DO UPDATE SET
         source_kind = excluded.source_kind, content_hash = excluded.content_hash,
         chunk_count = excluded.chunk_count, embedded = 0, indexed_at = excluded.indexed_at`,
    ).run(source.path, source.kind, source.contentHash, chunks.length, now);

    return rowids;
  });
}

/** Attaches vectors to chunks already written, and marks their source embedded. */
export function putVectors(
  db: Db,
  sourcePath: string,
  vectors: Map<number, Float32Array>,
): void {
  const useVec = hasVector(db);
  db.transaction(() => {
    const update = db.prepare("UPDATE recall_chunks SET embedding = ? WHERE rowid = ?");
    // Delete-then-insert, not UPSERT: vec0 is a virtual table and SQLite has no
    // UPSERT for one, so `ON CONFLICT DO UPDATE` fails at prepare time.
    const dropVec = useVec
      ? db.prepare("DELETE FROM vec_recall_chunks WHERE rowid = ?")
      : undefined;
    const intoVec = useVec
      ? db.prepare("INSERT INTO vec_recall_chunks(rowid, embedding) VALUES (?, ?)")
      : undefined;

    for (const [rowid, vector] of vectors) {
      const blob = toBlob(vector);
      // BigInt, not Number: sqlite-vec rejects a float-typed primary key, and
      // node:sqlite binds a JS number as a double. This is the whole reason
      // rowids are threaded around as bigints down here.
      update.run(blob, BigInt(rowid));
      dropVec?.run(BigInt(rowid));
      intoVec?.run(BigInt(rowid), blob);
    }

    db.prepare("UPDATE recall_sources SET embedded = 1 WHERE source_path = ?").run(sourcePath);
  });
}

export interface Scored {
  rowid: number;
  score: number;
}

/** kNN by vector, through the extension when present and by scan when not. */
export function vectorSearch(db: Db, query: Float32Array, limit: number): Scored[] {
  if (hasVector(db)) {
    try {
      const rows = db
        .prepare<{ rowid: number; distance: number }>(
          `SELECT rowid, distance FROM vec_recall_chunks
            WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
        )
        .all(toBlob(query), BigInt(limit));
      // Vectors are normalised, so L2 distance and cosine rank identically.
      // Reported as a similarity so both retrieval paths agree on direction.
      return rows.map((r) => ({ rowid: r.rowid, score: 1 / (1 + r.distance) }));
    } catch (err) {
      logger.warn({ err: String(err) }, "vec search failed; scanning instead");
    }
  }

  const rows = db
    .prepare<{ rowid: number; embedding: Uint8Array | null }>(
      "SELECT rowid, embedding FROM recall_chunks WHERE embedding IS NOT NULL",
    )
    .all();

  const scored: Scored[] = [];
  for (const row of rows) {
    if (!row.embedding) continue;
    const vector = fromBlob(row.embedding);
    if (vector.length !== query.length) continue;
    let dot = 0;
    for (let i = 0; i < query.length; i++) dot += (query[i] ?? 0) * (vector[i] ?? 0);
    scored.push({ rowid: row.rowid, score: dot });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/** Escapes a user question into an FTS5 MATCH expression. */
export function ftsQuery(question: string): string {
  const terms = (question.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? [])
    .filter((t) => t.length > 2)
    .slice(0, 24);
  // Quoted individually so FTS5 operators a question happens to contain (AND,
  // NOT, *, ^, :) are read as words rather than syntax.
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

export function keywordSearch(db: Db, question: string, limit: number): Scored[] {
  const match = ftsQuery(question);
  if (!match) return [];
  try {
    return db
      .prepare<{ rowid: number; rank: number }>(
        `SELECT rowid, rank FROM recall_chunks_fts
          WHERE recall_chunks_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(match, BigInt(limit))
      .map((r) => ({ rowid: r.rowid, score: -r.rank }));
  } catch (err) {
    logger.warn({ err: String(err) }, "fts search failed");
    return [];
  }
}

export function chunksByRowid(db: Db, rowids: number[]): Map<number, ChunkRow> {
  if (!rowids.length) return new Map();
  const placeholders = rowids.map(() => "?").join(", ");
  const rows = db
    .prepare<ChunkRow>(
      `SELECT rowid, source_kind, source_path, source_ref, heading, chunk_text, chunk_index
         FROM recall_chunks WHERE rowid IN (${placeholders})`,
    )
    .all(...rowids.map((r) => BigInt(r)));
  return new Map(rows.map((row) => [row.rowid, row]));
}

export interface IndexStats {
  sources: number;
  chunks: number;
  embedded: number;
  vector_index: boolean;
}

export function indexStats(db: Db): IndexStats {
  const sources = db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM recall_sources").get();
  const chunks = db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM recall_chunks").get();
  const embedded = db
    .prepare<{ n: number }>("SELECT COUNT(*) AS n FROM recall_chunks WHERE embedding IS NOT NULL")
    .get();
  return {
    sources: sources?.n ?? 0,
    chunks: chunks?.n ?? 0,
    embedded: embedded?.n ?? 0,
    vector_index: hasVector(db),
  };
}
