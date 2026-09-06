import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  FusionInvalidInput,
  reciprocalRankFusion,
  type RankedDocument,
} from "../../packages/search/src/fusion.ts";

const ids = (lists: readonly (readonly string[])[]): RankedDocument[][] =>
  lists.map((list) => list.map((id) => ({ id })));

// fillers unique to one list so cross-list overlap is fully controlled
const fillers = (prefix: string, count: number): RankedDocument[] =>
  Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}` }));

describe("reciprocalRankFusion", () => {
  it("matches the hand-computed Cormack example (k=60, ties break by id)", () => {
    const fused = reciprocalRankFusion([
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      [{ id: "b" }, { id: "a" }, { id: "d" }],
    ]);

    expect(fused.map((doc) => doc.id)).toEqual(["a", "b", "c", "d"]);
    // a, b: 1/61 + 1/62 = 123/3782; c, d: 1/63
    expect(fused[0]?.score).toBeCloseTo(123 / 3782, 12);
    expect(fused[1]?.score).toBeCloseTo(123 / 3782, 12);
    expect(fused[2]?.score).toBeCloseTo(1 / 63, 12);
    expect(fused[3]?.score).toBeCloseTo(1 / 63, 12);
    expect(fused[0]?.contributions).toEqual([
      { listIndex: 0, rank: 1 },
      { listIndex: 1, rank: 2 },
    ]);
    expect(fused[2]?.contributions).toEqual([{ listIndex: 0, rank: 3 }]);
    expect(fused[3]?.contributions).toEqual([{ listIndex: 1, rank: 3 }]);
  });

  it("is deterministic: repeated calls and reordered lists agree (uniform weights)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(fc.stringMatching(/^[a-z]{1,3}$/), { maxLength: 6 }), {
          maxLength: 4,
        }),
        (raw) => {
          const lists = ids(raw);
          const again = reciprocalRankFusion(structuredClone(lists));
          const reversed = reciprocalRankFusion([...lists].reverse());
          const fused = reciprocalRankFusion(lists);
          expect(again).toEqual(fused);
          // uniform weights make RRF symmetric in the lists: same order, same scores
          expect(reversed.map((doc) => doc.id)).toEqual(fused.map((doc) => doc.id));
          for (const [i, doc] of fused.entries()) {
            expect(reversed[i]?.score).toBeCloseTo(doc.score, 12);
          }
        },
      ),
    );
  });

  it("consensus: ranked r in both lists outranks a doc ranked only once at rank >= r (k=60)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 5 }),
        (r, s) => {
          // B sits at rank s in list 0 only; when s collides with A, B takes r + 1 (still >= r)
          const bRank = s <= r ? r + 1 : s;
          const list0: RankedDocument[] = [
            ...fillers("l0f", r - 1),
            { id: "A" },
            ...fillers("l0g", bRank - r),
          ];
          list0.splice(bRank - 1, 0, { id: "B" });
          const list1: RankedDocument[] = [...fillers("l1f", r - 1), { id: "A" }];
          const fused = reciprocalRankFusion([list0, list1]);
          const scoreOf = (id: string): number => fused.find((doc) => doc.id === id)?.score ?? NaN;
          // 2/(60+r) > 1/(60+bRank) whenever bRank >= r
          expect(scoreOf("A")).toBeGreaterThan(scoreOf("B"));
          expect(fused.findIndex((doc) => doc.id === "A")).toBeLessThan(
            fused.findIndex((doc) => doc.id === "B"),
          );
        },
      ),
    );
  });

  it("is monotone in weights: raising a list's weight raises its exclusive docs", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 50 }).map((v) => v / 10),
        fc.integer({ min: 1, max: 50 }).map((v) => v / 10),
        (r, otherLen, w, bump) => {
          const lists: RankedDocument[][] = [
            [...fillers("xf", r - 1), { id: "X" }],
            fillers("yf", otherLen),
          ];
          const before = reciprocalRankFusion(lists, { weights: [w, 1] });
          const after = reciprocalRankFusion(lists, { weights: [w + bump, 1] });
          const scoreOf = (fused: { id: string; score: number }[], id: string): number =>
            fused.find((doc) => doc.id === id)?.score ?? NaN;
          expect(scoreOf(after, "X")).toBeGreaterThan(scoreOf(before, "X"));
          expect(scoreOf(after, "X")).toBeCloseTo((w + bump) / (60 + r), 12);
          // docs exclusive to the untouched list keep their scores; X ranks no worse
          expect(scoreOf(after, "yf0")).toBeCloseTo(scoreOf(before, "yf0"), 12);
          expect(after.findIndex((doc) => doc.id === "X")).toBeLessThanOrEqual(
            before.findIndex((doc) => doc.id === "X"),
          );
        },
      ),
    );
  });

  it("respects topK: output is the prefix of the untruncated ranking", () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(fc.stringMatching(/^[a-z]{1,3}$/), { maxLength: 8 }), {
          minLength: 1,
          maxLength: 4,
        }),
        fc.integer({ min: 1, max: 10 }),
        (raw, topK) => {
          const lists = ids(raw);
          const full = reciprocalRankFusion(lists);
          const truncated = reciprocalRankFusion(lists, { topK });
          expect(truncated).toEqual(full.slice(0, topK));
          expect(truncated.length).toBeLessThanOrEqual(topK);
        },
      ),
    );
  });

  it("returns empty output for empty input", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[], []])).toEqual([]);
    expect(reciprocalRankFusion([], { topK: 5 })).toEqual([]);
  });

  it("ignores input scores and counts only first occurrence per list", () => {
    const fused = reciprocalRankFusion([
      [
        { id: "a", score: 999 },
        { id: "a", score: -999 },
      ],
      [{ id: "b", score: 0.5 }],
    ]);
    expect(fused.map((doc) => doc.id)).toEqual(["a", "b"]);
    // both first at rank 1 with k=60: tie broken by id, input scores ignored
    expect(fused[0]?.score).toBeCloseTo(1 / 61, 12);
    expect(fused[0]?.contributions).toEqual([{ listIndex: 0, rank: 1 }]);
  });

  it("rejects invalid k, mismatched weights, and invalid topK with FusionInvalidInput", () => {
    const lists = [[{ id: "a" }]];
    for (const k of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => reciprocalRankFusion(lists, { k })).toThrowError(FusionInvalidInput);
    }
    expect(() => reciprocalRankFusion(lists, { weights: [] })).toThrowError(FusionInvalidInput);
    expect(() =>
      reciprocalRankFusion(lists, { weights: [1, 1] }),
    ).toThrowError(FusionInvalidInput);
    for (const topK of [0, -2, 1.5, Number.NaN]) {
      expect(() => reciprocalRankFusion(lists, { topK })).toThrowError(FusionInvalidInput);
    }
    try {
      reciprocalRankFusion(lists, { k: 0 });
      expect.unreachable("k=0 must throw");
    } catch (error) {
      expect((error as FusionInvalidInput)._tag).toBe("FusionInvalidInput");
    }
  });
});
