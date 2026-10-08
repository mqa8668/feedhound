import { describe, expect, test } from "bun:test";
import { dealScore } from "./deal";

const tr = (...xs: number[]): number[] => xs.map((x) => x * 1_000_000);

describe("dealScore", () => {
  test("Trims the 90tr outlier, median 19tr, -10.0%", () => {
    expect(dealScore(17_100_000, tr(17, 18, 19, 20, 21, 90))).toEqual({ medianVnd: 19_000_000, n: 5, pct: -10 });
  });
  test("fewer than minPeers -> null", () => {
    expect(dealScore(17_100_000, tr(17, 18, 19, 20))).toBeNull();
  });
  test("Cars peers, 6 peers -> 182.5tr, -6.3%", () => {
    expect(dealScore(171_000_000, tr(170, 180, 185, 190, 200, 175))).toEqual({ medianVnd: 182_500_000, n: 6, pct: -6.3 });
    expect(dealScore(171_000_000, tr(170, 180, 185, 190, 200, 175, 195))?.n).toBe(7);
  });
  test("repeated values: iqr 0 skips trimming so n does not collapse", () => {
    expect(dealScore(9_000_000, tr(10, 10, 10, 10, 10, 11))).toEqual({ medianVnd: 10_000_000, n: 6, pct: -10 });
    expect(dealScore(9_000_000, tr(10, 10, 10, 11), 5)).toBeNull();
  });
  test("ignores non-positive prices", () => {
    expect(dealScore(1, [0, -1, NaN, 5, 5, 5, 5], 5)).toBeNull();
  });
});
