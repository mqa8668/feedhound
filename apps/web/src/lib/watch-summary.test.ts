import { describe, expect, test } from "vitest";
import { copyName, nextSevenAm, summarizeWatch } from "./watch-summary";
import type { CatalogItemDto, CategoryDto } from "@/api/types";

const categories: CategoryDto[] = [{ id: "c1", parentId: null, slug: "macbook", name: "MacBook", path: "macbook" }];
const items: CatalogItemDto[] = [
  { id: "i1", categoryId: "c1", name: "MacBook Air" },
  { id: "i2", categoryId: "c1", name: "MacBook Pro" },
  { id: "i3", categoryId: "c1", name: "Mac mini" },
];
const base = { include: [], includeAll: [], categoryIds: ["c1"], itemIds: [], priceMin: null, priceMax: null, intents: [] as ("sell" | "buy" | "other")[] };

describe("summarizeWatch", () => {
  test("items, attribute, price and intent", () => {
    const s = summarizeWatch(
      { ...base, itemIds: ["i1", "i2", "i3"], attributeFilters: [{ key: "chip", op: "gte", value: "m2" }], priceMax: 25_000_000, intents: ["sell"] },
      { categories, items },
    );
    expect(s).toBe("Air, Pro, mini · chip ≥ M2 · ≤ 25M · selling");
  });
  test("price range, category fallback and keyword fallback", () => {
    expect(summarizeWatch({ ...base, priceMin: 10_000_000, priceMax: 25_000_000 }, { categories, items })).toBe("MacBook · 10M–25M");
    expect(summarizeWatch({ ...base, categoryIds: [], include: ["a", "b"] }, { categories, items })).toBe("any of: a, b");
    expect(summarizeWatch({ ...base, categoryIds: [], includeAll: ["a", "b"], priceMin: 10_000_000 }, { categories, items })).toBe("all of: a, b · ≥ 10M");
  });
});

describe("helpers", () => {
  test("nextSevenAm is the next local 07:00", () => {
    const a = nextSevenAm(new Date(2026, 9, 4, 22, 0));
    expect([a.getDate(), a.getHours()]).toEqual([5, 7]);
    const b = nextSevenAm(new Date(2026, 9, 4, 5, 0));
    expect([b.getDate(), b.getHours()]).toEqual([4, 7]);
  });
  test("copyName truncates to the name limit", () => {
    expect(copyName("abc")).toBe("abc (copy)");
    expect(copyName("x".repeat(80))).toHaveLength(80);
  });
});
