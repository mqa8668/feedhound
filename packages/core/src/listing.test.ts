import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { dealBadge, formatKm, formatVndCompact, repostKey, sha256Hex, watchDraftFromListing, type ListingFields } from "./listing";

const base: ListingFields = {
  displayTitle: "Hyundai Santafe 2019",
  thumbUrl: null,
  categoryId: "c0c0c0c0-0000-4000-8000-000000000001",
  attributes: { make: "Hyundai", model: "Santafe", year: 2019, odo_km: 62000 },
  region: null,
  dealPct: -8.4,
  priceSuspect: false,
  hasPhone: false,
  repostKey: null,
  alsoIn: [],
  saved: false,
};

describe("repostKey", () => {
  test("same seller + text share a key, other seller differs, unknown author null", () => {
    const a = repostKey({ authorId: "u1", text: "Ban Santafe 2019 gia 680tr" });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(repostKey({ authorId: "u1", text: "ban santafe 2019 GIA 680tr 🔥" })).toBe(a);
    expect(repostKey({ authorId: "u2", text: "Ban Santafe 2019 gia 680tr" })).not.toBe(a);
    expect(repostKey({ text: "Ban Santafe 2019 gia 680tr" })).toBeNull();
    expect(repostKey({ authorId: "u1", text: "   " })).toBeNull();
  });
  test("sha256Hex matches node:crypto", () => {
    for (const s of ["", "abc", "x".repeat(55), "x".repeat(56), "x".repeat(200), "tiếng Việt ✓"]) {
      expect(sha256Hex(s)).toBe(createHash("sha256").update(s).digest("hex"));
    }
  });
});

describe("formatters", () => {
  test("formatVndCompact", () => {
    expect(formatVndCompact(680_000_000)).toBe("680M");
    expect(formatVndCompact(1_200_000_000)).toBe("1.2B");
    expect(formatVndCompact(1_000_000_000)).toBe("1B");
    expect(formatVndCompact(2_500_000)).toBe("2.5M");
    expect(formatVndCompact(850_000)).toBe("850k");
  });
  test("formatKm", () => {
    expect(formatKm(62000)).toBe("62.000 km");
  });
  test("dealBadge", () => {
    expect(dealBadge(-8.4)).toEqual({ text: "▼8% vs avg", tone: "good" });
    expect(dealBadge(5)).toEqual({ text: "▲5% vs avg", tone: "muted" });
    expect(dealBadge(0.3)).toEqual({ text: "≈ avg", tone: "muted" });
    expect(dealBadge(null)).toBeNull();
  });
});

describe("watchDraftFromListing", () => {
  test("row", () => {
    const d = watchDraftFromListing({ ...base, priceVnd: 680_000_000, title: null });
    expect(d.name).toBe("Hyundai Santafe 2019");
    expect(d.include).toEqual(["hyundai", "santafe"]);
    expect(d.categoryIds).toEqual([base.categoryId!]);
    expect(d.attributeFilters.filter((f) => f.key === "year").map((f) => f.value)).toEqual([2018, 2020]);
    expect(d.priceMin).toBe(578_000_000);
    expect(d.priceMax).toBe(782_000_000);
    expect(d.intents).toEqual(["sell"]);
  });
  test("falls back to the title without attributes", () => {
    const d = watchDraftFromListing({ ...base, attributes: null, displayTitle: null, categoryId: null, priceVnd: null, title: "x".repeat(60) });
    expect(d.name).toBe("x".repeat(40));
    expect(d.attributeFilters).toEqual([]);
    expect(d.priceMin).toBeUndefined();
  });
});
