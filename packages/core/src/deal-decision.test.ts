import { describe, expect, test } from "bun:test";
import type { AttributeSchema } from "./attributes";
import { bestIndexes, percentileOf, priceDistribution, verdictText, watchFit } from "./deal-decision";

const prices = [100, 110, 120, 130, 140, 150, 160, 170, 180, 190];
const schema: AttributeSchema = [{ key: "year", label: "Year", keyAttr: true, kind: "number", unit: "year", min: 1990, max: 2030 }];
const base = { priceMin: null, priceMax: 200e6, intents: [], attributeFilters: [] };
const post = (priceVnd: number | null, qualifier: "exact" | "floor" | null = "exact", priceSuspect = false) => ({
  priceVnd,
  priceSuspect,
  qualifier,
  intent: "sell",
  attributes: {},
});

describe("deal-decision", () => {
  test("distribution and percentile", () => {
    const d = priceDistribution(prices, 5);
    expect(d?.p50).toBe(145);
    expect(d?.p10).toBe(109);
    expect(priceDistribution([1, 2, 3, 4], 5)).toBeNull();
    expect(percentileOf(150, prices)).toBe(50);
    expect(percentileOf(150, [])).toBeNull();
  });
  test("verdict", () => {
    const i = { pct: -9.2, n: 13, minPeers: 5, noun: "car" as const, qualifier: null, priceVnd: 185e6 };
    expect(verdictText(i)).toBe("9% cheaper than 13 comparable cars");
    expect(verdictText({ ...i, n: 3 })).toBe("Not enough comparable listings to judge the price (3 found)");
    expect(verdictText({ ...i, pct: 0.4 })).toStartWith("At market price");
    expect(verdictText({ ...i, pct: 5 })).toStartWith("5% pricier");
    expect(verdictText({ ...i, confidence: "high" })).toEndWith(", high confidence");
    expect(verdictText({ ...i, qualifier: "floor" })).toContain("price not exact");
    expect(verdictText({ ...i, priceVnd: null })).toBe("No price");
  });
  test("watchFit", () => {
    expect(watchFit(base, post(180e6), schema)[0]?.status).toBe("ok");
    expect(watchFit(base, post(230e6), schema)[0]?.status).toBe("fail");
    expect(watchFit(base, post(null), schema)[0]?.status).toBe("unknown");
    expect(watchFit(base, post(200e6, "floor"), schema)[0]?.status).toBe("unknown");
    expect(watchFit(base, post(180e6, "exact", true), schema)[0]?.status).toBe("unknown");
    const w = { ...base, priceMax: null, attributeFilters: [{ key: "year", op: "gte" as const, value: 2015 }] };
    expect(watchFit(w, post(1), schema)[0]).toEqual({ label: "Year ≥ 2015", status: "unknown" });
  });
  test("bestIndexes", () => {
    expect(bestIndexes([300, null, 250], "low")).toEqual([2]);
    expect(bestIndexes([null], "high")).toEqual([]);
  });
});
