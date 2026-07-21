/**
 * Reciprocal Rank Fusion (TECH-SPEC §7 step 3).
 *
 * Pure ranking maths, so these are exact-value assertions rather than "close
 * enough": the fused score of a position is a fixed rational, and the property
 * that matters — agreement beating a lone strong hit — has to hold as an
 * inequality between two computable numbers, not as a vibe.
 */
import { describe, expect, it } from "vitest";
import { reciprocalRankFusion, type RankedList } from "../src/recall/fuse.js";

const list = (name: string, rowids: number[]): RankedList => ({
  name,
  hits: rowids.map((rowid) => ({ rowid, score: 0 })),
});

describe("reciprocalRankFusion", () => {
  it("scores a single list by 1/(k+rank) and keeps its order", () => {
    const fused = reciprocalRankFusion([list("vector", [10, 20, 30])], { k: 60 });
    expect(fused.map((f) => f.rowid)).toEqual([10, 20, 30]);
    expect(fused[0]?.score).toBeCloseTo(1 / 61, 10);
    expect(fused[1]?.score).toBeCloseTo(1 / 62, 10);
    expect(fused[2]?.score).toBeCloseTo(1 / 63, 10);
    expect(fused[0]?.sources).toEqual(["vector"]);
  });

  it("sums contributions for a chunk both lists rank, and records both sources", () => {
    const fused = reciprocalRankFusion(
      [list("vector", [1, 2, 3]), list("keyword", [3, 4, 1])],
      { k: 60 },
    );
    const byId = new Map(fused.map((f) => [f.rowid, f]));
    // 1 is rank 1 in vector, rank 3 in keyword.
    expect(byId.get(1)?.score).toBeCloseTo(1 / 61 + 1 / 63, 10);
    expect(byId.get(1)?.sources.sort()).toEqual(["keyword", "vector"]);
    // 3 is rank 3 in vector, rank 1 in keyword.
    expect(byId.get(3)?.score).toBeCloseTo(1 / 63 + 1 / 61, 10);
    // A chunk in one list only carries a single source.
    expect(byId.get(2)?.sources).toEqual(["vector"]);
  });

  it("makes agreement outrank a lone top hit", () => {
    // X is only third on both lists; Y is first, but on one list alone.
    const fused = reciprocalRankFusion(
      [list("vector", [9, 8, 7]), list("keyword", [6, 5, 7])],
      { k: 60 },
    );
    const x = fused.find((f) => f.rowid === 7)?.score ?? 0; // 1/63 + 1/63
    const y = fused.find((f) => f.rowid === 9)?.score ?? 0; // 1/61
    expect(x).toBeGreaterThan(y);
    expect(fused[0]?.rowid).toBe(7);
  });

  it("counts a duplicate within a list once and does not let it consume a rank", () => {
    // [5, 5, 6]: 5 is rank 1, the repeat is dropped, 6 is rank 2 not 3.
    const fused = reciprocalRankFusion([list("vector", [5, 5, 6])], { k: 60 });
    expect(fused.find((f) => f.rowid === 5)?.score).toBeCloseTo(1 / 61, 10);
    expect(fused.find((f) => f.rowid === 6)?.score).toBeCloseTo(1 / 62, 10);
    expect(fused.find((f) => f.rowid === 5)?.sources).toEqual(["vector"]);
  });

  it("truncates to limit after fusing, keeping the strongest", () => {
    const fused = reciprocalRankFusion(
      [list("vector", [1, 2, 3, 4]), list("keyword", [4, 3, 2, 1])],
      { k: 60, limit: 2 },
    );
    expect(fused).toHaveLength(2);
    // 1/x is convex, so the rank-1 + rank-4 pair (rowids 1 and 4) sums higher
    // than the rank-2 + rank-3 pair (rowids 2 and 3). The two extremes survive
    // the cut, ordered by the rowid tie-break since they fuse to equal scores.
    expect(fused.map((f) => f.rowid)).toEqual([1, 4]);
  });

  it("breaks score ties by rowid, deterministically", () => {
    // 1 is rank 2 then rank 1; 2 is rank 1 then rank 2 — an identical fused
    // score, so the rowid tie-break alone decides the order.
    const fused = reciprocalRankFusion([list("vector", [2, 1]), list("keyword", [1, 2])], { k: 60 });
    expect(fused.map((f) => f.rowid)).toEqual([1, 2]);
    expect(fused[0]?.score).toBeCloseTo(fused[1]?.score ?? -1, 12);
  });

  it("larger k damps the score without reordering a single list", () => {
    const tight = reciprocalRankFusion([list("vector", [1, 2, 3])], { k: 1 });
    const loose = reciprocalRankFusion([list("vector", [1, 2, 3])], { k: 1000 });
    expect(tight.map((f) => f.rowid)).toEqual([1, 2, 3]);
    expect(loose.map((f) => f.rowid)).toEqual([1, 2, 3]);
    // The top hit's advantage over the runner-up shrinks as k grows.
    const gap = (r: typeof tight) => (r[0]?.score ?? 0) - (r[1]?.score ?? 0);
    expect(gap(tight)).toBeGreaterThan(gap(loose));
  });

  it("returns nothing for no lists or empty lists", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([list("vector", []), list("keyword", [])])).toEqual([]);
  });
});
