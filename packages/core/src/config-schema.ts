import { z } from "zod";

const minMax = z.object({ min: z.number(), max: z.number() });

/**
 * Zod registry for every `Config` key seeded by `config/defaults.yaml`
 * (`GET /api/config/schema`). Keys registered here are
 * the only ones `PUT /api/config/:key` accepts; an unknown key is a 400.
 */
/** Dotted DNS hostname, lowercase, last label has a letter (so no IPv4 or numeric-only entries). */
const HOSTNAME_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]*[a-z][a-z0-9-]*$/;

export const configSchemas = {
  "app.tz": z.string().min(1),

  "llm.model.cheap": z.string().min(1),
  "llm.model.strong": z.string().min(1),
  "llm.enrichAll": z.boolean(),
  "llm.confidenceThreshold": z.number().min(0).max(1),
  "llm.dailyTokenBudget": z.number().int().min(0),
  "llm.budgetAlertPct": z.number().min(0).max(100),
  "llm.timeoutMs": z.number().int().min(1),
  "llm.maxRetries": z.number().int().min(0),

  "enrich.ruleConfidenceMin": z.number().min(0).max(1),
  "enrich.llmConfidenceMin": z.number().min(0).max(1),
  "enrich.aliasRefreshSec": z.number().int().min(1),

  "schedule.activeHours": z.object({ start: z.string(), end: z.string() }),
  "schedule.dailyCapPerSource": z.number().int().min(0),
  "schedule.visitEverySec": minMax,
  "ingest.silenceAlertMultiplier": z.number().min(0),

  "match.minScore": z.number().min(0).max(1),
  "match.maxWatches": z.number().int().min(1),
  "match.reloadDebounceMs": z.number().int().min(0),
  "match.reloadIntervalSec": z.number().int().min(0),
  "match.regexMaxLen": z.number().int().min(1),
  "match.textMaxChars": z.number().int().min(1),
  "match.weakTermsPreset": z.enum(["en", "vi", "none"]),
  "match.weakTerms": z.array(z.string().min(1).max(60)).max(100),

  "notify.quietHoursStart": z.string(),
  "notify.quietHoursEnd": z.string(),
  "notify.retryMaxAttempts": z.number().int().min(0),
  "notify.retry.delaysSec": z.array(z.number().int().min(0)),
  "notify.rateLimit.perChatPerSec": z.number().min(0),
  "notify.rateLimit.perChatPerMin": z.number().min(0),
  "notify.rateLimit.globalPerSec": z.number().min(0),
  "notify.digest.defaultEveryMin": z.number().int().min(0),
  "notify.digest.maxEntries": z.number().int().min(0),
  "notify.excerptChars": z.number().int().min(0),
  "notify.ops.chatId": z.union([z.string(), z.number(), z.null()]),
  "notify.ops.recipientEmail": z.string(), // Operator who owns ops rows ("" = SEED_OPERATOR_EMAIL, then oldest operator)
  "notify.ops.failureRatePct": z.number().min(0).max(100),
  "notify.ops.minSamples": z.number().int().min(0),
  "bot.telegram.updateOffset": z.number().int().min(0),

  "analytics.rollupIntervalMinutes": z.number().int().min(1),
  "analytics.retentionDays.hour": z.number().int().min(1),
  "analytics.retentionDays.trend": z.number().int().min(1),
  "analytics.trend.minCount": z.number().int().min(1),
  "analytics.trend.minZ": z.number().gt(0),
  "analytics.trend.minLift": z.number().gt(0),
  "analytics.trend.maxTermsPerPost": z.number().int().min(1).max(8),
  "analytics.trend.overviewTop": z.number().int().min(1).max(30),
  "analytics.trend.curate.enabled": z.boolean(),
  "analytics.trend.curate.maxCandidates": z.number().int().min(1).max(200),
  "analytics.trend.curate.dailyTokenCap": z.number().int().min(0),

  "media.thumbs.enabled": z.boolean(),
  "media.thumbs.userAgent": z.string().min(1),
  "media.thumbs.batch": z.number().int().min(1),
  "media.thumbs.backfillDays": z.number().int().min(1),
  "media.thumbs.allowedHosts": z.array(z.string().min(1).max(253).regex(HOSTNAME_RE)).max(20),
  "insights.backfillDays": z.number().int().min(1),
  "insights.backfillMaxPerRun": z.number().int().min(1),
  "insights.topicsMax": z.number().int().min(1),
  "insights.spike.minVolume": z.number().int().min(1),
  "insights.spike.ratioMin": z.number().gt(0),
  "insights.spike.zMin": z.number().gt(0),
  "insights.spike.baselineDays": z.number().int().min(1).max(60),
  "insights.spike.evalHourLocal": z.number().int().min(0).max(23),
  "insights.digest.hourLocal": z.number().int().min(0).max(23),
  "insights.digest.topTopics": z.number().int().min(1),
  "insights.digest.notableMax": z.number().int().min(0),
  "insights.hourRetentionDays": z.number().int().min(1),
  "insights.deliveryMaxAttempts": z.number().int().min(1),
  "media.thumbs.maxBytes": z.number().int().min(1),
  "media.thumbs.timeoutMs": z.number().int().min(1),
  "feed.priceBands": z.array(z.number().int().min(0)),

  "retention.postRevisionDays": z.number().int().min(1),
  "retention.trendTermHistDays": z.number().int().min(1),

  // 016 ops baseline
  "ops.shutdownTimeoutMs": z.number().int().min(1000),
  "ops.dlqAlertIntervalSec": z.number().int().min(60),



  // Server-side web listing collectors
  "web.enabled": z.boolean(),
  "web.pollIntervalSec": z.number().int().min(60).max(86400),
  "web.maxSourcesPerRun": z.number().int().min(1).max(50),
  "web.maxPagesPerRun": z.number().int().min(1).max(20),
  "web.pageSize": z.number().int().min(10).max(100),
  "web.minRequestGapMs": z.number().int().min(1000).max(60000),
  "web.alertMaxAgeMinutes": z.number().int().min(1).max(10080),
  "web.backoffBaseSec": z.number().int().min(30).max(86400),
  "web.backoffMaxSec": z.number().int().min(60).max(604800),
  "web.userAgent": z.string().min(1).max(200),
  "web.allowPrivateHosts": z.boolean(),

  // Watch builder v2
  "watch.parseRatePerMin": z.number().int().min(1),
  "watch.suggestExcludePreset": z.enum(["en", "vi", "none"]),
  "watch.suggestExcludeSell": z.array(z.string().min(1).max(60)).max(20),

  // Corpus search
  "search.candidateLimit": z.number().int().min(100),
  "search.pageLimitMax": z.number().int().min(1).max(100),
  "search.exportMaxRows": z.number().int().min(1),
  "search.recencyWeight": z.number().min(0),
  "search.recencyTauDays": z.number().gt(0),
  "search.trgmMinLen": z.number().int().min(1),

  // resume, or null before any resume has happened.



  // Source library classification
  "sources.classify.minPosts": z.number().int().min(1),
  "sources.classify.windowDays": z.number().int().min(1),
  "sources.classify.topicDepth": z.number().int().min(1).max(6),
  "sources.classify.topicShareMin": z.number().gt(0).max(1),
  "sources.classify.regionMinPosts": z.number().int().min(1),
  "sources.classify.regionShareMin": z.number().gt(0).max(1),
  "sources.classify.cron": z.string().min(1),

} satisfies Record<string, z.ZodType>;

export type ConfigKey = keyof typeof configSchemas;

export function isConfigKey(key: string): key is ConfigKey {
  return Object.hasOwn(configSchemas, key);
}

/** JSON Schema for one registered key, or `undefined` for an unknown key. */
export function configJsonSchema(key: string): unknown | undefined {
  if (!isConfigKey(key)) return undefined;
  return z.toJSONSchema(configSchemas[key]);
}

/** JSON Schema for every registered key, keyed by config key. */
export function allConfigJsonSchemas(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(configSchemas) as ConfigKey[]) {
    out[key] = z.toJSONSchema(configSchemas[key]);
  }
  return out;
}
