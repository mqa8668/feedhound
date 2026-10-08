import { z } from "zod";
import { type ConfigKey, configSchemas } from "./config-schema";

/**
 * Typed registry over every Config key: section, plain-language
 * copy, UI control, visibility, default and the write schema. Pure and
 * browser-safe (imports only zod + schema modules).
 */

export type ConfigVisibility = "user" | "advanced" | "internal";
export type ConfigSectionId = "collection" | "analysis" | "insights" | "notifications" | "watches" | "system";
export type DurationUnit = "ms" | "sec" | "min" | "hours" | "days";
export type ConfigControl =
  | { kind: "toggle" }
  | { kind: "number"; unit?: "percent" | "tokens" | "posts" | "bytes" | "chars" | "px" | "perSec" | "perMin" | "vnd" }
  | { kind: "ratio" }
  | { kind: "duration"; unit: DurationUnit }
  | { kind: "range"; unit?: DurationUnit | "px" }
  | { kind: "time" }
  | { kind: "timeWindow" }
  | { kind: "hourOfDay" }
  | { kind: "select"; options: "timezones" | readonly string[] }
  | { kind: "text"; emptyAsNull?: boolean }
  | { kind: "tags" }
  | { kind: "numberList"; unit?: "sec" | "vnd" }
  | { kind: "cron" }
  | { kind: "json" };

/**
 * Keys seeded by `defaults.yaml` and read by core (`silence.ts`) but absent from
 * `configSchemas`. Registered here so the Settings page can edit them.
 */
const REGISTRY_ONLY_SCHEMAS = {
  "watchdog.gapMultiplier": z.number().gt(0),
  "watchdog.gapGraceMin": z.number().min(0),
} satisfies Record<string, z.ZodType>;

export type RegistryKey = ConfigKey | keyof typeof REGISTRY_ONLY_SCHEMAS;

export interface ConfigEntry {
  key: RegistryKey;
  section: ConfigSectionId;
  label: string;
  description: string;
  control: ConfigControl;
  visibility: ConfigVisibility;
  default: unknown;
  schema: z.ZodType;
}

export const CONFIG_SECTIONS: readonly { id: ConfigSectionId; label: string; description: string }[] = [
  { id: "collection", label: "Collection", description: "When and how often Feedhound polls your sources." },
  { id: "analysis", label: "Matching & AI", description: "Language models, confidence thresholds and matching of posts against your watches." },
  { id: "insights", label: "Dashboard insights", description: "Trends, spikes, daily digests and price bands shown on the dashboard." },
  { id: "notifications", label: "Notifications", description: "Quiet hours, digests, delivery retries and operator alerts." },
  { id: "watches", label: "Watches & search", description: "Source classification, watch parsing and corpus search." },
  { id: "system", label: "System", description: "Timezone, data retention and shutdown behaviour." },
];

interface Def {
  label: string;
  description: string;
  control: ConfigControl;
  default: unknown;
}

const d = (label: string, description: string, control: ConfigControl, def: unknown): Def => ({ label, description, control, default: def });
const toggle: ConfigControl = { kind: "toggle" };
const ratio: ConfigControl = { kind: "ratio" };
const num = (unit?: Extract<ConfigControl, { kind: "number" }>["unit"]): ConfigControl => (unit ? { kind: "number", unit } : { kind: "number" });
const dur = (unit: DurationUnit): ConfigControl => ({ kind: "duration", unit });
const range = (unit?: DurationUnit | "px"): ConfigControl => (unit ? { kind: "range", unit } : { kind: "range" });
const hour: ConfigControl = { kind: "hourOfDay" };
const text: ConfigControl = { kind: "text" };
const cron: ConfigControl = { kind: "cron" };


const DEFS = {
  "app.tz": d("Timezone", "Sets the clock for active hours, daily digests and every date shown in Feedhound.", { kind: "select", options: "timezones" }, "Asia/Ho_Chi_Minh"),

  "llm.model.cheap": d("Fast model", "The inexpensive language model used for routine post classification.", text, "gpt-4o-mini"),
  "llm.model.strong": d("Strong model", "The more capable language model used when the fast model is not confident enough.", text, "gpt-4o"),
  "llm.enrichAll": d("Analyse every post", "When on, every collected post goes through the language model, not only unclear ones.", toggle, false),
  "llm.confidenceThreshold": d("Model confidence threshold", "Answers below this confidence are retried with the strong model.", ratio, 0.7),
  "llm.dailyTokenBudget": d("Daily token budget", "Maximum language model tokens Feedhound may spend per day.", num("tokens"), 2000000),
  "llm.budgetAlertPct": d("Budget alert level", "You get an alert once the day's token usage passes this share of the budget.", num("percent"), 80),
  "llm.timeoutMs": d("Model request timeout", "How long Feedhound waits for a language model answer before giving up.", dur("ms"), 30000),
  "llm.maxRetries": d("Model retry attempts", "How many times a failed language model call is retried.", num(), 2),

  "enrich.ruleConfidenceMin": d("Rule match confidence", "Lowest confidence at which a rule-based classification is trusted without the model.", ratio, 0.7),
  "enrich.llmConfidenceMin": d("Model result confidence", "Lowest confidence at which a model classification is accepted.", ratio, 0.5),
  "enrich.aliasRefreshSec": d("Alias refresh interval", "How often brand and product aliases are reloaded for enrichment.", dur("sec"), 600),

  "schedule.activeHours": d("Collection window", "Feedhound only polls sources between these local times.", { kind: "timeWindow" }, { start: "07:00", end: "23:00" }),
  "schedule.dailyCapPerSource": d("Daily visits per source", "Maximum number of times one source is visited per day.", num(), 12),
  "schedule.visitEverySec": d("Wait between visits to a source", "A random wait in this range separates visits to the same source.", range("sec"), { min: 900, max: 2700 }),
  "ingest.silenceAlertMultiplier": d("Silence alert sensitivity", "Alert when a source posts nothing for this many times its usual gap between posts.", num(), 3),

  "watchdog.gapMultiplier": d("Missed visit tolerance", "A visit counts as missed once it is this many times later than planned.", num(), 1.5),
  "watchdog.gapGraceMin": d("Missed visit grace period", "Extra minutes allowed on top of the tolerance before a visit counts as missed.", num(), 5),

  "match.minScore": d("Minimum match score", "Posts scoring below this are not sent to you for a watch.", ratio, 0.5),
  "match.maxWatches": d("Maximum active watches", "Upper limit on watches matched at the same time.", num(), 1000),
  "match.reloadDebounceMs": d("Watch reload delay", "Wait after a watch change before reloading, to batch quick edits.", dur("ms"), 200),
  "match.reloadIntervalSec": d("Watch reload interval", "Fallback interval for refreshing watches from the database.", dur("sec"), 60),
  "match.regexMaxLen": d("Longest regex pattern", "Regex conditions longer than this are rejected.", num("chars"), 200),
  "match.weakTermsPreset": d("Generic word list", "Built-in list of generic words (en, vi or none) that never count as product evidence when a watch decides whether a post matches.", { kind: "select", options: ["en", "vi", "none"] }, "en"),
  "match.weakTerms": d("Extra generic words", "Your own words added to the built-in list; they never count as product evidence in a watch.", { kind: "tags" }, []),
  "match.textMaxChars": d("Longest text matched", "Only this much of each post is scanned for matches.", num("chars"), 20000),

  "notify.quietHoursStart": d("Quiet hours start", "From this time Feedhound holds back instant notifications.", { kind: "time" }, "22:00"),
  "notify.quietHoursEnd": d("Quiet hours end", "Held notifications are released at this time.", { kind: "time" }, "07:00"),
  "notify.retryMaxAttempts": d("Delivery attempts", "How many times a failed notification is retried before it is dropped.", num(), 5),
  "notify.retry.delaysSec": d("Retry delays", "Wait before each delivery retry, in order.", { kind: "numberList", unit: "sec" }, [5, 30, 120, 600, 1800]),
  "notify.rateLimit.perChatPerSec": d("Messages per chat each second", "Highest send rate to a single Telegram chat.", num("perSec"), 1),
  "notify.rateLimit.perChatPerMin": d("Messages per chat each minute", "Highest sustained send rate to a single Telegram chat.", num("perMin"), 20),
  "notify.rateLimit.globalPerSec": d("Messages overall each second", "Highest send rate across all chats combined.", num("perSec"), 25),
  "notify.digest.defaultEveryMin": d("Default digest interval", "How often digest-mode watches bundle their matches into one message.", dur("min"), 10),
  "notify.digest.maxEntries": d("Entries per digest", "A digest message lists at most this many matches.", num(), 20),
  "notify.excerptChars": d("Excerpt length", "How much of the post text is quoted in a notification.", num("chars"), 300),
  "notify.ops.chatId": d("Operator alert chat", "Telegram chat that receives system alerts; leave empty to turn alerts off.", { kind: "text", emptyAsNull: true }, null),
  "notify.ops.recipientEmail": d("Operator alert owner", "Email of the operator who owns system alerts; empty means the first operator.", text, ""),
  "notify.ops.failureRatePct": d("Delivery failure alert level", "Alert when this share of notifications fails to send.", num("percent"), 10),
  "notify.ops.minSamples": d("Samples before failure alert", "Minimum notifications sent before the failure rate is judged.", num(), 10),
  "bot.telegram.updateOffset": d("Telegram update offset", "Internal bookkeeping for the Telegram bot.", num(), 0),

  "analytics.rollupIntervalMinutes": d("Analytics refresh interval", "How often hourly analytics are recomputed.", dur("min"), 60),
  "analytics.retentionDays.hour": d("Hourly analytics retention", "How long hourly rollups are kept.", dur("days"), 90),
  "analytics.retentionDays.trend": d("Trend data retention", "How long trend snapshots are kept.", dur("days"), 7),
  "analytics.trend.minCount": d("Mentions needed for a trend", "A term needs at least this many mentions to be considered trending.", num(), 5),
  "analytics.trend.minZ": d("Trend strength", "How far above normal a term must be, in standard deviations, to trend.", num(), 3),
  "analytics.trend.minLift": d("Trend rise needed", "A term trends when today's mentions are at least this many times its usual level.", num(), 1.5),
  "analytics.trend.maxTermsPerPost": d("Trend terms per post", "The most trend terms taken from a single post.", num(), 5),
  "analytics.trend.overviewTop": d("Trending terms on Overview", "How many trending terms the Overview page shows.", num(), 8),
  "analytics.trend.curate.enabled": d("Tidy trending terms with AI", "Hourly, a cheap model merges spelling variants and drops generic words from the trending list.", toggle, true),
  "analytics.trend.curate.maxCandidates": d("Terms tidied per hour", "The most new trending terms sent to the model for tidying each hour.", num(), 50),
  "analytics.trend.curate.dailyTokenCap": d("Daily tidy-up token cap", "Trend tidying stops for the day once it has used this many tokens.", num("tokens"), 30000),

  "media.thumbs.enabled": d("Save thumbnails", "Download and keep small preview images of posts.", toggle, true),
  "media.thumbs.userAgent": d("Thumbnail downloader identity", "The user agent sent when downloading thumbnails.", text, "feedhound-thumbs/0.1 (+https://github.com/mqa8668/feedhound)"),
  "media.thumbs.batch": d("Thumbnails per run", "How many thumbnails are downloaded in one pass.", num(), 20),
  "media.thumbs.backfillDays": d("Thumbnail backfill window", "Only posts newer than this get missing thumbnails fetched.", dur("days"), 7),
  "media.thumbs.maxBytes": d("Largest thumbnail", "Images bigger than this are skipped.", num("bytes"), 5242880),
  "media.thumbs.timeoutMs": d("Thumbnail download timeout", "How long to wait for one image before skipping it.", dur("ms"), 15000),

  "media.thumbs.allowedHosts": d("Thumbnail image hosts", "Image hosts thumbnails may be downloaded from; subdomains included.", { kind: "tags" }, []),
  "insights.backfillDays": d("Insights backfill window", "How far back insights are computed when new data arrives late.", dur("days"), 7),
  "insights.backfillMaxPerRun": d("Insights backfill per run", "Most posts reprocessed for insights in a single run.", num("posts"), 500),
  "insights.topicsMax": d("Topics shown", "The most topics listed on the Insights page.", num(), 20),
  "insights.spike.minVolume": d("Posts needed for a spike", "A topic needs at least this many posts before it can count as a spike.", num("posts"), 10),
  "insights.spike.ratioMin": d("Spike ratio", "A topic spikes when it exceeds its usual volume by this multiple.", num(), 3),
  "insights.spike.zMin": d("Spike strength", "Statistical strength, in standard deviations, needed to call a spike.", num(), 3),
  "insights.spike.baselineDays": d("Spike baseline window", "Days of history that define a topic's usual volume.", dur("days"), 7),
  "insights.spike.evalHourLocal": d("Spike check time", "Hour of the day when spikes are evaluated.", hour, 6),
  "insights.digest.hourLocal": d("Daily digest time", "Hour of the day when the insights digest is sent.", hour, 8),
  "insights.digest.topTopics": d("Topics in the digest", "How many top topics the daily digest lists.", num(), 5),
  "insights.digest.notableMax": d("Notable posts in the digest", "How many standout posts the daily digest lists.", num(), 5),
  "insights.hourRetentionDays": d("Hourly insight retention", "How long hour-level insight data is kept.", dur("days"), 30),
  "insights.deliveryMaxAttempts": d("Digest delivery attempts", "How many times a failed digest delivery is retried.", num(), 3),
  "feed.priceBands": d("Price bands", "Boundaries, in VND, that split the feed's price filter into ranges.", { kind: "numberList", unit: "vnd" }, [300000000, 600000000, 1000000000]),

  "retention.postRevisionDays": d("Post revision history", "How long earlier versions of edited posts are kept.", dur("days"), 180),
  "retention.trendTermHistDays": d("Trend term history", "How long per-term trend history is kept.", dur("days"), 90),

  "ops.shutdownTimeoutMs": d("Shutdown grace period", "How long services wait for running work to finish when stopping.", dur("ms"), 30000),
  "ops.dlqAlertIntervalSec": d("Failed jobs alert interval", "Shortest wait between alerts about jobs stuck in the failed queue.", dur("sec"), 3600),



  "web.enabled": d("Web listing sources", "Poll public feeds and listing pages from the server.", toggle, false),
  "web.pollIntervalSec": d("Web poll interval", "Shortest wait before a web source is polled again.", dur("sec"), 600),
  "web.maxSourcesPerRun": d("Web sources per run", "The most web sources polled in one run.", num(), 5),
  "web.maxPagesPerRun": d("Web pages per source", "The most listing pages read per source in one run.", num(), 3),
  "web.pageSize": d("Web page size", "Listings requested per page.", num(), 50),
  "web.minRequestGapMs": d("Web request gap", "Minimum pause between two requests to the same site.", dur("ms"), 5000),
  "web.alertMaxAgeMinutes": d("Web alert max age", "Listings older than this are stored and matched but never alert, so a new source does not flood Telegram.", dur("min"), 120),
  "web.backoffBaseSec": d("Web backoff base", "First wait after a failed web poll; doubles on each further failure.", dur("sec"), 300),
  "web.backoffMaxSec": d("Web backoff cap", "Longest wait after repeated failed web polls.", dur("sec"), 21600),
  "web.userAgent": d("Web user agent", "Identity sent to listing sites.", text, "feedhound/0.1 (+https://github.com/mqa8668/feedhound)"),
  "web.allowPrivateHosts": d("Allow private web hosts", "Lets web sources reach loopback and private network addresses; only for an offline demo.", toggle, false),

  "watch.parseRatePerMin": d("Watch parsing rate limit", "Highest number of plain-language watch descriptions parsed per minute.", num("perMin"), 20),
  "watch.suggestExcludePreset": d("Suggested exclusions list", "Built-in exclusion phrases (en, vi or none) proposed so buyers posing as sellers stay out of your results.", { kind: "select", options: ["en", "vi", "none"] }, "en"),
  "watch.suggestExcludeSell": d("Extra suggested exclusion words", "Your own phrases added to the built-in suggested exclusions.", { kind: "tags" }, []),



  "search.candidateLimit": d("Search candidate pool", "How many posts are considered before ranking a search.", num("posts"), 20000),
  "search.pageLimitMax": d("Results per page", "The largest page size a search may request.", num(), 100),
  "search.exportMaxRows": d("Export row limit", "The most rows a search export may contain.", num(), 10000),
  "search.recencyWeight": d("Recency weight", "How strongly newer posts are favoured in search ranking.", num(), 0.5),
  "search.recencyTauDays": d("Recency decay", "Age at which a post's recency boost has faded noticeably.", dur("days"), 7),
  "search.trgmMinLen": d("Shortest fuzzy search term", "Terms shorter than this use exact matching only.", num("chars"), 3),


  "sources.classify.minPosts": d("Posts needed to classify", "A source needs at least this many posts before it is classified.", num("posts"), 20),
  "sources.classify.windowDays": d("Classification window", "Only posts from this recent period are used to classify a source.", dur("days"), 30),
  "sources.classify.topicDepth": d("Topic detail level", "How deep in the topic tree a source's main topic is resolved.", num(), 2),
  "sources.classify.topicShareMin": d("Dominant topic share", "A topic must make up this share of posts to label the source.", ratio, 0.5),
  "sources.classify.regionMinPosts": d("Posts needed for a region", "A source needs at least this many posts before it is given a region.", num("posts"), 10),
  "sources.classify.regionShareMin": d("Dominant region share", "A region must make up this share of posts to label the source.", ratio, 0.6),
  "sources.classify.cron": d("Classification schedule", "Cron schedule for re-classifying sources.", cron, "15 */6 * * *"),

} satisfies Record<RegistryKey, Def>;

const INTERNAL_KEYS: ReadonlySet<string> = new Set(["bot.telegram.updateOffset"]);
const USER_KEYS: ReadonlySet<string> = new Set([
  "schedule.activeHours", "schedule.dailyCapPerSource", "schedule.visitEverySec", 
  "media.thumbs.enabled", "llm.model.cheap", "llm.model.strong", "llm.enrichAll", "llm.dailyTokenBudget", "llm.budgetAlertPct",
  "match.minScore", "insights.topicsMax", "insights.digest.hourLocal", "insights.spike.minVolume", "insights.spike.ratioMin",
  "feed.priceBands", "notify.quietHoursStart", "notify.quietHoursEnd", "notify.digest.defaultEveryMin", "notify.excerptChars",
  "notify.ops.chatId", "notify.ops.recipientEmail",
  "watch.suggestExcludePreset", "watch.suggestExcludeSell", "app.tz", "retention.postRevisionDays",
]);

const SECTION_PREFIXES: readonly [ConfigSectionId, readonly string[]][] = [
  ["collection", ["schedule.", "ingest.", "watchdog.", "media.", "web."]],
  ["analysis", ["llm.", "enrich.", "match."]],
  ["insights", ["analytics.", "insights.", "feed."]],
  ["notifications", ["notify.", "bot."]],
  ["watches", ["sources.", "watch.", "search."]],
  ["system", ["app.", "retention.", "ops."]],
];

function sectionOf(key: string): ConfigSectionId {
  for (const [id, prefixes] of SECTION_PREFIXES) if (prefixes.some((p) => key.startsWith(p))) return id;
  return "system";
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function baseSchema(key: RegistryKey): z.ZodType {
  return key in REGISTRY_ONLY_SCHEMAS ? REGISTRY_ONLY_SCHEMAS[key as keyof typeof REGISTRY_ONLY_SCHEMAS] : configSchemas[key as ConfigKey];
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function refine(base: z.ZodType, control: ConfigControl): z.ZodType {
  switch (control.kind) {
    case "time":
      return base.refine((v) => typeof v === "string" && TIME_RE.test(v), { message: "Use 24-hour HH:MM" });
    case "timeWindow":
      return base.refine(
        (v) => {
          const w = v as { start?: unknown; end?: unknown };
          return typeof w.start === "string" && typeof w.end === "string" && TIME_RE.test(w.start) && TIME_RE.test(w.end);
        },
        { message: "Use 24-hour HH:MM for start and end" },
      );
    case "range":
      return base.refine(
        (v) => {
          const r = v as { min: number; max: number };
          return r.min >= 0 && r.min <= r.max;
        },
        { message: "Minimum must be 0 or more and not above the maximum" },
      );
    case "cron":
      return base.refine((v) => typeof v === "string" && v.trim().split(/\s+/).length === 5, { message: "Use a 5-field cron expression" });
    case "select": {
      const options = control.options;
      if (options === "timezones") return base.refine((v) => typeof v === "string" && isValidTimezone(v), { message: "Unknown timezone" });
      return base.refine((v) => typeof v === "string" && options.includes(v), { message: "Pick one of the listed options" });
    }
    default:
      return base;
  }
}

function build(): { readonly [K in RegistryKey]: ConfigEntry } {
  const out: Record<string, ConfigEntry> = {};
  for (const key of Object.keys(DEFS) as RegistryKey[]) {
    const def: Def = DEFS[key];
    out[key] = {
      key,
      section: sectionOf(key),
      label: def.label,
      description: def.description,
      control: def.control,
      visibility: INTERNAL_KEYS.has(key) ? "internal" : USER_KEYS.has(key) ? "user" : "advanced",
      default: def.default,
      schema: refine(baseSchema(key), def.control),
    };
  }
  return out as { readonly [K in RegistryKey]: ConfigEntry };
}

export const configRegistry: { readonly [K in RegistryKey]: ConfigEntry } = build();

export type ConfigWriteResult =
  | { ok: true; value: unknown }
  | { ok: false; error: "unknown_key" | "internal_key" | "validation"; issues?: z.core.$ZodIssue[] };

export function validateConfigWrite(key: string, value: unknown): ConfigWriteResult {
  if (!Object.hasOwn(configRegistry, key)) return { ok: false, error: "unknown_key" };
  const entry = configRegistry[key as RegistryKey];
  if (entry.visibility === "internal") return { ok: false, error: "internal_key" };
  const parsed = entry.schema.safeParse(value);
  if (!parsed.success) return { ok: false, error: "validation", issues: parsed.error.issues };
  return { ok: true, value: parsed.data };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  return ak.length === Object.keys(bo).length && ak.every((k) => Object.hasOwn(bo, k) && deepEqual(ao[k], bo[k]));
}

export function isDefaultValue(key: RegistryKey, value: unknown): boolean {
  return deepEqual(configRegistry[key].default, value);
}

const UNIT_MS: Record<DurationUnit, number> = { ms: 1, sec: 1000, min: 60_000, hours: 3_600_000, days: 86_400_000 };

/** `2700,"sec"` -> "45 min"; `90,"days"` -> "90 days". Picks the largest unit that divides evenly. */
export function humanizeDuration(value: number, unit: DurationUnit): string {
  const ms = Math.round(value * UNIT_MS[unit]);
  const fmt = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
  if (ms !== 0 && ms % UNIT_MS.days === 0) return fmt(ms / UNIT_MS.days, "day", "days");
  if (ms !== 0 && ms % UNIT_MS.hours === 0) return fmt(ms / UNIT_MS.hours, "hour", "hours");
  if (ms !== 0 && ms % UNIT_MS.min === 0) return fmt(ms / UNIT_MS.min, "min", "min");
  if (ms >= 1000) return fmt(Number((ms / 1000).toFixed(2)), "sec", "sec");
  return fmt(ms, "ms", "ms");
}

export function visibleEntries(): ConfigEntry[] {
  return Object.values(configRegistry).filter((e) => e.visibility !== "internal");
}
