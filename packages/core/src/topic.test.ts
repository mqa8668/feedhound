import { describe, expect, test } from "bun:test";
import { searchParamsSchema } from "./search-query";
import { detectSpike, searchParamsToTopic, type SpikeConfig } from "./topic";

const CFG: SpikeConfig = { minVolume: 10, ratioMin: 3, zMin: 3 };

describe("detectSpike", () => {
  test("clear spike with sd floored to 1", () => {
    const v = detectSpike(40, [8, 9, 10, 9, 8, 10, 9], CFG);
    expect(v.spike).toBe(true);
    expect(v.explain).toBe("40 posts vs 7-day avg 9.0 (4.4×, z 31.0)");
  });
  test("below the volume floor is never a spike", () => {
    expect(detectSpike(9, [0, 0, 0, 0, 0, 0, 0], CFG).spike).toBe(false);
  });
  test("ratio under 3 is not a spike", () => {
    expect(detectSpike(25, [10, 12, 9, 11, 30, 10, 12], CFG).spike).toBe(false);
  });
  test("12 against an all-zero baseline is a spike (ratio 12, z 12)", () => {
    const v = detectSpike(12, [0, 0, 0, 0, 0, 0, 0], CFG);
    expect(v.spike).toBe(true);
    expect(v.ratio).toBe(12);
    expect(v.z).toBe(12);
  });
});

describe("searchParamsToTopic", () => {
  test("drops source/author/date/sort filters and reports them", () => {
    const cat = crypto.randomUUID();
    const src = crypto.randomUUID();
    const p = searchParamsSchema.parse({ q: "vios", categoryIds: [cat], sourceIds: [src], from: "2026-01-01T00:00:00Z", sort: "newest" });
    const r = searchParamsToTopic(p);
    expect(r.dropped).toEqual(["sourceIds", "from", "sort"]);
    expect(r.params).toEqual({ q: "vios", categoryIds: [cat] });
  });
  test("a clean search drops nothing (default limit is not reported)", () => {
    expect(searchParamsToTopic(searchParamsSchema.parse({ q: "x" })).dropped).toEqual([]);
  });
});
