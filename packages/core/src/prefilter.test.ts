import { describe, expect, test } from "bun:test";
import { prefilter } from "./prefilter";
import type { RuleResult } from "./rules";

function rule(overrides: Partial<RuleResult> = {}): RuleResult {
  return {
    intent: "other",
    priceVnd: null,
    priceRaw: null,
    priceMasked: false,
    priceQualifier: null,
    priceMaxVnd: null,
    priceConfidence: 0,
    condition: "unknown",
    categoryId: null,
    itemId: null,
    confidence: 0,
    hits: [],
    ...overrides,
  };
}

describe("prefilter", () => {
  test("true when rule.categoryId is a watched category id", () => {
    const terms = new Set(["cat-1"]);
    const result = prefilter("ban iphone 15", terms, rule({ categoryId: "cat-1", hits: ["iphone 15"] }));
    expect(result).toBe(true);
  });

  test("false when categoryId hit is not a watched category", () => {
    const terms = new Set(["cat-1"]);
    const result = prefilter("ban iphone 15", terms, rule({ categoryId: "cat-2", hits: ["iphone 15"] }));
    expect(result).toBe(false);
  });

  test("true when text contains a watch term as a whole word", () => {
    const terms = new Set(["ip15pm"]);
    const result = prefilter("ban ip15pm gia tot", terms, rule());
    expect(result).toBe(true);
  });

  test("false when no term/category matches and terms is non-empty", () => {
    const terms = new Set(["macbook"]);
    const result = prefilter("ban iphone 15", terms, rule());
    expect(result).toBe(false);
  });

  test("false when terms is empty and no category hit", () => {
    const result = prefilter("ban iphone 15", new Set(), rule());
    expect(result).toBe(false);
  });
});
