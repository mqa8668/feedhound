import { bigint, boolean, check, doublePrecision, index, integer, jsonb, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { catalogItem } from "./catalogItem";
import { category } from "./category";
import { post } from "./post";

// One row per post (upsert on postId) -- postId alone is the
// primary key. `revision` (Post.editCount at enqueue) is tracked as a plain
// column so idempotency/staleness checks (behaviour rules 1, 11) can compare
// it against the job payload without it being part of the key.
export const enrichment = pgTable(
  "enrichment",
  {
    postId: uuid("post_id")
      .primaryKey()
      .references(() => post.id),
    revision: integer("revision").notNull().default(0),
    intent: text("intent"), // sell | buy | other
    priceVnd: doublePrecision("price_vnd"),
    priceRaw: text("price_raw"),
    // What the seller wrote about the amount; null on legacy rows and when there is no price.
    priceQualifier: text("price_qualifier"), // exact | floor | ceiling | approx | range
    priceMaxVnd: doublePrecision("price_max_vnd"),
    priceConfidence: real("price_confidence"),
    condition: text("condition"), // new | like_new | used | broken | unknown
    categoryId: uuid("category_id").references(() => category.id),
    itemId: uuid("item_id").references(() => catalogItem.id),
    confidence: doublePrecision("confidence"),
    engine: text("engine").notNull().default("rule"), // rule | llm
    model: text("model"),
    promptVersion: text("prompt_version"),
    tokens: integer("tokens"),
    // Md5(post.text) of the text this row was enriched from; null = legacy row.
    textHash: text("text_hash"),
    // Typed product attributes; `attributes_version` null = not yet extracted (backfill picks it up).
    attributes: jsonb("attributes").$type<Record<string, string | number>>().notNull().default({}),
    attributesVersion: integer("attributes_version"),
    priceSuspect: boolean("price_suspect").notNull().default(false),
    dealMedianVnd: bigint("deal_median_vnd", { mode: "number" }),
    dealN: integer("deal_n"),
    dealPct: real("deal_pct"),
    displayTitle: text("display_title"),
    // Neg | neu | pos, null for rule-only posts; tags are a subset of buy|sell|ask|complain|review.
    sentiment: text("sentiment"),
    intentTags: text("intent_tags").array().notNull().default(sql`'{}'`),
    // LLM entity trend terms (enrich@5); null = no LLM terms (rule write or older prompt).
    trendTerms: text("trend_terms").array(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("enrichment_filter").on(t.intent, t.categoryId, t.itemId, t.priceVnd), // migration 0032
    index("enrichment_attributes_gin").using("gin", sql`${t.attributes} jsonb_path_ops`),
    index("enrichment_deal_peer")
      .on(t.itemId)
      .where(sql`${t.intent} = 'sell' AND ${t.priceVnd} IS NOT NULL AND NOT ${t.priceSuspect}`),
    check("enrichment_condition_check", sql`${t.condition} IS NULL OR ${t.condition} IN ('new', 'like_new', 'used', 'broken', 'unknown')`), // migration 0015
    index("enrichment_intent_tags_gin").using("gin", t.intentTags),
    check("enrichment_sentiment_check", sql`${t.sentiment} IS NULL OR ${t.sentiment} IN ('neg','neu','pos')`),
    check("enrichment_intent_tags_check", sql`${t.intentTags} <@ ARRAY['buy','sell','ask','complain','review']::text[]`),
    check("enrichment_price_qualifier_check", sql`${t.priceQualifier} IS NULL OR ${t.priceQualifier} IN ('exact','floor','ceiling','approx','range')`), // migration 0045
    check("enrichment_intent_check", sql`${t.intent} IS NULL OR ${t.intent} IN ('sell','buy','other')`),
  ],
);
