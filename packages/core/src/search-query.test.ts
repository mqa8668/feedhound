import { describe, expect, test } from "bun:test";
import {
  cursorKeysValid,
  decodeCursor,
  effectiveSort,
  encodeCursor,
  paramsHash,
  parseQuery,
  searchParamsFromQuery,
  searchParamsSchema,
  searchParamsToWatch,
} from "./search-query";

const CAT = "11111111-1111-4111-8111-111111111111";

describe("parseQuery short-token runs", () => {
  test("adjacent short unquoted tokens become one phrase", () => {
    expect(parseQuery("ô tô")).toEqual([{ text: "ô tô", phrase: true, negate: false }]);
    expect(parseQuery("ô tô vios")).toEqual([
      { text: "ô tô", phrase: true, negate: false },
      { text: "vios", phrase: false, negate: false },
    ]);
  });
  test("negated and quoted tokens break the run", () => {
    expect(parseQuery("ô -tô")).toEqual([{ text: "tô", phrase: false, negate: true }]);
  });
});

describe("parseQuery (grammar)", () => {
  test("Tokens, excludes, phrases", () => {
    expect(parseQuery("ip15 -seal")).toEqual([
      { text: "ip15", phrase: false, negate: false },
      { text: "seal", phrase: false, negate: true },
    ]);
    expect(parseQuery('"iphone 15" -"full box" x')).toEqual([
      { text: "iphone 15", phrase: true, negate: false },
      { text: "full box", phrase: true, negate: true },
    ]);
  });
  test("drops tokens shorter than 2 chars, caps at 10 tokens, empty -> []", () => {
    expect(parseQuery("a -c")).toEqual([]);
    expect(parseQuery("a bb2 -c")).toEqual([{ text: "bb2", phrase: false, negate: false }]);
    expect(parseQuery(Array.from({ length: 15 }, (_, i) => `tok${i}`).join(" "))).toHaveLength(10);
    expect(parseQuery(undefined)).toEqual([]);
    expect(parseQuery("   ")).toEqual([]);
  });
  test("keeps accents (NFC lowercase) for later folding", () => {
    expect(parseQuery("Máy ĐẸP")).toEqual([
      { text: "máy", phrase: false, negate: false },
      { text: "đẹp", phrase: false, negate: false },
    ]);
  });
});

describe("searchParams", () => {
  test("query string: repeated and comma arrays, numbers, default limit", () => {
    const r = searchParamsFromQuery({ q: ["ip15"], sourceIds: [CAT, CAT], intents: ["sell,buy"], priceMax: ["20000000"] });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.sourceIds).toHaveLength(2);
    expect(r.data.intents).toEqual(["sell", "buy"]);
    expect(r.data.priceMax).toBe(20000000);
    expect(r.data.limit).toBe(25);
  });
  test("rejects bad values", () => {
    expect(searchParamsFromQuery({ limit: ["101"] }).success).toBe(false);
    expect(searchParamsFromQuery({ intents: ["steal"] }).success).toBe(false);
    expect(searchParamsFromQuery({ q: ["x".repeat(201)] }).success).toBe(false);
    expect(searchParamsFromQuery({ from: ["nope"] }).success).toBe(false);
  });
  test("default sort depends on q", () => {
    expect(effectiveSort({ q: "ip15" })).toBe("relevance");
    expect(effectiveSort({})).toBe("newest");
    expect(effectiveSort({ q: "ip15", sort: "price_asc" })).toBe("price_asc");
  });
  test("hash ignores cursor/limit and array order, not filters", () => {
    const a = searchParamsSchema.parse({ q: "x1", categoryIds: [CAT], limit: 10 });
    const b = searchParamsSchema.parse({ q: "x1", categoryIds: [CAT], limit: 50, cursor: "abc" });
    expect(paramsHash(a)).toBe(paramsHash(b));
    expect(paramsHash(a)).toHaveLength(16);
    expect(paramsHash(a)).not.toBe(paramsHash(searchParamsSchema.parse({ q: "x1" })));
  });
});

describe("cursor", () => {
  test("keyset shape per sort and strict ISO at", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(cursorKeysValid("newest", ["2026-10-05 12:00:00.123456+00", id])).toBe(true);
    expect(cursorKeysValid("relevance", [1.5, "2026-10-05 12:00:00+07:00", id])).toBe(true);
    expect(cursorKeysValid("newest", ["garbage", id])).toBe(false);
    expect(cursorKeysValid("newest", ["2026-10-05 12:00:00+00", "not-uuid"])).toBe(false);
    expect(cursorKeysValid("price_asc", ["x", "2026-10-05 12:00:00+00", id])).toBe(false);
    expect(cursorKeysValid("relevance", [1, "2026-10-05 12:00:00+00"])).toBe(false);
    const base = { v: 1 as const, h: "0123456789abcdef", total: 0, te: true, k: ["a", "b"] };
    expect(decodeCursor(encodeCursor({ ...base, at: "2026-10-05" }))).toBeUndefined();
    expect(searchParamsFromQuery({ priceMax: ["1e300"] }).success).toBe(false);
  });
  test("round trip and malformed", () => {
    const c = { v: 1 as const, h: "0123456789abcdef", at: "2026-10-05T00:00:00.000Z", total: 5, te: true, k: [1.5, "2026-10-05 00:00:00+00", "id"] };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor("garbage!!")).toBeUndefined();
    expect(decodeCursor(Buffer.from('{"v":2}').toString("base64url"))).toBeUndefined();
  });
});

describe("searchParamsToWatch", () => {
  test("Mapping and dropped", () => {
    const r = searchParamsToWatch({ q: "ip15 -seal", categoryIds: [CAT], priceMax: 20000000, author: "Nam", sort: "newest" });
    expect(r).toEqual({
      ok: true,
      watch: { includeAll: ["ip15"], exclude: ["seal"], categoryIds: [CAT], itemIds: [], intents: [], sourceIds: [], priceMax: 20000000 },
      dropped: ["author", "sort"],
    });
  });
  test("needs a positive term, category or item", () => {
    expect(searchParamsToWatch({ q: "-seal" }).ok).toBe(false);
    expect(searchParamsToWatch({}).ok).toBe(false);
    expect(searchParamsToWatch({ categoryIds: [CAT] }).ok).toBe(true);
  });
});
