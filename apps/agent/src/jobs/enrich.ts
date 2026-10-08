import type { AliasDict, CatalogItem, Category } from "@feedhound/core/classify";
import {
  ancestorIds,
  ATTRIBUTES_VERSION,
  extractAttributes,
  isExpiryYearOnly,
  resolvePriceBounds,
  resolveSchema,
  validateAttributes,
  type AttributeSchema,
  type Attributes,
  type RawBounds,
  containsDigitRun,
  ungroupDigits,
} from "@feedhound/core/attributes";
import { dealScore } from "@feedhound/core/deal";
import { acceptLlmTitle, ruleTitle } from "@feedhound/core/display-title";
import { normalizeText } from "@feedhound/core/normalize";
import { DEFAULT_PRICE_MAX_VND, isComparablePrice, isPhoneShapedPrice, isPriceGrounded, MAX_PRICE_VND, type PriceQualifier } from "@feedhound/core/price";
import { createLogger } from "@feedhound/core/logger";
import { prefilter } from "@feedhound/core/prefilter";
import { matchJobSchema } from "@feedhound/core/watch";
import { structuredSchema, type Structured } from "@feedhound/core/sources";
import { runRules, MASKED_PRICE_CONFIDENCE_CAP, type RuleResult } from "@feedhound/core/rules";
import type { Budget, UsageTotals } from "@feedhound/llm/budget";
import type { LlmClient } from "@feedhound/llm/client";
import { EnrichOutputV3 } from "@feedhound/llm";
import { getPrompt, promptVersionOf, type EnrichPromptInput } from "@feedhound/llm/registry";
// Side-effect imports: register the "enrich" prompts (v1, v2 = enrich@4, v3 = enrich@5) with the registry.
import "@feedhound/llm/prompts/enrich.v1";
import "@feedhound/llm/prompts/enrich.v2";
import { postTrendTerms } from "@feedhound/core/trend-entities";
import { ruleIntentTags } from "@feedhound/core/topic";
import type { DbHandle } from "@feedhound/db";
import { buildDealPeerQuery, loadDealPeers, schema, type SqlRunner } from "@feedhound/db";
import { eq, sql } from "drizzle-orm";
import { resolveOpsUserId } from "./ops-alerts";
import type { PgBoss } from "pg-boss";
import { z } from "zod";

const logger = createLogger({ service: "agent" });

const ENRICH_QUEUE = "enrich";
const MATCH_QUEUE = "match";
const MAX_CANDIDATES = 40;
const BUDGET_EXHAUSTED_LOG_THROTTLE_MS = 60 * 60 * 1000;
// `post.text` was embedded untruncated in the
// prompt, so one hostile ~200 KB post could burn a large share of the daily
// token budget -- doubled again by the cheap->strong ladder. 4000 chars is
// generously above any real marketplace post while bounding worst case.
const MAX_PROMPT_TEXT_CHARS = 4000;
// Same out-of-range guard rules.ts applies to rule-derived prices; the LLM's `priceVnd` bypassed it entirely.
const PRICE_MIN_VND = 1_000;
const PRICE_MAX_VND = MAX_PRICE_VND;

function guardLlmPrice(priceVnd: number | null): number | null {
  if (priceVnd === null) return null;
  if (priceVnd <= PRICE_MIN_VND || priceVnd >= PRICE_MAX_VND) return null;
  return priceVnd;
}

export interface EnrichJobPayload {
  postId: string;
  revision: number;
  force?: boolean;
  /** `capture_upgrade`: the post text was upgraded in place (same revision); re-enrich it. Implies `force`. */
  reason?: "capture_upgrade" | "insights_backfill";
  engine?: "rule" | "llm";
}

// Minor: the worker read `job.data` unvalidated.
const enrichJobPayloadSchema = z.object({
  postId: z.string().uuid(),
  revision: z.number().int(),
  force: z.boolean().optional(),
  reason: z.enum(["capture_upgrade", "insights_backfill"]).optional(),
  engine: z.enum(["rule", "llm"]).optional(),
}) satisfies z.ZodType<EnrichJobPayload>;

export interface EnrichConfig {
  ruleConfidenceMin: number;
  llmConfidenceMin: number;
  enrichAll: boolean;
  modelCheap: string;
  modelStrong: string;
  /** `deal.windowDays` (default 30). */
  dealWindowDays?: number;
  /** `deal.minPeers` (default 5). */
  dealMinPeers?: number;
  /** `analytics.trend.maxTermsPerPost` (default 5). */
  trendMaxTerms?: number;
}

/** Attribute schemas, price bounds and item-level fixed attributes, as loaded from the catalogue tables. */
export interface CatalogueAttrs {
  /** categoryId -> ltree path. */
  tree: Map<string, string>;
  /** Schema declared on each category itself (not inherited). */
  schemas: Map<string, AttributeSchema>;
  bounds: Map<string, RawBounds>;
  /** itemId -> fixed attributes (`catalog_item.attributes`). */
  itemAttributes: Map<string, Attributes>;
}

export interface CatalogueSnapshot {
  dict: AliasDict;
  categories: Category[];
  items: CatalogItem[];
  attrs?: CatalogueAttrs;
}

const EMPTY_ATTRS: CatalogueAttrs = { tree: new Map(), schemas: new Map(), bounds: new Map(), itemAttributes: new Map() };
const DEAL_PEER_LIMIT = 1000;
/** Confidence of an LLM price whose digits appear in the post. */
const LLM_PRICE_CONFIDENCE = 0.6;

/** Numeric attributes the LLM must not invent: they have to appear in the post text as a whole digit run. */
const VERIFIED_NUMBER_KEYS: ReadonlySet<string> = new Set(["year", "odo_km", "seats"]);

export interface FinalizeInput {
  postId: string;
  text: string;
  /** `coalesce(post.posted_at, post.first_seen_at)`. */
  at: Date;
  sourceDefaults: Attributes;
  intent: string | null;
  categoryId: string | null;
  itemId: string | null;
  priceVnd: number | null;
  priceRaw: string | null;
  /** How the seller wrote the amount; null with a null price. */
  priceQualifier: PriceQualifier | null;
  priceMaxVnd: number | null;
  priceConfidence: number | null;
  /** LLM (or previously stored) attributes: lowest precedence above source defaults. */
  baseAttributes?: unknown;
  llmTitle?: string | undefined;
  /** Hints from a site API; attributes from here win over item / regex / llm. */
  structured?: Structured | undefined;
}

/** The `structured` hint of an `api` post, or undefined (invalid hints are ignored with a warning). */
export function structuredOf(capture: string | null, raw: unknown): Structured | undefined {
  if (capture !== "api" || typeof raw !== "object" || raw === null) return undefined;
  const hint = (raw as { structured?: unknown }).structured;
  if (hint === undefined) return undefined;
  const parsed = structuredSchema.safeParse(hint);
  if (!parsed.success) {
    logger.warn({ issues: parsed.error.issues.length }, "enrich: invalid structured hint ignored");
    return undefined;
  }
  return parsed.data;
}

/** The API price is exact; overrides whatever the text said. */
export function structuredPrice(s: Structured): { priceVnd: number; priceRaw: string; priceQualifier: "exact"; priceMaxVnd: null; priceConfidence: 1 } | null {
  if (s.priceVnd === undefined) return null;
  return { priceVnd: s.priceVnd, priceRaw: String(s.priceVnd), priceQualifier: "exact", priceMaxVnd: null, priceConfidence: 1 };
}

export interface Finalized {
  categoryId: string | null;
  priceVnd: number | null;
  priceQualifier: PriceQualifier | null;
  priceMaxVnd: number | null;
  priceConfidence: number | null;
  priceSuspect: boolean;
  attributes: Attributes;
  displayTitle: string | null;
  deal: { medianVnd: number; n: number; pct: number } | null;
}

/** Category the source defaults point at (`defaults.categoryId`), if it still exists. */
export function sourceDefaultCategory(defaults: Attributes, catalogue: CatalogueSnapshot): string | null {
  const id = defaults.categoryId;
  return typeof id === "string" && catalogue.categories.some((c) => c.id === id) ? id : null;
}

/**
 * The category a classification should fall back to: the source default when the rules found no category, or only a
 * bare category-name hit (no catalogue item) outside the default's subtree but under the same depth-1 root -- e.g.
 * "Honda City" in a car group would otherwise land in the motorbike category `honda`.
 */
function categoryOrDefault(categoryId: string | null, itemId: string | null, defaultId: string | null, catalogue: CatalogueSnapshot): string | null {
  if (defaultId === null) return categoryId;
  if (categoryId === null) return defaultId;
  if (itemId !== null || !catalogue.attrs) return categoryId;
  // A hit in another depth-1 root (e.g. an electronics hit in a vehicles group) is kept.
  const rootOf = (id: string): string | undefined => catalogue.attrs?.tree.get(id)?.split(".")[0];
  if (rootOf(categoryId) !== rootOf(defaultId)) return categoryId;
  return ancestorIds(categoryId, catalogue.attrs.tree).includes(defaultId) ? categoryId : defaultId;
}

/**
 * Final category, price check, merged attributes, display title, deal
 * score. Shared by the `enrich` job and the `attributes_backfill` job.
 */
export async function finalizeEnrichment(
  handle: SqlRunner,
  catalogue: CatalogueSnapshot,
  config: Pick<EnrichConfig, "dealWindowDays" | "dealMinPeers">,
  input: FinalizeInput,
): Promise<Finalized> {
  const a = catalogue.attrs ?? EMPTY_ATTRS;
  let categoryId = categoryOrDefault(input.categoryId, input.itemId, sourceDefaultCategory(input.sourceDefaults, catalogue), catalogue);
  let schemaOf = categoryId ? resolveSchema(categoryId, a.tree, a.schemas) : [];

  // Price checks: the raw text stays, the amount is dropped.
  let priceVnd = input.priceVnd;
  let priceQualifier = input.priceQualifier;
  let priceMaxVnd = input.priceMaxVnd;
  let priceConfidence = input.priceConfidence;
  let priceSuspect = false;
  // Only when no price survived, or the price is the phone digits themselves (an LLM price from elsewhere stands).
  const phoneDigits = input.priceRaw === null ? "" : input.priceRaw.replace(/[.,\s]/g, "");
  if (isPhoneShapedPrice(input.priceRaw) && (priceVnd === null || String(priceVnd) === phoneDigits)) {
    priceVnd = null;
    priceSuspect = true;
  } else if (priceVnd !== null) {
    const bounds = categoryId ? resolvePriceBounds(categoryId, a.tree, a.bounds) : null;
    const max = bounds ? bounds.max : DEFAULT_PRICE_MAX_VND;
    if ((bounds && priceVnd < bounds.min) || priceVnd > max) {
      priceVnd = null;
      priceSuspect = true;
    }
  }
  if (priceVnd === null) {
    priceQualifier = null;
    priceMaxVnd = null;
    priceConfidence = null;
  }

  // Attributes: item > regex > llm/stored > source defaults.
  let attributes: Attributes = {};
  if (schemaOf.length > 0) {
    const defaults: Attributes = {};
    for (const [k, v] of Object.entries(input.sourceDefaults)) if (k !== "categoryId") defaults[k] = v;
    const fromRegex = extractAttributes(input.text, schemaOf, input.at);
    const fromItem = input.itemId ? (a.itemAttributes.get(input.itemId) ?? {}) : {};
    const fromBase = validateAttributes(input.baseAttributes, schemaOf);
    // LLM-only numbers (no rule/item value for the key) must appear in the text as a whole digit run, else dropped.
    const hay = ungroupDigits(normalizeText(input.text).folded);
    for (const def of schemaOf) {
      const v = fromBase[def.key];
      if (!VERIFIED_NUMBER_KEYS.has(def.key) || def.kind !== "number" || typeof v !== "number") continue;
      if (fromRegex[def.key] !== undefined || fromItem[def.key] !== undefined) continue;
      if (!containsDigitRun(hay, String(v))) delete fromBase[def.key];
      // An LLM year that only appears as an expiry date (đăng kiểm 2027) is not the model year.
      else if (def.key === "year" && isExpiryYearOnly(input.text, v)) delete fromBase[def.key];
    }
    const fromStructured = input.structured ? validateAttributes(input.structured.attributes, schemaOf, input.at) : {};
    attributes = validateAttributes(
      { ...validateAttributes(defaults, schemaOf, input.at), ...fromBase, ...fromRegex, ...fromItem, ...fromStructured },
      schemaOf,
      input.at,
    );
  }

  // Parts / services posts with no model year do not belong in `cars` (no key attributes, no deal).
  if (categoryId && attributes.year === undefined && CAR_PARTS_RE.test(normalizeText(input.text).folded)) {
    const carsId = catalogue.categories.find((c) => c.slug === "cars")?.id;
    if (carsId && ancestorIds(categoryId, a.tree).includes(carsId)) {
      categoryId = catalogue.categories.find((c) => c.slug === "car-parts")?.id ?? null;
      schemaOf = categoryId ? resolveSchema(categoryId, a.tree, a.schemas) : [];
      attributes = {};
    }
  }

  // Deal score (A4): sell posts with a price and every required key attribute.
  let deal: Finalized["deal"] = null;
  // Only a trustworthy (exact/approx, confident) price is scored or used as a peer.
  if (categoryId && input.intent === "sell" && priceVnd !== null && isComparablePrice(priceQualifier, priceConfidence) && schemaOf.length > 0) {
    const q = buildDealPeerQuery(
      { postId: input.postId, categoryId, itemId: input.itemId, intent: input.intent, priceVnd, attributes, at: input.at },
      a,
      { windowDays: config.dealWindowDays ?? 30, limit: DEAL_PEER_LIMIT },
    );
    if (q) {
      const peers = await loadDealPeers(handle, q);
      deal = dealScore(priceVnd, peers, config.dealMinPeers ?? 5);
    }
  }

  // Display title (A5): the LLM title only when every digit run is grounded in the post / attributes.
  let displayTitle: string | null = null;
  if (schemaOf.length > 0 || input.itemId) {
    const ownerSlug = categoryId
      ? ([...ancestorIds(categoryId, a.tree)].reverse().map((id) => catalogue.categories.find((c) => c.id === id)?.slug))
      : [];
    const isCar = ownerSlug.includes("cars");
    const itemName = input.itemId ? (catalogue.items.find((i) => i.id === input.itemId)?.name ?? null) : null;
    displayTitle =
      acceptLlmTitle(input.llmTitle, normalizeText(input.text).folded, attributes, schemaOf) ??
      ruleTitle({ itemName, attributes, schema: schemaOf, isCar });
  }

  return { categoryId, priceVnd, priceQualifier, priceMaxVnd, priceConfidence, priceSuspect, attributes, displayTitle, deal };
}

/** Car-parts / services cues, on folded text. */
const CAR_PARTS_RE =
  /(?<![a-z])(?:phu tung|ra xac|thao xe|thao do|do choi (?:o to|oto|xe hoi)|gara|garage|sua chua o to|cuu ho|cho thue xe|dan phim|boc ghe)(?![a-z])/;

export interface RunEnrichJobOptions {
  handle: DbHandle;
  catalogue: CatalogueSnapshot;
  /** Term set for `prefilter()` -- see `packages/core/src/prefilter.ts` doc comment. */
  prefilterTerms: Set<string>;
  llmClient: LlmClient | undefined;
  budget: Budget | undefined;
  config: EnrichConfig;
  /** Resolves the operator userId that owns the `llm_budget` ops Notification; omit to skip that alert. */
  opsUserId?: string;
  payload: EnrichJobPayload;
  now?: () => Date;
}

export type RunEnrichJobOutcome = "stale" | "noop" | "written";

export interface RunEnrichJobResult {
  outcome: RunEnrichJobOutcome;
  engine?: "rule" | "llm";
  model?: string | null;
  tokens?: number;
  /** A `noop` that moved `enrich_state` pending -> done; the caller enqueues `match`. */
  stateChanged?: boolean;
}

let lastBudgetExhaustedLogAt = 0;

function logBudgetExhaustedThrottled(postId: string): void {
  const now = Date.now();
  if (now - lastBudgetExhaustedLogAt < BUDGET_EXHAUSTED_LOG_THROTTLE_MS) return;
  lastBudgetExhaustedLogAt = now;
  logger.warn({ postId }, "budget_exhausted");
}

interface RuleWrite {
  intent: RuleResult["intent"];
  priceVnd: number | null;
  priceRaw: string | null;
  priceQualifier: PriceQualifier | null;
  priceMaxVnd: number | null;
  priceConfidence: number | null;
  condition: RuleResult["condition"];
  categoryId: string | null;
  itemId: string | null;
  confidence: number;
  engine: "rule";
  model: null;
  promptVersion: null;
  tokens: 0;
  sentiment: null;
  intentTags: string[];
  trendTerms: null;
}

function toRuleWrite(rule: RuleResult): RuleWrite {
  return {
    intent: rule.intent,
    priceVnd: rule.priceVnd,
    priceRaw: rule.priceRaw,
    priceQualifier: rule.priceQualifier,
    priceMaxVnd: rule.priceMaxVnd,
    priceConfidence: rule.priceVnd === null ? null : rule.priceConfidence,
    condition: rule.condition,
    categoryId: rule.categoryId,
    itemId: rule.itemId,
    confidence: rule.confidence,
    engine: "rule",
    model: null,
    promptVersion: null,
    tokens: 0,
    // No LLM call -> no sentiment; tags come from the rule intent only.
    sentiment: null,
    intentTags: ruleIntentTags(rule.intent),
    trendTerms: null,
  };
}

function buildCandidates(rule: RuleResult, catalogue: CatalogueSnapshot, defaultCategoryId: string | null = null) {
  const scopeId = categoryOrDefault(rule.categoryId, rule.itemId, defaultCategoryId, catalogue);
  if (scopeId) {
    const categories = catalogue.categories.filter((c) => c.id === scopeId).map((c) => ({ slug: c.slug, name: c.name }));
    const items = catalogue.items
      .filter((i) => i.categoryId === scopeId)
      .slice(0, MAX_CANDIDATES)
      .map((i) => ({ name: i.name, categorySlug: catalogue.categories.find((c) => c.id === i.categoryId)?.slug ?? "" }));
    return { categories, items };
  }
  const topLevel = catalogue.categories
    .filter((c) => c.parentId === null)
    .slice(0, MAX_CANDIDATES)
    .map((c) => ({ slug: c.slug, name: c.name }));
  return { categories: topLevel, items: [] as { name: string; categorySlug: string }[] };
}

async function maybeAlertBudget(
  handle: DbHandle,
  opsUserId: string | undefined,
  before: UsageTotals,
  after: UsageTotals,
  budget: Budget,
  now: Date,
): Promise<void> {
  if (!opsUserId) return;
  if (!budget.crossedAlertPct(before, after)) return;
  const date = now.toISOString().slice(0, 10);
  const dedupeKey = `llm_budget:${date}`;
  const payload = { ops: { kind: "llm_budget", text: `LLM daily token budget crossed alert threshold (${date})`, dedupeKey } };
  // `insert ... where not exists` is not atomic --
  // two workers crossing the alert threshold concurrently could both pass
  // the existence check before either commits. The
  // `notification_ops_dedupe_key_unique` partial index (migration 0016)
  // makes this an atomic `on conflict ... do nothing`, so "exactly
  // one" holds under concurrency.
  await handle.sql`
    insert into notification (user_id, channel, status, payload)
    values (${opsUserId}, 'ops', 'pending', ${JSON.stringify(payload)}::jsonb)
    on conflict ((payload -> 'ops' ->> 'dedupeKey')) where channel = 'ops' and (payload -> 'ops' ->> 'kind') = 'llm_budget' and (payload -> 'ops' ->> 'dedupeKey') is not null
    do nothing
  `;
}

/**
 * Runs one `enrich` job (behaviour rules 1-14). Pure w.r.t. its inputs
 * except for the DB reads/writes and the injected `llmClient`/`budget`.
 */
export async function runEnrichJob(opts: RunEnrichJobOptions): Promise<RunEnrichJobResult> {
  const now = (opts.now ?? (() => new Date()))();
  const { handle, payload, catalogue, config } = opts;

  const [post] = await handle.db
    .select({
      id: schema.post.id,
      sourceId: schema.post.sourceId,
      postedAt: schema.post.postedAt,
      firstSeenAt: schema.post.firstSeenAt,
      editCount: schema.post.editCount,
      text: schema.post.text,
      authorName: schema.post.authorName,
      textNormalized: schema.post.textNormalized,
      enrichState: schema.post.enrichState,
      // Hash of the exact text this job enriches; the write lands only while the live post still has it.
      textHash: sql<string>`md5(${schema.post.text})`,
      capture: schema.post.capture,
      raw: schema.post.raw,
    })
    .from(schema.post)
    .where(eq(schema.post.id, payload.postId))
    .limit(1);

  if (!post) {
    logger.warn({ postId: payload.postId }, "enrich job: post not found, skipping");
    return { outcome: "stale" };
  }

  if (post.editCount > payload.revision) {
    logger.info({ postId: payload.postId, revision: payload.revision, editCount: post.editCount }, "enrich job: stale revision, skipping");
    return { outcome: "stale" };
  }

  const currentPromptVersion = promptVersionOf(getPrompt("enrich"));

  const [existing] = await handle.db
    .select({ revision: schema.enrichment.revision, promptVersion: schema.enrichment.promptVersion, textHash: schema.enrichment.textHash })
    .from(schema.enrichment)
    .where(eq(schema.enrichment.postId, payload.postId))
    .limit(1);

  if (!payload.force && payload.reason !== "capture_upgrade" && existing && existing.revision === payload.revision && existing.promptVersion === currentPromptVersion && existing.textHash === post.textHash) {
    // A pending post whose enrichment is already current is finished here.
    if (post.enrichState !== "pending") return { outcome: "noop" };
    const flipped = await markEnrichDone(handle, payload.postId, payload.revision, post.textHash);
    return { outcome: "noop", stateChanged: flipped };
  }

  const rule = runRules({ text: post.text, textNormalized: post.textNormalized }, catalogue.dict);

  const [sourceRow] = await handle.db.select({ defaults: schema.source.defaults }).from(schema.source).where(eq(schema.source.id, post.sourceId)).limit(1);
  const finalizeCtx: FinalizeCtx = {
    handle,
    catalogue,
    config,
    postId: post.id,
    text: post.text,
    at: post.postedAt ?? post.firstSeenAt,
    sourceDefaults: sourceRow?.defaults ?? {},
    authorName: post.authorName,
    trendMax: config.trendMaxTerms ?? 5,
    structured: structuredOf(post.capture, post.raw),
  };

  const textHash = post.textHash;
  async function writeRule(): Promise<RunEnrichJobResult> {
    // A backfill job only upgrades an existing LLM row; whenever the LLM path is
    // unavailable (budget, failure, disabled) it completes without writing so enrich@3 data survives.
    if (payload.reason === "insights_backfill") {
      // Hotfix: record the failed attempt (updated_at > created_at) so the backfill backs off instead of re-queueing hourly.
      await markBackfillAttempt(handle, payload.postId, payload.revision, now);
      return { outcome: "noop" };
    }
    const write = await withFinal(finalizeCtx, toRuleWrite(rule));
    const wrote = await upsertEnrichment(handle, payload.postId, payload.revision, textHash, write, now);
    if (!wrote) return { outcome: "stale" };
    return { outcome: "written", engine: "rule", model: null, tokens: 0 };
  }

  if (payload.engine === "rule") {
    return writeRule();
  }

  // An API post already carries its specs; the LLM runs only on an explicit llm request.
  if (finalizeCtx.structured && payload.engine !== "llm") {
    return writeRule();
  }

  if (payload.engine !== "llm" && rule.confidence >= config.ruleConfidenceMin) {
    return writeRule();
  }

  const shouldConsiderLlm =
    payload.engine === "llm" ? true : config.enrichAll || prefilter(post.textNormalized, opts.prefilterTerms, rule);

  if (!shouldConsiderLlm) {
    return writeRule();
  }

  if (!opts.llmClient || !opts.budget) {
    logger.info({ postId: payload.postId }, "llm_disabled");
    return writeRule();
  }

  if (await opts.budget.isExhausted()) {
    logBudgetExhaustedThrottled(payload.postId);
    return writeRule();
  }

  if (payload.reason === "insights_backfill" && isLlmQuotaBlocked(now)) return { outcome: "noop" };

  const candidates = buildCandidates(rule, catalogue, sourceDefaultCategory(finalizeCtx.sourceDefaults, catalogue));
  const promptInput: EnrichPromptInput = {
    text: post.text.slice(0, MAX_PROMPT_TEXT_CHARS),
    candidates,
    attributeSchemas: candidateSchemas(candidates.categories, catalogue),
    ruleHint: {
      intent: rule.intent,
      priceVnd: rule.priceVnd,
      condition: rule.condition,
      categoryId: rule.categoryId,
      itemId: rule.itemId,
      confidence: rule.confidence,
      hits: rule.hits,
    },
  };
  const renderedPrompt = getPrompt("enrich").render(promptInput);

  let totalTokens = 0;

  const cheapResult = await opts.llmClient.complete({ model: config.modelCheap, prompt: renderedPrompt, schema: EnrichOutputV3 });
  if (cheapResult.usage) {
    totalTokens += cheapResult.usage.totalTokens;
    const { before, after } = await opts.budget.recordUsage(cheapResult.usage);
    await maybeAlertBudget(handle, opts.opsUserId, before, after, opts.budget, now);
  }

  if (cheapResult.ok && cheapResult.data.confidence >= config.llmConfidenceMin) {
    return acceptLlm(finalizeCtx, payload, candidates, rule, cheapResult.data, config.modelCheap, totalTokens, textHash, now);
  }

  if (!cheapResult.ok && isQuotaFailure(cheapResult)) {
    tripLlmQuotaBreaker(now);
    logger.warn({ postId: payload.postId, status: cheapResult.status, raw: cheapResult.raw?.slice(0, 200) }, "enrich: LLM quota/rate limit, pausing backfill");
    // Only backfill skips strong; live posts escalate (strong may be on a different provider).
    if (payload.reason === "insights_backfill") return writeRule();
  }

  if (!cheapResult.ok) {
    logger.info({ postId: payload.postId, reason: cheapResult.reason, status: cheapResult.status, raw: cheapResult.raw?.slice(0, 200) }, "enrich: cheap model failed, escalating to strong");
  }

  // the budget check runs "before every LLM call",
  // but only the cheap call was gated -- a cheap call that alone exhausted
  // the budget still fell through to the costlier strong call unchecked.
  if (await opts.budget.isExhausted()) {
    logBudgetExhaustedThrottled(payload.postId);
    return writeRule();
  }

  const strongResult = await opts.llmClient.complete({ model: config.modelStrong, prompt: renderedPrompt, schema: EnrichOutputV3 });
  if (strongResult.usage) {
    totalTokens += strongResult.usage.totalTokens;
    const { before, after } = await opts.budget.recordUsage(strongResult.usage);
    await maybeAlertBudget(handle, opts.opsUserId, before, after, opts.budget, now);
  }

  if (strongResult.ok) {
    return acceptLlm(finalizeCtx, payload, candidates, rule, strongResult.data, config.modelStrong, totalTokens, textHash, now);
  }

  if (isQuotaFailure(strongResult)) tripLlmQuotaBreaker(now);
  logger.info({ postId: payload.postId, reason: strongResult.reason, status: strongResult.status, raw: strongResult.raw?.slice(0, 200) }, "enrich: strong model failed, writing rule result");
  return writeRule();
}

async function acceptLlm(
  ctx: FinalizeCtx,
  payload: EnrichJobPayload,
  candidates: ReturnType<typeof buildCandidates>,
  rule: RuleResult,
  data: {
    intent: "sell" | "buy" | "other";
    priceVnd: number | null;
    condition: "new" | "like_new" | "used" | "broken" | "unknown";
    categorySlug: string | null;
    itemName: string | null;
    confidence: number;
    attributes: Record<string, string | number>;
    displayTitle?: string | undefined;
    sentiment?: "neg" | "neu" | "pos" | null | undefined;
    intentTags?: string[] | undefined;
    trendTerms?: string[] | undefined;
  },
  model: string,
  tokens: number,
  textHash: string,
  now: Date,
): Promise<RunEnrichJobResult> {
  const { handle, catalogue } = ctx;
  const categoryId = data.categorySlug
    ? (catalogue.categories.find((c) => candidates.categories.some((cc) => cc.slug === data.categorySlug) && c.slug === data.categorySlug)?.id ?? null)
    : null;
  const itemId = data.itemName
    ? (catalogue.items.find((i) => candidates.items.some((ci) => ci.name === data.itemName) && i.name === data.itemName)?.id ?? null)
    : null;

  // Masked-price defect (live corpus, 2026-09): a regex-detected masked price
  // (behaviour rules 1-3) always wins over the LLM's `priceVnd` for the same
  // text, so a masked amount like "5x.000.000" can never come back as a
  // fabricated exact number. Log the discard so it is visible in ops.
  if (rule.priceMasked && data.priceVnd !== null && data.priceVnd !== rule.priceVnd) {
    logger.warn(
      { postId: payload.postId, llmPriceVnd: data.priceVnd, maskedPriceVnd: rule.priceVnd, priceRaw: rule.priceRaw },
      "enrich: masked-price detector discarded LLM priceVnd",
    );
  }

  // The rule price (with its qualifier) wins; an LLM price is kept only when its digits are in the text.
  const llmPrice = rule.priceVnd === null ? guardLlmPrice(data.priceVnd) : null;
  const llmGrounded = llmPrice !== null && isPriceGrounded(ctx.text, llmPrice);
  if (llmPrice !== null && !llmGrounded) {
    logger.warn({ postId: payload.postId, llmPriceVnd: llmPrice }, "enrich: LLM price not found in text, dropped");
  }
  const write = await withFinal(
    ctx,
    {
      intent: data.intent,
      priceVnd: rule.priceVnd !== null ? rule.priceVnd : llmGrounded ? llmPrice : null,
      priceQualifier: rule.priceVnd !== null ? rule.priceQualifier : llmGrounded ? "exact" : null,
      priceMaxVnd: rule.priceVnd !== null ? rule.priceMaxVnd : null,
      priceConfidence: rule.priceVnd !== null ? rule.priceConfidence : llmGrounded ? LLM_PRICE_CONFIDENCE : null,
      // `rule.priceRaw` is also set for a phone-shaped number (price null): kept so the post can be flagged.
      priceRaw: rule.priceRaw,
      condition: data.condition,
      categoryId,
      itemId,
      confidence: rule.priceMasked ? Math.min(data.confidence, MASKED_PRICE_CONFIDENCE_CAP) : data.confidence,
      engine: "llm" as const,
      model,
      promptVersion: promptVersionOf(getPrompt("enrich")),
      tokens,
      sentiment: data.sentiment ?? null,
      intentTags: [...new Set([...(data.intentTags ?? []), ...ruleIntentTags(data.intent)])],
      // Only the sanitised LLM part is stored (attribute/item terms are derived again at rollup).
      trendTerms: postTrendTerms({ text: "", attributes: null, itemName: null, llmTerms: data.trendTerms ?? [], authorNames: ctx.authorName ? [ctx.authorName] : [], max: ctx.trendMax }),
    },
    { attributes: data.attributes, title: data.displayTitle },
  );
  const wrote = await upsertEnrichment(handle, payload.postId, payload.revision, textHash, write, now);
  if (!wrote) return { outcome: "stale" };
  return { outcome: "written", engine: "llm", model, tokens };
}

interface FinalizeCtx {
  handle: DbHandle;
  catalogue: CatalogueSnapshot;
  config: Pick<EnrichConfig, "dealWindowDays" | "dealMinPeers">;
  postId: string;
  text: string;
  at: Date;
  sourceDefaults: Attributes;
  /** The post author, excluded from trend terms. */
  authorName: string | null;
  trendMax: number;
  structured?: Structured | undefined;
}

type BaseWrite = Omit<EnrichmentWrite, "attributes" | "priceSuspect" | "dealMedianVnd" | "dealN" | "dealPct" | "displayTitle">;

/** Runs `finalizeEnrichment` on a base write (rule or LLM) and merges the attribute / price / deal / title columns. */
async function withFinal(ctx: FinalizeCtx, plain: BaseWrite, llm?: { attributes: unknown; title: string | undefined }): Promise<EnrichmentWrite> {
  let base = plain;
  if (ctx.structured) {
    // Intent and price from the API override the text-derived ones (rule and LLM writes alike).
    const sp = structuredPrice(ctx.structured);
    base = { ...base, ...(ctx.structured.intent ? { intent: ctx.structured.intent } : {}), ...(sp ?? {}) };
  }
  const fin = await finalizeEnrichment(ctx.handle, ctx.catalogue, ctx.config, {
    postId: ctx.postId,
    text: ctx.text,
    at: ctx.at,
    sourceDefaults: ctx.sourceDefaults,
    intent: base.intent,
    categoryId: base.categoryId,
    itemId: base.itemId,
    priceVnd: base.priceVnd,
    priceRaw: base.priceRaw,
    priceQualifier: base.priceQualifier,
    priceMaxVnd: base.priceMaxVnd,
    priceConfidence: base.priceConfidence,
    baseAttributes: llm?.attributes,
    llmTitle: llm?.title,
    structured: ctx.structured,
  });
  return {
    ...base,
    categoryId: fin.categoryId,
    priceVnd: fin.priceVnd,
    priceQualifier: fin.priceQualifier,
    priceMaxVnd: fin.priceMaxVnd,
    priceConfidence: fin.priceConfidence,
    priceSuspect: fin.priceSuspect,
    attributes: fin.attributes,
    displayTitle: fin.displayTitle,
    dealMedianVnd: fin.deal?.medianVnd ?? null,
    dealN: fin.deal?.n ?? null,
    dealPct: fin.deal?.pct ?? null,
  };
}

/** Candidate categories that carry a (possibly inherited) attribute schema, for the prompt. */
function candidateSchemas(categories: { slug: string }[], catalogue: CatalogueSnapshot): { categorySlug: string; schema: AttributeSchema }[] {
  const a = catalogue.attrs;
  if (!a) return [];
  const out: { categorySlug: string; schema: AttributeSchema }[] = [];
  for (const c of categories) {
    const cat = catalogue.categories.find((x) => x.slug === c.slug);
    if (!cat) continue;
    const schemaOf = resolveSchema(cat.id, a.tree, a.schemas);
    if (schemaOf.length > 0) out.push({ categorySlug: c.slug, schema: schemaOf });
  }
  return out;
}

interface EnrichmentWrite {
  intent: string;
  priceVnd: number | null;
  priceRaw: string | null;
  priceQualifier: PriceQualifier | null;
  priceMaxVnd: number | null;
  priceConfidence: number | null;
  condition: string;
  categoryId: string | null;
  itemId: string | null;
  confidence: number;
  engine: "rule" | "llm";
  model: string | null;
  promptVersion: string | null;
  tokens: number;
  sentiment: string | null;
  intentTags: string[];
  trendTerms: string[] | null;
  attributes: Attributes;
  priceSuspect: boolean;
  dealMedianVnd: number | null;
  dealN: number | null;
  dealPct: number | null;
  displayTitle: string | null;
}

async function upsertEnrichment(
  handle: DbHandle,
  postId: string,
  revision: number,
  textHash: string,
  write: EnrichmentWrite,
  now: Date,
): Promise<boolean> {
  // One statement: the enrichment row is inserted only if the live post still has the
  // revision AND the exact text this job enriched (`edit_count` + `md5(text)` checked in the `select ... from post`),
  // so a stale same-revision DOM-text write after an in-place capture upgrade is a no-op. The
  // `where enrichment.revision <= excluded.revision` keeps an older revision from clobbering a newer row.
  // The post's pipeline state moves to enrich=done / match=pending in the same statement when a row landed
  // (every transition bumps pipeline_version and clears the retry bookkeeping).
  const rows = await handle.sql`
    with ins as (
      insert into enrichment (post_id, revision, intent, price_vnd, price_raw, condition, category_id, item_id, confidence, engine, model, prompt_version, tokens, text_hash, updated_at,
        attributes, attributes_version, price_suspect, deal_median_vnd, deal_n, deal_pct, display_title, sentiment, intent_tags, trend_terms,
        price_qualifier, price_max_vnd, price_confidence)
      select p.id, ${revision}::int, ${write.intent}::text, ${write.priceVnd}::float8, ${write.priceRaw}::text, ${write.condition}::text,
        ${write.categoryId}::uuid, ${write.itemId}::uuid, ${write.confidence}::float8, ${write.engine}::text, ${write.model}::text,
        ${write.promptVersion}::text, ${write.tokens}::int, ${textHash}::text, ${now.toISOString()}::timestamptz,
        ${JSON.stringify(write.attributes)}::jsonb, ${ATTRIBUTES_VERSION}::int, ${write.priceSuspect}::boolean, ${write.dealMedianVnd}::bigint,
        ${write.dealN}::int, ${write.dealPct}::real, ${write.displayTitle}::text, ${write.sentiment}::text, ${write.intentTags}::text[], ${write.trendTerms}::text[],
        ${write.priceQualifier}::text, ${write.priceMaxVnd}::float8, ${write.priceConfidence}::real
      from post p
      where p.id = ${postId}::uuid and p.edit_count = ${revision}::int and md5(p.text) = ${textHash}::text
      on conflict (post_id) do update set
        revision = excluded.revision,
        intent = excluded.intent,
        price_vnd = excluded.price_vnd,
        price_raw = excluded.price_raw,
        condition = excluded.condition,
        category_id = excluded.category_id,
        item_id = excluded.item_id,
        confidence = excluded.confidence,
        engine = excluded.engine,
        model = excluded.model,
        prompt_version = excluded.prompt_version,
        tokens = excluded.tokens,
        text_hash = excluded.text_hash,
        attributes = excluded.attributes,
        attributes_version = excluded.attributes_version,
        price_suspect = excluded.price_suspect,
        deal_median_vnd = excluded.deal_median_vnd,
        deal_n = excluded.deal_n,
        deal_pct = excluded.deal_pct,
        display_title = excluded.display_title,
        sentiment = excluded.sentiment,
        intent_tags = excluded.intent_tags,
        trend_terms = excluded.trend_terms,
        price_qualifier = excluded.price_qualifier,
        price_max_vnd = excluded.price_max_vnd,
        price_confidence = excluded.price_confidence,
        updated_at = excluded.updated_at
      where enrichment.revision <= excluded.revision
      returning post_id
    ), upd as (
      update post set enrich_state = 'done', match_state = 'pending', pipeline_version = pipeline_version + 1,
        pipeline_attempts = 0, pipeline_reconciled_at = null, pipeline_updated_at = now()
      where id = ${postId}::uuid and edit_count = ${revision}::int and md5(text) = ${textHash}::text
        and exists (select 1 from ins)
      returning id
    )
    select count(*)::int as n from ins
  `;
  // No row = stale (revision or text moved on): the caller must not claim "written" nor enqueue `match`.
  return Number((rows[0] as { n: number } | undefined)?.n ?? 0) > 0;
}

/** No-op enrichment on a still-pending post -> `enrich_state='done'`; true when a row changed. */
async function markEnrichDone(handle: DbHandle, postId: string, revision: number, textHash: string): Promise<boolean> {
  const rows = await handle.sql`
    update post set enrich_state = 'done', match_state = 'pending', pipeline_version = pipeline_version + 1,
      pipeline_attempts = 0, pipeline_reconciled_at = null, pipeline_updated_at = now()
    where id = ${postId}::uuid and enrich_state = 'pending' and edit_count = ${revision}::int and md5(text) = ${textHash}::text
    returning id
  `;
  return rows.length > 0;
}

/**
 * Terms set for `prefilter()`: normalized Watch
 * `include`/`includeAll` entries, every alias of items referenced by a
 * Watch's `itemIds`, and raw Watch `categoryIds` (matched by exact id
 * membership against `rule.categoryId`, see `prefilter.ts`).
 */
export async function buildPrefilterTerms(handle: DbHandle, dict: AliasDict): Promise<Set<string>> {
  const watches = await handle.db
    .select({
      include: schema.watch.include,
      includeAll: schema.watch.includeAll,
      categoryIds: schema.watch.categoryIds,
      itemIds: schema.watch.itemIds,
    })
    .from(schema.watch)
    .where(eq(schema.watch.enabled, true));

  const terms = new Set<string>();
  const itemIds = new Set<string>();
  for (const w of watches) {
    for (const t of w.include) terms.add(t);
    for (const t of w.includeAll) terms.add(t);
    for (const id of w.categoryIds) terms.add(id);
    for (const id of w.itemIds) itemIds.add(id);
  }
  if (itemIds.size > 0) {
    for (const entry of dict.entries as { alias: string; itemId: string | null }[]) {
      if (entry.itemId && itemIds.has(entry.itemId)) terms.add(entry.alias);
    }
  }
  return terms;
}

/**
 * Enqueues the post-enrichment `match` run. A failure here must not fail or
 * retry the enrich job (the enrichment is already committed); the reconcile
 * cron and the next edit of the post are the recovery paths.
 */
async function enqueueMatchAfterEnrich(boss: PgBoss, postId: string): Promise<void> {
  try {
    await boss.send(
      MATCH_QUEUE,
      matchJobSchema.parse({ postId, trigger: "enrich" }),
      { retryLimit: 3, expireInSeconds: 60 },
    );
  } catch (err) {
    logger.error({ err, postId }, "enrich job: failed to enqueue match after enrichment");
  }
}

export interface RegisterEnrichJobOptions {
  boss: PgBoss;
  handle: DbHandle;
  catalogueSnapshot: () => CatalogueSnapshot;
  llmClient: LlmClient | undefined;
  budget: Budget | undefined;
  fetchConfig: () => Promise<EnrichConfig>;
  fetchOpsUserId: () => Promise<string | undefined>;
}

/** Registers the `enrich` pg-boss worker (production wiring). */
export async function registerEnrichJob(options: RegisterEnrichJobOptions): Promise<void> {
  await options.boss.createQueue(ENRICH_QUEUE);
  await options.boss.work<unknown>(ENRICH_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const parsed = enrichJobPayloadSchema.safeParse(job.data);
      if (!parsed.success) {
        logger.error({ jobId: job.id, issues: parsed.error.issues }, "enrich job: invalid payload, skipping");
        continue;
      }
      const payload = parsed.data;
      const catalogue = options.catalogueSnapshot();
      const prefilterTerms = await buildPrefilterTerms(options.handle, catalogue.dict);
      const config = await options.fetchConfig();
      const opsUserId = await options.fetchOpsUserId();
      const result = await runEnrichJob({
        handle: options.handle,
        catalogue,
        prefilterTerms,
        llmClient: options.llmClient,
        budget: options.budget,
        config,
        opsUserId,
        payload,
      });
      logger.info({ postId: payload.postId, revision: payload.revision, ...result }, "enrich job done");
      // The `match` job has two triggers, `ingest` and `enrich`.
      // Only the ingest one was ever wired, so matching always ran before
      // `intent`/`priceVnd` existed and every watch with a price or intent
      // filter silently matched nothing. Re-run it once the enrichment has
      // actually landed -- never on a stale write, nor on a no-op that left the
      // pipeline state alone (a no-op that flipped `pending` -> `done` does enqueue).
      if (result.outcome === "written" || result.stateChanged) {
        await enqueueMatchAfterEnrich(options.boss, payload.postId);
      }
    }
  });
}

async function fetchOpsUserIdDefault(handle: DbHandle): Promise<string | undefined> {
  return resolveOpsUserId(handle);
}

export { fetchOpsUserIdDefault };

// One-time backfill of sentiment / intent tags onto already-enriched posts.
export const INSIGHTS_BACKFILL_QUEUE = "insights_backfill";
/** Hotfix: a backfill row whose LLM attempt failed is not re-queued for this long. */
const BACKFILL_RETRY_BACKOFF_MS = 12 * 60 * 60 * 1000;
/** Hotfix: after an LLM 429 the backfill pass is paused for this long (per worker process). */
const LLM_QUOTA_COOLDOWN_MS = 30 * 60 * 1000;
let llmQuotaBlockedUntil = 0;

export function isQuotaFailure(r: { ok: boolean; reason?: string; status?: number; raw?: string }): boolean {
  if (r.ok || r.reason !== "http") return false;
  if (r.status === 429) return true;
  // Some OpenAI-compatible gateways wrap upstream quota errors as 502/503 with the original status in the body.
  return (r.status === 502 || r.status === 503) && /\[429\]|usage limit|rate limit|quota/i.test(r.raw ?? "");
}
export function tripLlmQuotaBreaker(now: Date): void {
  llmQuotaBlockedUntil = now.getTime() + LLM_QUOTA_COOLDOWN_MS;
}
export function isLlmQuotaBlocked(now: Date): boolean {
  return now.getTime() < llmQuotaBlockedUntil;
}
export function resetLlmQuotaBreaker(): void {
  llmQuotaBlockedUntil = 0;
}

async function markBackfillAttempt(handle: DbHandle, postId: string, revision: number, now: Date): Promise<void> {
  await handle.sql`update enrichment set updated_at = ${now.toISOString()}::timestamptz where post_id = ${postId}::uuid and revision = ${revision}::int and engine = 'llm'`;
}
const INSIGHTS_BACKFILL_CRON = "*/10 * * * *";

export interface InsightBackfillOptions {
  now: Date;
  budget: Pick<Budget, "isExhausted"> | undefined;
  /** Config `insights.backfillDays` (default 7). */
  backfillDays?: number;
  /** Config `insights.backfillMaxPerRun` (default 500). */
  maxPerRun?: number;
  /** Queued backfill enrich jobs (default: SQL on the pg-boss job table); a run is skipped while any remain. */
  countQueued?: () => Promise<number>;
  bossSchema?: string;
}

/**
 * Re-enriches (through the normal `enrich` job, so the LLM budget and ladder apply) LLM rows of the last
 * `backfillDays` that predate the current enrich prompt (`enrich@5`), and tags rule rows from their intent by SQL. Makes no LLM call itself.
 */
export async function runInsightBackfill(
  handle: DbHandle,
  boss: Pick<PgBoss, "send">,
  opts: InsightBackfillOptions,
): Promise<{ enqueued: number; ruleTagged: number }> {
  const days = opts.backfillDays ?? 7;
  const max = opts.maxPerRun ?? 500;
  const cutoff = new Date(opts.now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  const current = promptVersionOf(getPrompt("enrich"));

  const tagged = await handle.sql`
    update enrichment e set intent_tags = case e.intent when 'sell' then array['sell']::text[] when 'buy' then array['buy']::text[] else '{}'::text[] end
    from post p
    where p.id = e.post_id and e.engine = 'rule' and p.first_seen_at >= ${cutoff}::timestamptz
      and e.intent_tags is distinct from case e.intent when 'sell' then array['sell']::text[] when 'buy' then array['buy']::text[] else '{}'::text[] end
    returning e.post_id
  `;

  if (opts.budget && (await opts.budget.isExhausted())) return { enqueued: 0, ruleTagged: tagged.length };
  if (isLlmQuotaBlocked(opts.now)) return { enqueued: 0, ruleTagged: tagged.length };
  const retryAfter = new Date(opts.now.getTime() - BACKFILL_RETRY_BACKOFF_MS).toISOString();
  const queued = opts.countQueued
    ? await opts.countQueued()
    : Number(
        (
          await handle.sql`
            select count(*)::int as n from ${handle.sql(opts.bossSchema ?? "pgboss")}.job
            where name = ${ENRICH_QUEUE} and state = 'created' and singleton_key like ${INSIGHTS_BACKFILL_QUEUE + ":%"}
          `
        )[0]?.n ?? 0,
      );
  if (queued > 0) return { enqueued: 0, ruleTagged: tagged.length };
  const rows = await handle.sql<{ post_id: string; revision: number }[]>`
    select e.post_id, e.revision from enrichment e join post p on p.id = e.post_id
    where e.engine = 'llm' and e.revision = p.edit_count and e.prompt_version <> ${current}::text and p.first_seen_at >= ${cutoff}::timestamptz
      and (e.updated_at <= e.created_at or e.updated_at < ${retryAfter}::timestamptz)
    order by p.first_seen_at desc limit ${max}::int
  `;
  for (const r of rows) {
    await boss.send(
      ENRICH_QUEUE,
      enrichJobPayloadSchema.parse({ postId: r.post_id, revision: r.revision, engine: "llm", reason: "insights_backfill" }),
      { retryLimit: 3, expireInSeconds: 300, singletonKey: `${INSIGHTS_BACKFILL_QUEUE}:${r.post_id}`, singletonSeconds: 3600 },
    );
  }
  return { enqueued: rows.length, ruleTagged: tagged.length };
}

export interface RegisterInsightBackfillOptions {
  boss: PgBoss;
  handle: DbHandle;
  budget: () => Budget | undefined;
  bossSchema?: string;
  fetchConfig: () => Promise<{ backfillDays: number; maxPerRun: number }>;
}

export async function registerInsightBackfillJob(options: RegisterInsightBackfillOptions): Promise<void> {
  const { boss, handle } = options;
  await boss.createQueue(INSIGHTS_BACKFILL_QUEUE);
  await boss.schedule(INSIGHTS_BACKFILL_QUEUE, INSIGHTS_BACKFILL_CRON, null, { singletonKey: INSIGHTS_BACKFILL_QUEUE });
  await boss.work(INSIGHTS_BACKFILL_QUEUE, async () => {
    const cfg = await options.fetchConfig();
    const r = await runInsightBackfill(handle, boss, { now: new Date(), budget: options.budget(), ...(options.bossSchema ? { bossSchema: options.bossSchema } : {}), ...cfg });
    if (r.enqueued > 0 || r.ruleTagged > 0) logger.info(r, "insights_backfill done");
  });
}
