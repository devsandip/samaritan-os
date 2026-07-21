/**
 * Reciprocal Rank Fusion (TECH-SPEC §7 step 3).
 *
 * The semantic path runs two retrievers over the same chunks — a vector kNN and
 * a BM25 keyword search — and their scores are not comparable: one is a cosine
 * similarity in [0, 1], the other an FTS5 rank that is unbounded and signed.
 * Normalising them against each other means guessing at two distributions;
 * RRF sidesteps the guess by throwing the scores away and fusing on *rank
 * position* alone. A chunk that lands high on either list scores well, and one
 * that lands high on both wins.
 *
 * That is exactly the property this pipeline wants. The vector search finds what
 * is semantically close; the keyword search finds what shares the question's
 * exact words; and a passage both agree on is the likeliest answer. RRF makes
 * agreement outrank a single strong opinion without either retriever having to
 * know the other's score scale.
 *
 *   score(chunk) = Σ 1 / (k + rank_in_list)
 *
 * over every list the chunk appears in, rank 1-based. `k` (default 60, the value
 * from the paper that introduced RRF) damps the gap between adjacent positions,
 * so one retriever's top hit cannot swamp a chunk two other lists agree on.
 *
 * Pure: no db, no clock, no embedder. It takes ranked lists and returns a fused
 * ranking, which is the whole of what makes it testable without the world.
 */
import type { Scored } from "./index-store.js";

export interface RankedList {
  /** Names the retriever, e.g. "vector" or "keyword"; carried onto each hit. */
  name: string;
  /** Hits in rank order, best first. Raw scores are ignored — position is all. */
  hits: Scored[];
}

export interface FusedHit {
  rowid: number;
  /** Fused RRF score; higher is better. Not comparable across queries. */
  score: number;
  /** Which retrievers surfaced this chunk. Two names means both agreed. */
  sources: string[];
}

export interface FuseOptions {
  /** RRF damping constant. The paper's 60; larger flattens rank influence. */
  k?: number;
  /** Keep only the top N after fusion. Unset keeps every fused hit. */
  limit?: number;
}

const DEFAULT_K = 60;

export function reciprocalRankFusion(
  lists: RankedList[],
  options: FuseOptions = {},
): FusedHit[] {
  const k = options.k ?? DEFAULT_K;
  const byRowid = new Map<number, FusedHit>();

  for (const list of lists) {
    const seen = new Set<number>();
    let rank = 0;
    for (const hit of list.hits) {
      // A retriever should not rank the same chunk twice, but if it does only
      // its best position counts: a duplicate must neither inflate the fused
      // score nor consume a rank slot the next distinct hit is owed.
      if (seen.has(hit.rowid)) continue;
      seen.add(hit.rowid);
      rank += 1;

      const contribution = 1 / (k + rank);
      const existing = byRowid.get(hit.rowid);
      if (existing) {
        existing.score += contribution;
        existing.sources.push(list.name);
      } else {
        byRowid.set(hit.rowid, { rowid: hit.rowid, score: contribution, sources: [list.name] });
      }
    }
  }

  // Ties break by rowid so the ordering is deterministic run to run — two
  // chunks fused from the same positions must not swap on a re-query.
  const fused = [...byRowid.values()].sort((a, b) => b.score - a.score || a.rowid - b.rowid);
  return options.limit === undefined ? fused : fused.slice(0, options.limit);
}
