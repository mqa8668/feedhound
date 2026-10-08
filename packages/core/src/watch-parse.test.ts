import { describe, expect, test } from "bun:test";
import type { AttributeSchema } from "./attributes";
import { resolveDraft, type DraftLookups, type WatchParseOutputLike } from "./watch-parse";

const MAC = "00000000-0000-4000-8000-000000000001";
const AIR = "00000000-0000-4000-8000-0000000000a1";
const PRO = "00000000-0000-4000-8000-0000000000a2";
const MINI = "00000000-0000-4000-8000-0000000000a3";

const chipSchema: AttributeSchema = [
  { key: "chip", label: "Chip", keyAttr: true, kind: "ordered", values: ["m1", "m2", "m3"] },
  { key: "color", label: "Color", keyAttr: false, kind: "enum", values: ["silver", "gray"] },
];

const lookups: DraftLookups = {
  categories: [{ id: MAC, slug: "macbook" }],
  items: [
    { id: AIR, name: "MacBook Air", aliases: ["mba", "macbook air", "mac air"], categoryId: MAC },
    { id: PRO, name: "MacBook Pro", aliases: ["mbp"], categoryId: MAC },
    { id: MINI, name: "Mac mini", aliases: [], categoryId: MAC },
  ],
  schemas: new Map([[MAC, chipSchema]]),
};

const base: WatchParseOutputLike = {
  name: "MacBook M2+",
  categorySlugs: [],
  itemNames: [],
  include: [],
  exclude: [],
  intents: [],
  priceMinVnd: null,
  priceMaxVnd: null,
  attributeFilters: [],
};

describe("resolveDraft", () => {
  test("maps slugs, item names, filter, price and intents; warns on unknown slug", () => {
    const { draft, warnings } = resolveDraft(
      {
        ...base,
        categorySlugs: ["macbook", "espresso"],
        itemNames: ["MacBook Air", "macbook pro", "Mac mini"],
        attributeFilters: [{ key: "chip", op: "gte", value: "M2" }],
        priceMaxVnd: 25_000_000,
        intents: ["sell"],
      },
      lookups,
    );
    expect(draft.categoryIds).toEqual([MAC]);
    expect(draft.itemIds).toEqual([AIR, PRO, MINI]);
    expect(draft.attributeFilters).toEqual([{ key: "chip", op: "gte", value: "m2" }]);
    expect(draft.priceMax).toBe(25_000_000);
    expect(draft.priceMin).toBeUndefined();
    expect(draft.intents).toEqual(["sell"]);
    expect(draft.includeAll).toEqual([]);
    expect(warnings).toEqual(['unknown category "espresso"']);
  });

  test("item names match aliases accent-insensitively; unmatched names fall back to include", () => {
    const { draft } = resolveDraft({ ...base, categorySlugs: ["macbook"], itemNames: ["MBA", "Mac Studio"], include: ["mac studio", "m2"] }, lookups);
    expect(draft.itemIds).toEqual([AIR]);
    expect(draft.include).toEqual(["Mac Studio", "m2"]);
  });

  test("drops invalid filters with a warning and swaps nothing on a bad price range", () => {
    const { draft, warnings } = resolveDraft(
      {
        ...base,
        categorySlugs: ["macbook"],
        attributeFilters: [
          { key: "chip", op: "gte", value: "m9" },
          { key: "color", op: "gte", value: "silver" },
          { key: "ghost", op: "eq", value: "x" },
        ],
        priceMinVnd: 30_000_000,
        priceMaxVnd: 10_000_000,
      },
      lookups,
    );
    expect(draft.attributeFilters).toEqual([]);
    expect(draft.priceMin).toBeUndefined();
    expect(draft.priceMax).toBeUndefined();
    expect(warnings).toHaveLength(4);
  });

  test("filters without a resolved category are dropped", () => {
    const { draft, warnings } = resolveDraft({ ...base, attributeFilters: [{ key: "chip", op: "gte", value: "m2" }] }, lookups);
    expect(draft.attributeFilters).toEqual([]);
    expect(warnings).toHaveLength(1);
  });
  test("filters resolve via the matched items' category schema when no category is returned", () => {
    const { draft } = resolveDraft({ ...base, itemNames: ["MacBook Air"], attributeFilters: [{ key: "chip", op: "gte", value: "m2" }] }, lookups);
    expect(draft.itemIds).toEqual([AIR]);
    expect(draft.attributeFilters).toHaveLength(1);
  });

  test("caps warnings and terms to what the watch schema accepts", () => {
    const many = Array.from({ length: 60 }, (_, i) => `term${i}`);
    const slugs = Array.from({ length: 40 }, (_, i) => `nope${i}`);
    const { draft, warnings } = resolveDraft({ ...base, categorySlugs: slugs, include: many, exclude: [...many, "  ", "x".repeat(70)] }, lookups);
    expect(warnings.length).toBeLessThanOrEqual(20);
    expect(draft.include).toHaveLength(50);
    expect(draft.exclude).toHaveLength(50);
  });
});
