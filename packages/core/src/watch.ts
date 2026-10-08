import { z } from "zod";
import { attributeFilterSchema } from "./attributes";
import { normalizeText } from "./normalize";

// Watch field bounds.
const MAX_NAME_LEN = 80;
const MAX_TERMS_PER_LIST = 50;
const MIN_TERM_LEN = 1;
const MAX_TERM_LEN = 64;

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const quietHoursSchema = z.object({
  start: z.string().regex(HHMM_RE, "must be HH:MM"),
  end: z.string().regex(HHMM_RE, "must be HH:MM"),
});
export type QuietHours = z.infer<typeof quietHoursSchema>;

const intentSchema = z.enum(["sell", "buy", "other"]);

/** A term list: <= 50 terms, each 1..64 chars after `normalize`. */
function termList() {
  return z
    .array(z.string())
    .max(MAX_TERMS_PER_LIST)
    .refine(
      (terms) =>
        terms.every((t) => {
          const len = normalizeText(t).nfc.length;
          return len >= MIN_TERM_LEN && len <= MAX_TERM_LEN;
        }),
      { message: `each term must be ${MIN_TERM_LEN}..${MAX_TERM_LEN} chars after normalize` },
    );
}

/** Dedupes a term list by normalized (lowercase/unaccent-folded) form, keeping first occurrence. */
function dedupeTerms(terms: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of terms) {
    const key = normalizeText(t).folded;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

const watchInputObjectSchema = z.object({
  name: z.string().min(1).max(MAX_NAME_LEN),
  enabled: z.boolean().default(true),
  include: termList().default([]),
  includeAll: termList().default([]),
  exclude: termList().default([]),
  regex: z.string().optional(),
  categoryIds: z.array(z.string().uuid()).default([]),
  itemIds: z.array(z.string().uuid()).default([]),
  priceMin: z.number().int().min(0).optional(),
  priceMax: z.number().int().min(0).optional(),
  attributeFilters: z.array(attributeFilterSchema).max(10).default([]),
  intents: z.array(intentSchema).default([]),
  sourceIds: z.array(z.string().uuid()).default([]),
  notifierIds: z.array(z.string().uuid()).default([]),
  quietHours: quietHoursSchema.optional(),
  mutedUntil: z.iso.datetime({ offset: true }).nullable().optional(),
});

type WatchInputObject = z.infer<typeof watchInputObjectSchema>;

type PartialWatchInputObject = Partial<WatchInputObject>;

/**
 * Duplicate terms within a list, or the same term
 * appearing in both `include` and `includeAll`, are deduped (kept once, in
 * `include` if present there) rather than rejected. Fields absent from a
 * partial (PATCH) payload are left untouched.
 */
function dedupeAcrossLists<T extends PartialWatchInputObject>(data: T): T {
  const out: PartialWatchInputObject = { ...data };
  if (out.include !== undefined) out.include = dedupeTerms(out.include);
  const includeKeys = new Set((out.include ?? []).map((t) => normalizeText(t).folded));
  if (out.includeAll !== undefined) {
    out.includeAll = dedupeTerms(out.includeAll).filter((t) => !includeKeys.has(normalizeText(t).folded));
  }
  if (out.exclude !== undefined) out.exclude = dedupeTerms(out.exclude);
  return out as T;
}

function validateCommon(data: PartialWatchInputObject, ctx: z.RefinementCtx): void {
  if (data.priceMin !== undefined && data.priceMax !== undefined && data.priceMax < data.priceMin) {
    ctx.addIssue({ code: "custom", message: "priceMax must be >= priceMin", path: ["priceMax"] });
  }

  if (data.mutedUntil) {
    const t = Date.parse(data.mutedUntil);
    if (Number.isNaN(t) || t <= Date.now()) {
      ctx.addIssue({ code: "custom", message: "mutedUntil must be a future date", path: ["mutedUntil"] });
    }
  }

  if (data.include && data.exclude) {
    const normInclude = new Set(data.include.map((t) => normalizeText(t).folded));
    const normExclude = new Set(data.exclude.map((t) => normalizeText(t).folded));
    for (const t of normExclude) {
      if (normInclude.has(t)) {
        ctx.addIssue({
          code: "custom",
          message: `term "${t}" cannot be in both include and exclude`,
          path: ["exclude"],
        });
      }
    }
  }
}

export const watchInputSchema = watchInputObjectSchema
  .transform(dedupeAcrossLists)
  .superRefine((data, ctx) => {
    validateCommon(data, ctx);
    // A region filter alone is fine (the post's region falls back to its source group's region).
    const regionOnly = data.attributeFilters.every((f) => f.key === "region");
    if (data.attributeFilters.length > 0 && data.categoryIds.length === 0 && !regionOnly) {
      ctx.addIssue({ code: "custom", message: "attributeFilters need at least one category", path: ["attributeFilters"] });
    }
    if (
      data.include.length === 0 &&
      data.includeAll.length === 0 &&
      !data.regex &&
      data.categoryIds.length === 0 &&
      data.itemIds.length === 0
    ) {
      ctx.addIssue({
        code: "custom",
        message: "at least one of include | includeAll | regex | categoryIds | itemIds must be non-empty",
        path: [],
      });
    }
  });
export type WatchInput = z.infer<typeof watchInputSchema>;

// The duplicate-term rule applies to PATCH too, but "at least one filter set" is
// checked by the route after merging the patch with the stored watch (a
// partial update legitimately touches only one field at a time).
export const watchPatchSchema = watchInputObjectSchema
  .partial()
  .transform(dedupeAcrossLists)
  .superRefine(validateCommon);
export type WatchPatch = Partial<WatchInput>;

/** `match` job payload: `{ postId, trigger }`. */
export const matchJobSchema = z.object({
  postId: z.string().uuid(),
  trigger: z.enum(["ingest", "enrich"]),
});
export type MatchJobPayload = z.infer<typeof matchJobSchema>;

/** `notify` job payload (payload only, consumer is 004). */
export const notifyJobSchema = z.object({
  matchId: z.string().uuid(),
  watchId: z.string().uuid(),
  notifierIds: z.array(z.string().uuid()),
  quiet: z.boolean(),
});
export type NotifyJobPayload = z.infer<typeof notifyJobSchema>;

/** `POST /api/watches/:id/test` body. */
export const watchTestSchema = z.object({
  hours: z.number().int().min(1).max(168).default(24),
  limit: z.number().int().min(1).max(100).default(50),
});
export type WatchTestInput = z.infer<typeof watchTestSchema>;
