import { ancestorIds, declaredSchemas, resolveSchema, type AttributeSchema, type Attributes } from "@feedhound/core/attributes";
import { PRICE_COMPARABLE_MIN_CONF } from "@feedhound/core/price";
import type postgres from "postgres";

export interface DealPeerQuery {
  postId: string;
  /** Peers share this catalogue item. Exactly one of `itemId` / `categoryIds` is set. */
  itemId: string | null;
  /** Peers sit in one of these categories (the subtree of the category that owns the schema). */
  categoryIds: string[] | null;
  /** Attribute values peers must carry exactly (`attributes @>`). */
  exact: Record<string, string | number>;
  /** Numeric attributes peers must carry within `[min, max]` (tolerance ranges, e.g. year +-1). */
  ranges: { key: string; min: number; max: number }[];
  /** The post's own reference time (`coalesce(posted_at, first_seen_at)`). */
  at: Date;
  windowDays: number;
  limit: number;
  /** When set, only peers from this team's sources (anything returned to a caller must be scoped). Unset keeps the global deal-score peer set. */
  teamId?: string;
}

/** A connection or an open transaction (`sql.begin`). */
export interface SqlRunner {
  sql: postgres.Sql | postgres.TransactionSql;
}

/**
 * The one peer query for the deal score (enrich) and the decision UI (API). Returns `null` when the
 * post is not scoreable: not a priced sell post, no category, no schema with key attributes, or a required key
 * attribute missing. Moved from `enrich.ts` (A4).
 */
export function buildDealPeerQuery(
  i: { postId: string; categoryId: string | null; itemId: string | null; intent: string | null; priceVnd: number | null; attributes: Attributes; at: Date },
  cat: { tree: Map<string, string>; schemas: Map<string, AttributeSchema> },
  cfg: { windowDays: number; limit: number },
): DealPeerQuery | null {
  if (i.categoryId === null || i.intent !== "sell" || i.priceVnd === null) return null;
  const schemaOf = resolveSchema(i.categoryId, cat.tree, cat.schemas);
  if (schemaOf.length === 0) return null;
  const keyDefs = schemaOf.filter((d) => d.keyAttr);
  const required = keyDefs.filter((d) => !d.keyOptional);
  if (keyDefs.length === 0 || !required.every((d) => i.attributes[d.key] !== undefined)) return null;
  const exact: Attributes = {};
  const ranges: { key: string; min: number; max: number }[] = [];
  for (const d of keyDefs) {
    const v = i.attributes[d.key];
    if (v === undefined) continue;
    if (d.kind === "number" && d.tolerance !== undefined) ranges.push({ key: d.key, min: Number(v) - d.tolerance, max: Number(v) + d.tolerance });
    else exact[d.key] = v;
  }
  let categoryIds: string[] | null = null;
  if (!i.itemId) {
    const owner = [...ancestorIds(i.categoryId, cat.tree)].reverse().find((id) => (cat.schemas.get(id)?.length ?? 0) > 0) ?? i.categoryId;
    const ownerPath = cat.tree.get(owner);
    categoryIds = ownerPath ? [...cat.tree].filter(([, p]) => p === ownerPath || p.startsWith(`${ownerPath}.`)).map(([id]) => id) : [owner];
  }
  return { postId: i.postId, itemId: i.itemId, categoryIds, exact, ranges, at: i.at, windowDays: cfg.windowDays, limit: cfg.limit };
}

/** Declared schemas + category tree of the catalogue (the `cat` argument of `buildDealPeerQuery`). */
export async function loadCatalogueAttrs(handle: SqlRunner): Promise<{ tree: Map<string, string>; schemas: Map<string, AttributeSchema> }> {
  const rows = await (handle.sql as postgres.Sql)<{ id: string; path: string; attributeSchema: unknown }[]>`
    select id, path::text as path, attribute_schema as "attributeSchema" from category`;
  return { tree: new Map(rows.map((r) => [r.id, r.path])), schemas: declaredSchemas(rows) };
}

export interface DealComparable {
  postId: string;
  priceVnd: number;
  attributes: Attributes;
  title: string | null;
  displayTitle: string | null;
  url: string;
  sourceName: string;
  at: Date;
}

/**
 * Comparable sell posts in `[at - windowDays, at)`, excluding the post itself, rows
 * flagged `price_suspect`, rows without a price, and prices that are not exact/approx with enough confidence.
 * Newest first, at most `limit`.
 */
export async function loadDealComparables(handle: SqlRunner, q: DealPeerQuery): Promise<DealComparable[]> {
  if ((q.itemId === null) === (q.categoryIds === null)) throw new Error("loadDealComparables: set exactly one of itemId / categoryIds");
  const sql = handle.sql as postgres.Sql; // a TransactionSql supports the same tagged-template API
  const scope = q.itemId !== null ? sql`e.item_id = ${q.itemId}::uuid` : sql`e.category_id = any(${sql.array(q.categoryIds ?? [], 2950)}::uuid[])`;
  const rows = await sql<
    { postId: string; price: string | number; attributes: Attributes | null; title: string | null; displayTitle: string | null; url: string; sourceName: string; at: Date }[]
  >`
    select e.post_id as "postId", e.price_vnd as price, e.attributes, p.title, e.display_title as "displayTitle", p.url,
           s.name as "sourceName", coalesce(p.posted_at, p.first_seen_at) as at
    from enrichment e
    join post p on p.id = e.post_id
    join source s on s.id = p.source_id
    where e.intent = 'sell' and e.price_vnd is not null and not e.price_suspect
      and e.price_qualifier in ('exact', 'approx') and e.price_confidence >= ${PRICE_COMPARABLE_MIN_CONF}::real
      and e.post_id <> ${q.postId}::uuid
      and ${q.teamId ? sql`s.team_id = ${q.teamId}::uuid` : sql`true`}
      and ${scope}
      and e.attributes @> ${JSON.stringify(q.exact)}::jsonb
      and not exists (
        select 1 from jsonb_to_recordset(${JSON.stringify(q.ranges)}::jsonb) as r(key text, min numeric, max numeric)
        where not coalesce(
          case when jsonb_typeof(e.attributes -> r.key) = 'number' then (e.attributes ->> r.key)::numeric between r.min and r.max end,
          false)
      )
      and coalesce(p.posted_at, p.first_seen_at) >= ${q.at.toISOString()}::timestamptz - make_interval(days => ${q.windowDays}::int)
      and coalesce(p.posted_at, p.first_seen_at) < ${q.at.toISOString()}::timestamptz
    order by coalesce(p.posted_at, p.first_seen_at) desc
    limit ${q.limit}::int
  `;
  return rows.map((r) => ({ ...r, priceVnd: Number(r.price), attributes: r.attributes ?? {}, at: new Date(r.at) }));
}

/** Peer prices only (the deal score input): `loadDealComparables` without the display columns. */
export async function loadDealPeers(handle: SqlRunner, q: DealPeerQuery): Promise<number[]> {
  return (await loadDealComparables(handle, q)).map((r) => r.priceVnd);
}
