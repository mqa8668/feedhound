import type { ListingFields } from "@feedhound/core/listing";
import { describe, expect, test } from "bun:test";
import { buildListingFields, groupReposts, type ListingRow } from "./listing";

const row = (over: Partial<ListingRow> = {}): ListingRow => ({
  id: "11111111-1111-4111-8111-111111111111",
  title: "  Ban xe  ",
  text: "Ban xe lh 0912345678",
  textNormalized: "ban xe lh 0912345678",
  repostKey: null,
  thumbState: null,
  categoryId: null,
  attributes: null,
  dealPct: null,
  priceVnd: null,
  priceSuspect: false,
  priceRaw: null,
  displayTitle: null,
  ...over,
});

describe("buildListingFields", () => {
  test("displayTitle falls back enrichment -> trimmed title -> snippet", () => {
    expect(buildListingFields(row({ displayTitle: "Hyundai" }), false).displayTitle).toBe("Hyundai");
    expect(buildListingFields(row(), false).displayTitle).toBe("Ban xe");
    expect(buildListingFields(row({ title: "  " }), false).displayTitle).toBe("ban xe lh [SĐT ẩn]");
  });
  test("thumbUrl only when state is ok; phone; region; suspect", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(buildListingFields(row({ thumbState: "ok" }), false).thumbUrl).toBe(`/api/media/${id}/thumb`);
    expect(buildListingFields(row({ thumbState: "expired" }), false).thumbUrl).toBeNull();
    const f = buildListingFields(row({ attributes: { region: "hcm", year: 2019 }, priceRaw: "982.990.099" }), true);
    expect(f.hasPhone).toBe(true);
    expect(f.region).toBe("hcm");
    expect(f.priceSuspect).toBe(true);
    expect(f.saved).toBe(true);
    expect(buildListingFields(row({ attributes: {} }), false).attributes).toBeNull();
  });
});

type G = { id: string; sourceId: string; url: string; listing: ListingFields };
const g = (id: string, sourceId: string, key: string | null): G => ({ id, sourceId, url: `u-${id}`, listing: buildListingFields(row({ id, repostKey: key }), false) });

describe("groupReposts", () => {
  test("later rows with the same non-null key join the first row's alsoIn; nulls never group", () => {
    const out = groupReposts([g("a", "s1", "k"), g("b", "s2", "k"), g("c", "s3", "k"), g("d", "s1", null), g("e", "s2", null), g("f", "s1", "z")]);
    expect(out.map((r) => r.id)).toEqual(["a", "d", "e", "f"]);
    expect(out[0]!.listing.alsoIn).toEqual([
      { postId: "b", sourceId: "s2", url: "u-b" },
      { postId: "c", sourceId: "s3", url: "u-c" },
    ]);
    expect(out[1]!.listing.alsoIn).toEqual([]);
  });
});
