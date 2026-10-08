import { describe, expect, test } from "bun:test";
import { looksLikePersonName, postTrendTerms, ruleTrendTerms, trendKey, trendLift } from "./trend-entities";

const TEXT = "Bán Honda City 2019 xe đẹp, xem xe chỉ 450tr, lh 0912345678";
const ATTRS = { make: "honda", model: "city", year: 2019 };
const base = { text: TEXT, attributes: ATTRS, itemName: null, llmTerms: null, authorNames: [], max: 5 };

describe("trend-entities", () => {
  test("Attribute terms, no generic unigram, no phone digits, cap", () => {
    const out = postTrendTerms(base);
    expect(out).toContain("Honda City 2019");
    expect(out).toContain("Honda City");
    expect(out).toContain("Honda");
    const keys = out.map(trendKey);
    for (const bad of ["xe", "dep", "xem", "chi"]) expect(keys).not.toContain(bad);
    expect(out.some((t) => /\d{7,}/.test(t))).toBe(false);
    expect(out.length).toBeLessThanOrEqual(5);
    expect(trendKey("hon da City")).toBe(trendKey("Honda City"));
    expect(trendKey("Đẹp Xe")).toBe("depxe");
    expect(postTrendTerms({ ...base, max: 2 }).length).toBe(2);
  });

  test("rule n-grams: multi-token only, generic edges rejected", () => {
    const grams = ruleTrendTerms({ text: "Cần bán macbook air m2 xem xe đẹp", attributes: null, itemName: null });
    expect(grams).toContain("Macbook Air m2");
    expect(grams.every((g) => g.includes(" "))).toBe(true);
    for (const g of grams) {
      const toks = g.toLowerCase().split(" ");
      for (const edge of [toks[0], toks[toks.length - 1]]) expect(["xe", "đẹp", "xem"]).not.toContain(edge);
    }
  });

  test("LLM terms win; sanitise drops phone, masked PII, author names, generic words; n-grams skipped", () => {
    const out = postTrendTerms({
      text: "anything blah foo bar",
      attributes: null,
      itemName: null,
      llmTerms: ["iPhone 15 Pro Max", "0912345678", "Nguyễn Văn A", "xe", "giảm giá", "Zalo 0901234567", "iPhone 15 pro max"],
      authorNames: ["Nguyễn Văn A"],
      max: 5,
    });
    expect(out).toEqual(["iPhone 15 Pro Max", "giảm giá"]);
  });

  test("single-token LLM terms are allowed; item name unigram is not", () => {
    const o = postTrendTerms({ ...base, text: "", attributes: null, itemName: "AirPods", llmTerms: ["Vision"], authorNames: [] });
    expect(o).toEqual(["Vision"]);
  });

  test("trendLift: new vs rising", () => {
    expect(trendLift(12, 0)).toEqual({ lift: 13, isNew: true, deltaPct: null });
    const r = trendLift(24, 10);
    expect(r.isNew).toBe(false);
    expect(r.deltaPct).toBe(140);
    expect(r.lift).toBeCloseTo(25 / 11);
  });

  test("review: person names never become terms (surname heuristic, honorifics); product names do", () => {
    expect(looksLikePersonName("Nguyễn Thị Hoa")).toBe(true);
    expect(looksLikePersonName("Honda City 2019")).toBe(false);
    expect(looksLikePersonName("Lê")).toBe(false);
    const text = "Liên hệ Nguyễn Thị Hoa bán Honda City 2019\nanh Minh Tuấn gọi, cô Lan Anh ib";
    const rule = postTrendTerms({ text, attributes: null, itemName: null, llmTerms: null, authorNames: [], max: 30 });
    expect(rule.some((t) => /Nguyễn|Thị Hoa|Minh Tuấn|Lan Anh/.test(t))).toBe(false);
    expect(rule).toContain("Honda City 2019");
    const out = postTrendTerms({ text: "", attributes: null, itemName: null, llmTerms: ["Trần Văn Nam", "Honda City 2019"], authorNames: [], max: 5 });
    expect(out).toEqual(["Honda City 2019"]);
  });
});
