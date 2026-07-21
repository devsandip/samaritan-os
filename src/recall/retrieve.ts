/**
 * The semantic retrieval path (TECH-SPEC §7 step 3).
 *
 * One question in, a ranked list of cited passages out. The steps are: embed the
 * question with the same model that indexed the chunks; take the vector kNN top
 * candidates and the BM25 keyword top candidates over the same chunk set; fuse
 * the two rankings with RRF; and hydrate the survivors into passages carrying the
 * text and a citation ref. Everything downstream — synthesis, the API, the UI —
 * reads passages, so this is the one place that knows how a chunk row becomes a
 * citation.
 *
 * It degrades on every axis rather than failing. No embedded vectors yet (an
 * index built but never embedded, or sqlite-vec missing) leaves keyword search
 * carrying the query alone; a question of only stopwords leaves the vector search
 * carrying it; an empty index returns nothing. A partial answer beats a refusal
 * for a personal OS you are asking about your own notes.
 */
import type { Db } from "../store/db.js";
import type { Embedder } from "./embed.js";
import { reciprocalRankFusion } from "./fuse.js";
import { chunksByRowid, keywordSearch, vectorSearch, type ChunkRow, type SourceKind } from "./index-store.js";

export interface Passage {
  rowid: number;
  /** What the chunk was drawn from: a vault note, a journal, an audit trail. */
  kind: SourceKind;
  /** Citation ref: a file path (+ `#heading`) or the source's own ref/id. */
  ref: string;
  source_path: string;
  heading: string | null;
  text: string;
  /** Fused RRF score; higher is better, not comparable across questions. */
  score: number;
  /** Which retrievers surfaced it. Two names means vector and keyword agreed. */
  retrievers: string[];
}

export interface RetrieveOptions {
  /** Per-retriever candidate depth before fusion. §7 step 3 says top-20. */
  candidates?: number;
  /** Fused passages kept. §7 step 3 says ~8. */
  limit?: number;
}

const DEFAULTS = { candidates: 20, limit: 8 } as const;

/**
 * Builds the citation ref for a chunk. A source that carries its own ref (an
 * audit event, an action item) cites by that; a markdown file cites by path, and
 * by `path#heading` when the chunk sits under a heading — the anchor is the last
 * segment of the `A ## B ## C` heading path, which is the nearest one.
 */
export function citationRef(row: Pick<ChunkRow, "source_kind" | "source_path" | "source_ref" | "heading">): string {
  if (row.source_ref) return row.source_ref;
  const isFile = row.source_kind === "obsidian" || row.source_kind === "journal";
  if (isFile && row.heading) {
    const anchor = row.heading.split(" ## ").pop()?.trim();
    if (anchor) return `${row.source_path}#${anchor}`;
  }
  return row.source_path;
}

export async function retrieve(
  db: Db,
  embedder: Embedder,
  question: string,
  options: RetrieveOptions = {},
): Promise<Passage[]> {
  const candidates = options.candidates ?? DEFAULTS.candidates;
  const limit = options.limit ?? DEFAULTS.limit;

  const query = question.trim();
  if (!query) return [];

  // The embed can fail (model download, WASM), and a broken embedder must not
  // sink the whole query when keyword search would still answer it.
  let vector: Awaited<ReturnType<typeof vectorSearch>> = [];
  try {
    const [queryVector] = await embedder.embed([query]);
    if (queryVector) vector = vectorSearch(db, queryVector, candidates);
  } catch {
    vector = [];
  }
  const keyword = keywordSearch(db, query, candidates);

  const fused = reciprocalRankFusion(
    [
      { name: "vector", hits: vector },
      { name: "keyword", hits: keyword },
    ],
    { limit },
  );
  if (!fused.length) return [];

  // One fetch for every survivor, then re-join in fused order. A chunk deleted
  // between the search and this read simply drops out rather than erroring.
  const rows = chunksByRowid(
    db,
    fused.map((f) => f.rowid),
  );
  const passages: Passage[] = [];
  for (const hit of fused) {
    const row = rows.get(hit.rowid);
    if (!row) continue;
    passages.push({
      rowid: row.rowid,
      kind: row.source_kind,
      ref: citationRef(row),
      source_path: row.source_path,
      heading: row.heading,
      text: row.chunk_text,
      score: hit.score,
      retrievers: hit.sources,
    });
  }
  return passages;
}
