import { z } from "zod";

export const ConditionEnum = z.enum(["new", "like_new", "used", "broken", "unknown"]);
export type ConditionValue = z.infer<typeof ConditionEnum>;

const DISPLAY_TITLE_CAP = 200;

/** Strict Zod schema for the enrich prompt's expected LLM JSON output. */
export const EnrichOutput = z
  .object({
    intent: z.enum(["sell", "buy", "other"]),
    priceVnd: z.number().int().nonnegative().nullable(),
    condition: ConditionEnum,
    categorySlug: z.string().nullable(),
    itemName: z.string().nullable(),
    confidence: z.number().min(0).max(1),
    // Loosely typed here; the enrich job validates against the category schema (`validateAttributes`).
    // One bad attribute (null, nested, ...) drops that key only; a bad container yields {}.
    attributes: z
      .record(z.string(), z.unknown())
      .transform((r) => {
        const out: Record<string, string | number> = {};
        for (const [k, v] of Object.entries(r)) {
          if ((typeof v === "string" && v.length > 0) || (typeof v === "number" && Number.isFinite(v))) out[k] = v;
        }
        return out;
      })
      .catch({}),
    // Advisory only: an over-long title is truncated, a malformed one dropped, never a reason to reject the output.
    displayTitle: z
      .string()
      .nullish()
      .transform((t) => (t == null ? undefined : t.slice(0, DISPLAY_TITLE_CAP)))
      .catch(undefined),
  })
  .strict();

export type EnrichOutputT = z.infer<typeof EnrichOutput>;

const nullToUndefined = <T>(v: T | null | undefined): T | undefined => v ?? undefined;

const WatchParseAttributeFilter = z
  .object({
    key: z.string().min(1).max(40),
    op: z.enum(["eq", "in", "gte", "lte"]),
    value: z.union([z.string().max(60), z.number()]).nullish().transform(nullToUndefined),
    values: z.array(z.union([z.string().max(60), z.number()])).max(20).nullish().transform(nullToUndefined),
  })
  .strict();

/** Strict Zod schema for the `watch_parse` prompt's LLM JSON output. */
export const WatchParseOutput = z
  .object({
    name: z.string().min(1).max(60),
    categorySlugs: z.array(z.string().max(60)).max(10),
    itemNames: z.array(z.string().max(64)).max(20),
    include: z.array(z.string().max(64)).max(50),
    exclude: z.array(z.string().max(64)).max(50),
    intents: z.array(z.enum(["sell", "buy", "other"])).max(3),
    priceMinVnd: z.number().int().nonnegative().nullable(),
    priceMaxVnd: z.number().int().nonnegative().nullable(),
    attributeFilters: z.array(WatchParseAttributeFilter).max(10),
  })
  .strict();

export type WatchParseOutputT = z.infer<typeof WatchParseOutput>;
