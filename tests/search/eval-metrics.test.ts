import { describe, expect, it } from "vitest";
import {
  evaluateRun,
  mrr,
  recallAtK,
} from "../../packages/search/src/eval-metrics.ts";

describe("recallAtK", () => {
  it("scores a perfect run as 1.0", () => {
    expect(recallAtK(["a", "b", "c"], ["a", "b"], 2)).toBe(1);
    expect(recallAtK(["a", "b", "c"], ["a", "b", "c"], 10)).toBe(1);
    expect(recallAtK(["a"], ["a"], 1)).toBe(1);
  });

  it("scores an empty run as 0", () => {
    expect(recallAtK([], ["a"], 10)).toBe(0);
    expect(recallAtK([], ["a", "b"], 1)).toBe(0);
  });

  it("gives partial credit as found / expected", () => {
    // top-2 holds only "a" of {"a", "c"} -> 1/2
    expect(recallAtK(["a", "b", "c"], ["a", "c"], 2)).toBeCloseTo(0.5, 12);
    // top-1 holds nothing of {"a", "b"} -> 0
    expect(recallAtK(["x", "a", "b"], ["a", "b"], 1)).toBe(0);
    // top-3 holds both -> 1
    expect(recallAtK(["x", "a", "b"], ["a", "b"], 3)).toBe(1);
  });

  it("returns 0 for non-positive k", () => {
    expect(recallAtK(["a"], ["a"], 0)).toBe(0);
    expect(recallAtK(["a"], ["a"], -3)).toBe(0);
  });
});

describe("mrr", () => {
  it("scores rank 1 as 1.0 and misses as 0", () => {
    expect(mrr(["a", "b"], ["a"])).toBe(1);
    expect(mrr(["x", "y"], ["a"])).toBe(0);
    expect(mrr([], ["a"])).toBe(0);
  });

  it("matches hand-computed reciprocal ranks", () => {
    // first expected ("c") sits at rank 3 -> 1/3
    expect(mrr(["a", "b", "c"], ["c"])).toBeCloseTo(1 / 3, 12);
    // best of {"b", "c"} sits at rank 2 -> 1/2
    expect(mrr(["x", "b", "c"], ["b", "c"])).toBeCloseTo(1 / 2, 12);
    // rank 4 -> 1/4
    expect(mrr(["x", "y", "z", "b"], ["b"])).toBeCloseTo(1 / 4, 12);
  });
});

describe("evaluateRun", () => {
  it("averages a perfect run to 1.0s", () => {
    const summary = evaluateRun(
      [
        { queryId: "q1", rankedIds: ["a", "x"] },
        { queryId: "q2", rankedIds: ["b", "y", "z"] },
      ],
      [
        { queryId: "q1", expectedIds: ["a"] },
        { queryId: "q2", expectedIds: ["b"] },
      ],
    );
    expect(summary.perQuery).toHaveLength(2);
    for (const p of summary.perQuery) {
      expect(p.recallAt1).toBe(1);
      expect(p.recallAt3).toBe(1);
      expect(p.recallAt10).toBe(1);
      expect(p.mrr).toBe(1);
    }
    expect(summary.macro).toStrictEqual({ recallAt1: 1, recallAt3: 1, recallAt10: 1, mrr: 1 });
  });

  it("averages an empty run to 0s", () => {
    const summary = evaluateRun(
      [
        { queryId: "q1", rankedIds: [] },
        { queryId: "q2", rankedIds: [] },
      ],
      [
        { queryId: "q1", expectedIds: ["a"] },
        { queryId: "q2", expectedIds: ["b", "c"] },
      ],
    );
    expect(summary.macro).toStrictEqual({ recallAt1: 0, recallAt3: 0, recallAt10: 0, mrr: 0 });
  });

  it("mixes partial credit across queries", () => {
    const summary = evaluateRun(
      [
        { queryId: "q1", rankedIds: ["a", "b", "c"] },
        { queryId: "q2", rankedIds: ["x", "y"] },
      ],
      [
        { queryId: "q1", expectedIds: ["a", "c"] },
        { queryId: "q2", expectedIds: ["b"] },
      ],
    );
    const q1 = summary.perQuery.find((p) => p.queryId === "q1");
    const q2 = summary.perQuery.find((p) => p.queryId === "q2");
    // q1: top-1 has 1/2, top-3 has 2/2, MRR 1
    expect(q1?.recallAt1).toBeCloseTo(0.5, 12);
    expect(q1?.recallAt3).toBe(1);
    expect(q1?.mrr).toBe(1);
    // q2: total miss
    expect(q2?.recallAt10).toBe(0);
    expect(q2?.mrr).toBe(0);
    // macro recall@10 = (1 + 0) / 2
    expect(summary.macro.recallAt10).toBeCloseTo(0.5, 12);
    // macro MRR = (1 + 0) / 2
    expect(summary.macro.mrr).toBeCloseTo(0.5, 12);
  });

  it("scores a missing result as 0", () => {
    const summary = evaluateRun([], [{ queryId: "q1", expectedIds: ["a"] }]);
    expect(summary.perQuery[0]?.recallAt10).toBe(0);
    expect(summary.perQuery[0]?.mrr).toBe(0);
    expect(summary.macro.recallAt10).toBe(0);
  });
});
