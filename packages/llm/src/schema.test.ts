import { describe, expect, test } from "bun:test";
import { EnrichOutput, WatchParseOutput } from "./schema";

describe("WatchParseOutput", () => {
  const OK = {
    name: "MacBook M2+",
    categorySlugs: ["macbook"],
    itemNames: ["MacBook Air"],
    include: [],
    exclude: [],
    intents: ["sell"],
    priceMinVnd: null,
    priceMaxVnd: 25000000,
    attributeFilters: [{ key: "chip", op: "gte", value: "m2" }],
  };

  test("accepts a valid payload and normalises null filter values", () => {
    const r = WatchParseOutput.safeParse({ ...OK, attributeFilters: [{ key: "chip", op: "gte", value: "m2", values: null }] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.attributeFilters[0]?.values).toBeUndefined();
  });

  test("rejects extra keys, empty or over-long name, non-integer price", () => {
    expect(WatchParseOutput.safeParse({ ...OK, extra: 1 }).success).toBe(false);
    expect(WatchParseOutput.safeParse({ ...OK, name: "" }).success).toBe(false);
    expect(WatchParseOutput.safeParse({ ...OK, name: "x".repeat(61) }).success).toBe(false);
    expect(WatchParseOutput.safeParse({ ...OK, priceMaxVnd: 1.5 }).success).toBe(false);
  });

  test("rejects oversized arrays and strings", () => {
    expect(WatchParseOutput.safeParse({ ...OK, include: Array.from({ length: 51 }, (_, i) => `t${i}`) }).success).toBe(false);
    expect(WatchParseOutput.safeParse({ ...OK, exclude: ["x".repeat(65)] }).success).toBe(false);
    expect(WatchParseOutput.safeParse({ ...OK, categorySlugs: Array.from({ length: 11 }, () => "a") }).success).toBe(false);
    expect(WatchParseOutput.safeParse({ ...OK, itemNames: Array.from({ length: 21 }, () => "a") }).success).toBe(false);
  });
});

const VALID = {
  intent: "sell",
  priceVnd: 1500000,
  condition: "used",
  categorySlug: "iphone",
  itemName: "iphone 13",
  confidence: 0.8,
};

describe("EnrichOutput", () => {
  test("accepts a valid payload", () => {
    expect(EnrichOutput.safeParse(VALID).success).toBe(true);
  });

  test("rejects extra keys (.strict())", () => {
    const result = EnrichOutput.safeParse({ ...VALID, extra: "nope" });
    expect(result.success).toBe(false);
  });

  test("rejects out-of-range confidence", () => {
    expect(EnrichOutput.safeParse({ ...VALID, confidence: 1.5 }).success).toBe(false);
    expect(EnrichOutput.safeParse({ ...VALID, confidence: -0.1 }).success).toBe(false);
  });

  test("accepts null categorySlug/itemName/priceVnd", () => {
    const result = EnrichOutput.safeParse({ ...VALID, priceVnd: null, categorySlug: null, itemName: null });
    expect(result.success).toBe(true);
  });

  test("rejects unknown condition", () => {
    expect(EnrichOutput.safeParse({ ...VALID, condition: "mint" }).success).toBe(false);
  });

  test("Attributes default to {}, accept string/number values; displayTitle optional <= 200", () => {
    const base = EnrichOutput.parse(VALID);
    expect(base.attributes).toEqual({});
    expect(base.displayTitle).toBeUndefined();
    const withAttrs = EnrichOutput.parse({ ...VALID, attributes: { chip: "M2 Pro", ram_gb: "16", ssd_gb: 512 }, displayTitle: "MacBook" });
    expect(withAttrs.attributes).toEqual({ chip: "M2 Pro", ram_gb: "16", ssd_gb: 512 });
    expect(EnrichOutput.parse({ ...VALID, attributes: { x: null } }).attributes).toEqual({});
    expect(EnrichOutput.parse({ ...VALID, displayTitle: "x".repeat(201) }).displayTitle).toHaveLength(200);
  });

  test("one bad field does not reject the output (null attribute, long title)", () => {
    const r = EnrichOutput.safeParse({ ...VALID, categorySlug: "cars", attributes: { year: null, make: "toyota", x: { a: 1 } }, displayTitle: "x".repeat(300) });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.attributes).toEqual({ make: "toyota" });
    expect(r.data.displayTitle).toHaveLength(200);
    expect(r.data.intent).toBe("sell");
    expect(r.data.priceVnd).toBe(1500000);
  });
  test("null or malformed displayTitle / attributes are tolerated", () => {
    const r = EnrichOutput.safeParse({ ...VALID, attributes: "nope", displayTitle: null });
    expect(r.success).toBe(true);
    if (r.success) expect([r.data.attributes, r.data.displayTitle]).toEqual([{}, undefined]);
  });
});

describe("EnrichOutputV3", () => {
  const base = { intent: "sell", priceVnd: null, condition: "used", categorySlug: null, itemName: null, confidence: 0.9, attributes: {} };

  test("trendTerms is advisory: a bad value becomes [] and the rest of the output survives", async () => {
    const { EnrichOutputV3 } = await import("./prompts/enrich.v3");
    const ok = EnrichOutputV3.parse({ ...base, trendTerms: ["iPhone 15 Pro Max"] });
    expect(ok.trendTerms).toEqual(["iPhone 15 Pro Max"]);
    const bad = EnrichOutputV3.parse({ ...base, sentiment: "pos", trendTerms: "oops" });
    expect([bad.trendTerms, bad.sentiment, bad.intent]).toEqual([[], "pos", "sell"]);
    expect(EnrichOutputV3.parse({ ...base, trendTerms: Array(9).fill("x") }).trendTerms).toEqual([]);
  });
});
