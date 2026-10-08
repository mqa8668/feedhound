// `attributes_backfill` -- regex + price-bound repair of enrichment rows written before attribute extraction existed.
// Never calls the LLM, enqueues no job, leaves `prompt_version` / `updated_at`; state lives in `attributes_version`.

import { ATTRIBUTES_VERSION, type Attributes } from "@feedhound/core/attributes";
import { createLogger } from "@feedhound/core/logger";
import {
  isPhoneShapedPrice,
  isPriceGrounded,
  MAX_PRICE_VND,
  parsePrice,
  type PriceQualifier,
} from "@feedhound/core/price";
import type { DbHandle } from "@feedhound/db";
import type { PgBoss } from "pg-boss";
import { finalizeEnrichment, structuredOf, structuredPrice, type CatalogueSnapshot } from "./enrich";

const logger = createLogger({ service: "agent" });

export const ATTRIBUTES_BACKFILL_QUEUE = "attributes_backfill";
const CRON = "*/10 * * * *";
const MIN_PRICE_VND = 1_000;
/** Confidence of a stored LLM price whose digits appear in the text. */
const LLM_PRICE_CONFIDENCE = 0.6;

export interface BackfillConfig {
  batch: number;
  maxPerRun: number;
  dealWindowDays: number;
  dealMinPeers: number;
}

interface Row {
  post_id: string;
  intent: string | null;
  price_vnd: number | null;
  price_raw: string | null;
  engine: string;
  category_id: string | null;
  item_id: string | null;
  attributes: Attributes;
  display_title: string | null;
  text: string;
  at: Date;
  defaults: Attributes;
  capture: string | null;
  raw: unknown;
}

/** Current parser on the post text, with the same out-of-range guard as the rule engine. */
function reparse(text: string): {
  priceVnd: number | null;
  priceRaw: string | null;
  priceQualifier: PriceQualifier | null;
  priceMaxVnd: number | null;
  priceConfidence: number | null;
} {
  const p = parsePrice(text);
  const priceVnd =
    p.priceVnd !== null &&
    p.priceVnd > MIN_PRICE_VND &&
    p.priceVnd < MAX_PRICE_VND
      ? p.priceVnd
      : null;
  return {
    priceVnd,
    priceRaw:
      priceVnd !== null || isPhoneShapedPrice(p.priceRaw) ? p.priceRaw : null,
    priceQualifier: priceVnd === null ? null : p.qualifier,
    priceMaxVnd: priceVnd === null ? null : p.maxVnd,
    priceConfidence: priceVnd === null ? null : p.confidence,
  };
}

/** Processes up to `maxPerRun` legacy rows in batches of `batch` (one transaction each); returns how many were done. */
export async function runAttributesBackfill(
  handle: DbHandle,
  catalogue: CatalogueSnapshot,
  cfg: BackfillConfig,
  /** Restrict to these posts (tests); omitted = every stale row (production). */
  postIds?: readonly string[],
): Promise<number> {
  // A cache loaded before the catalogue was seeded has no schemas: writing now would stamp empty attributes as done.
  if ((catalogue.attrs?.schemas.size ?? 0) === 0) {
    logger.warn("attributes_backfill: attribute schemas not loaded yet, skipping run");
    return 0;
  }
  const only = postIds ? [...postIds] : null;
  let processed = 0;
  while (processed < cfg.maxPerRun) {
    const limit = Math.min(cfg.batch, cfg.maxPerRun - processed);
    const n = await handle.sql.begin(async (tx) => {
      const rows = await tx<Row[]>`
        select e.post_id, e.intent, e.price_vnd, e.price_raw, e.engine, e.category_id, e.item_id, e.attributes, e.display_title,
          p.text, coalesce(p.posted_at, p.first_seen_at) as at, s.defaults, p.capture, p.raw
        from enrichment e
        join post p on p.id = e.post_id
        join source s on s.id = p.source_id
        where e.attributes_version is distinct from ${ATTRIBUTES_VERSION}::int
          and (${only}::uuid[] is null or e.post_id = any(${only}::uuid[]))
        order by e.post_id
        limit ${limit}::int
        for update of e skip locked
      `;
      for (const r of rows) {
        try {
          await tx.savepoint(async (sp) => {
            // (a) price re-parse for every row: rule rows take the parsed price + qualifier; an LLM row keeps
            // its stored price only when the rule parser finds none and the price's digits are in the text.
            const fresh = reparse(r.text);
            let priceVnd = fresh.priceVnd;
            let priceQualifier = fresh.priceQualifier;
            let priceMaxVnd = fresh.priceMaxVnd;
            let priceConfidence = fresh.priceConfidence;
            let priceRaw = fresh.priceRaw;
            // An API post keeps its structured price / intent instead of a text re-parse.
            const structured = structuredOf(r.capture, r.raw);
            const sPrice = structured ? structuredPrice(structured) : null;
            if (sPrice) ({ priceVnd, priceRaw, priceQualifier, priceMaxVnd, priceConfidence } = sPrice);
            let repairedAway = false;
            if (priceVnd === null && r.engine === "llm" && r.price_vnd !== null && isPriceGrounded(r.text, r.price_vnd)) {
              priceVnd = r.price_vnd;
              priceQualifier = "exact";
              priceMaxVnd = null;
              priceConfidence = LLM_PRICE_CONFIDENCE;
            } else if (priceVnd === null && r.engine === "rule" && r.price_vnd !== null) {
              repairedAway = true;
            }
            // (b)+(c) bounds, attributes (stored values lowest, regex + item above), defaults, deal; (d) version below.
            const fin = await finalizeEnrichment(
              { sql: sp },
              catalogue,
              {
                dealWindowDays: cfg.dealWindowDays,
                dealMinPeers: cfg.dealMinPeers,
              },
              {
                postId: r.post_id,
                text: r.text,
                at: new Date(r.at),
                sourceDefaults: r.defaults ?? {},
                intent: structured?.intent ?? r.intent,
                categoryId: r.category_id,
                itemId: r.item_id,
                priceVnd,
                priceRaw,
                priceQualifier,
                priceMaxVnd,
                priceConfidence,
                baseAttributes: r.attributes,
                structured,
              },
            );
            await sp`
              update enrichment set
                price_vnd = ${fin.priceVnd}::float8,
                price_raw = ${priceRaw}::text,
                price_qualifier = ${fin.priceQualifier}::text,
                price_max_vnd = ${fin.priceMaxVnd}::float8,
                price_confidence = ${fin.priceConfidence}::real,
                price_suspect = ${fin.priceSuspect || repairedAway}::boolean,
                category_id = ${fin.categoryId}::uuid,
                attributes = ${JSON.stringify(fin.attributes)}::jsonb,
                attributes_version = ${ATTRIBUTES_VERSION}::int,
                deal_median_vnd = ${fin.deal?.medianVnd ?? null}::bigint,
                deal_n = ${fin.deal?.n ?? null}::int,
                deal_pct = ${fin.deal?.pct ?? null}::real,
                display_title = coalesce(display_title, ${fin.displayTitle}::text)
              where post_id = ${r.post_id}::uuid
            `;
          });
        } catch (err) {
          // A poison row must not stall the batch: log it and stamp the version so it is not picked up again.
          logger.error(
            { postId: r.post_id, err },
            "attributes_backfill: row failed, skipped",
          );
          await tx`update enrichment set attributes_version = ${ATTRIBUTES_VERSION}::int where post_id = ${r.post_id}::uuid`;
        }
      }
      return rows.length;
    });
    processed += n;
    if (n < limit) break;
  }
  return processed;
}

export interface RegisterAttributesBackfillOptions {
  boss: PgBoss;
  handle: DbHandle;
  catalogueSnapshot: () => CatalogueSnapshot;
  fetchConfig: () => Promise<BackfillConfig>;
}

/** Registers the `attributes_backfill` queue, its 10-minute cron and the worker. */
export async function registerAttributesBackfillJob(
  options: RegisterAttributesBackfillOptions,
): Promise<void> {
  const { boss, handle } = options;
  await boss.createQueue(ATTRIBUTES_BACKFILL_QUEUE);
  await boss.schedule(ATTRIBUTES_BACKFILL_QUEUE, CRON, null, {
    singletonKey: ATTRIBUTES_BACKFILL_QUEUE,
  });
  await boss.work(ATTRIBUTES_BACKFILL_QUEUE, async () => {
    const processed = await runAttributesBackfill(
      handle,
      options.catalogueSnapshot(),
      await options.fetchConfig(),
    );
    if (processed > 0) logger.info({ processed }, "attributes_backfill done");
  });
}
