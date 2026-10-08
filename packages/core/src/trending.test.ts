import { describe, expect, test } from "bun:test";
import { extractTerms, zscore } from "./trending";

describe("extractTerms", () => {
  const terms = extractTerms("Bán airpods pro 2 giá tốt, còn bảo hành\nib nhé");
  test("contains expected n-grams", () => {
    for (const t of ["airpods", "airpods pro", "airpods pro 2", "bảo hành"]) expect(terms).toContain(t);
  });
  test("no stopwords, 4-grams, line-spanning terms or duplicates", () => {
    for (const t of ["bán", "giá", "ib"]) expect(terms).not.toContain(t);
    expect(terms.every((t) => t.split(" ").length <= 3)).toBe(true);
    expect(terms.some((t) => t.includes("hành ib") || t.includes("giá tốt") || t.includes("pro 2 giá"))).toBe(false);
    expect(new Set(terms).size).toBe(terms.length);
  });
  test("drops urls and long digit runs", () => {
    expect(extractTerms("https://x.com/abc 0912345678 iphone")).toEqual(["iphone"]);
  });
});

describe("zscore", () => {
  const flat = Array<number>(168).fill(4);
  const alt = Array.from({ length: 168 }, (_, i) => (i % 2 === 0 ? 2 : 6));
  test("cases", () => {
    expect(zscore(16, flat)).toBeCloseTo(6);
    expect(zscore(16, alt)).toBeCloseTo(6);
    expect(zscore(200, Array<number>(168).fill(0))).toBeCloseTo(200);
    expect(zscore(4, flat)).toBeCloseTo(0);
  });
});
