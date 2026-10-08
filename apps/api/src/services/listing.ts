import type { ListingFields } from "@feedhound/core/listing";
import type { PriceQualifier } from "@feedhound/core/price";
import { detectPhone } from "@feedhound/core/phone";
import { maskPii } from "@feedhound/core/pii";
import { deriveSnippet } from "@feedhound/core/snippet";
import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";

/** Post + latest-enrichment columns `buildListingFields` reads. */
export interface ListingRow {
  id: string;
  title: string | null;
  text: string;
  textNormalized: string;
  repostKey: string | null;
  thumbState: string | null;
  categoryId: string | null;
  attributes: Record<string, string | number | boolean> | null;
  dealPct: number | null;
  priceVnd: number | null;
  /** 026 `enrichment.price_suspect` column. */
  priceSuspect: boolean;
  priceRaw: string | null;
  displayTitle: string | null;
  /** How the seller wrote the amount (null on legacy rows). */
  priceQualifier?: string | null;
  priceMaxVnd?: number | null;
  /** Stored deal peer median and peer count (026 `deal_median_vnd` / `deal_n`). */
  dealMedianVnd?: number | null;
  dealN?: number | null;
}

/** `ListingFields` plus the price qualifier the card renders ("> 200tr", "180-200tr") and the market strip inputs. */
export type ListingView = ListingFields & { priceQualifier: PriceQualifier | null; priceMaxVnd: number | null; dealMedianVnd: number | null; dealN: number | null };

/** `alsoIn` starts empty; `groupReposts` fills it. */
export function buildListingFields(row: ListingRow, saved: boolean): ListingView {
  const attributes = row.attributes && Object.keys(row.attributes).length > 0 ? row.attributes : null;
  const region = attributes?.region;
  const title = row.title?.trim() ?? "";
  return {
    displayTitle: row.displayTitle ?? (title !== "" ? title : deriveSnippet(row.textNormalized, maskPii)),
    thumbUrl: row.thumbState === "ok" ? `/api/media/${row.id}/thumb` : null,
    categoryId: row.categoryId,
    attributes,
    region: typeof region === "string" ? region : null,
    dealPct: row.dealPct,
    priceQualifier: (row.priceQualifier ?? null) as PriceQualifier | null,
    priceMaxVnd: row.priceMaxVnd ?? null,
    dealMedianVnd: row.dealMedianVnd ?? null,
    dealN: row.dealN ?? null,
    // No parsed price but a non-blank raw one.
    priceSuspect: row.priceSuspect || (row.priceVnd === null && row.priceRaw !== null && row.priceRaw.trim() !== ""),
    hasPhone: detectPhone(row.text) !== null,
    repostKey: row.repostKey,
    alsoIn: [],
    saved,
  };
}

/** Drop later rows with an already-seen non-null `repostKey` into the first one's `alsoIn`. */
export function groupReposts<T extends { id: string; sourceId: string; url: string; listing: ListingFields }>(rows: T[]): T[] {
  const first = new Map<string, T>();
  const out: T[] = [];
  for (const r of rows) {
    const key = r.listing.repostKey;
    const head = key === null ? undefined : first.get(key);
    if (head) {
      head.listing.alsoIn.push({ postId: r.id, sourceId: r.sourceId, url: r.url });
      continue;
    }
    if (key !== null) first.set(key, r);
    out.push(r);
  }
  return out;
}

/** Excludes posts hidden by `userId`, directly or through the same `repost_key`. */
export function notHiddenFor(userId: string): SQL {
  return sql`NOT EXISTS (
    select 1 from ${schema.postUserFlag} f
    where f.user_id = ${userId}::uuid and f.kind = 'hidden'
      and (f.post_id = ${schema.post.id} or (${schema.post.repostKey} is not null and f.repost_key = ${schema.post.repostKey})))`;
}

export function savedFor(userId: string): SQL {
  return sql`EXISTS (select 1 from ${schema.postUserFlag} f where f.user_id = ${userId}::uuid and f.kind = 'saved' and f.post_id = ${schema.post.id})`;
}

export async function savedPostIds(handle: DbHandle, userId: string, postIds: string[]): Promise<Set<string>> {
  if (postIds.length === 0) return new Set();
  const rows = await handle.db
    .select({ postId: schema.postUserFlag.postId })
    .from(schema.postUserFlag)
    .where(and(eq(schema.postUserFlag.userId, userId), eq(schema.postUserFlag.kind, "saved"), inArray(schema.postUserFlag.postId, postIds)));
  return new Set(rows.map((r) => r.postId));
}
