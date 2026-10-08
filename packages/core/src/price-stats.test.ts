import { describe, expect, test } from "bun:test";
import { priceStats } from "./price-stats";

const M = 1_000_000;
describe("priceStats", () => {
  test("trims outliers when nRaw >= 4", () => {
    expect(priceStats([10, 11, 12, 13, 14, 50].map((v) => v * M))).toEqual({ nRaw: 6, n: 5, median: 12 * M, p25: 11 * M, p75: 13 * M });
  });
  test("no trim when nRaw < 4", () => {
    expect(priceStats([10, 11, 50].map((v) => v * M))?.n).toBe(3);
  });
  test("empty -> null", () => {
    expect(priceStats([0, -1])).toBeNull();
  });
});
