import { createDb, schema, type DbHandle } from "@feedhound/db";
import { createLogger } from "@feedhound/core/logger";
import { appVersion } from "@feedhound/core/version";
import { runReadiness } from "@feedhound/core/health";
import { bootDelaysFromEnv, bootWithRetry, installShutdownHandlers, isShuttingDown, onShutdown } from "@feedhound/core/shutdown";
import { buildNotifierMap } from "@feedhound/bot/notifiers";
import { createBudget, type Budget } from "@feedhound/llm/budget";
import { createLlmClient } from "@feedhound/llm/client";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { PgBoss } from "pg-boss";
import { agentMetricsApp, createAgentMetrics } from "./metrics";
import { RateLimiter } from "./lib/rate-limit";
import { AliasCache } from "./services/alias-cache";
import { applyDeadLetters, registerDlqMonitorJob } from "./jobs/dlq";
import { registerAttributesBackfillJob } from "./jobs/attributes-backfill";
import { registerWebPollJob } from "./jobs/web-poll";
import { registerReconcileJob } from "./jobs/reconcile";
import { fetchOpsUserIdDefault, registerEnrichJob, registerInsightBackfillJob, type EnrichConfig } from "./jobs/enrich";
import { registerMatchJob } from "./jobs/match";
import { registerNotifyDigestJob } from "./jobs/notify-digest";
import { registerNotifyHealthJob } from "./jobs/notify-health";
import { registerRetentionJob } from "./jobs/retention";
import { registerThumbJob } from "./jobs/thumbs";
import { registerInsightDigestJob } from "./jobs/insight-digest";
import { registerTopicRollupJob } from "./jobs/topic-rollup";
import { registerTrendCurateJob } from "./jobs/trend-curate";
import { registerRollup } from "./jobs/rollup";
import { registerSourceClassifyJob } from "./jobs/source-classify";
import { fetchRateLimitOptions, registerNotifyJob } from "./jobs/notify";
import { registerNotifyOpsJob } from "./jobs/notify-ops";
import { registerOpsAlertsJob } from "./jobs/ops-alerts";
import { registerWatchdogJob } from "./jobs/watchdog";
import { WatchIndex } from "./watch-index";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";


const logger = createLogger({ service: "agent" });
/** A relative MEDIA_DIR resolves against the repo root, not the per-app dev cwd (agent writes, api reads). */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

async function fetchConfigNumber(handle: DbHandle, key: string, fallback: number): Promise<number> {
  const [row] = await handle.db
    .select({ value: schema.config.value })
    .from(schema.config)
    .where(eq(schema.config.key, key))
    .orderBy(desc(schema.config.version))
    .limit(1);
  return typeof row?.value === "number" ? row.value : fallback;
}

async function fetchConfigBool(handle: DbHandle, key: string, fallback: boolean): Promise<boolean> {
  const [row] = await handle.db
    .select({ value: schema.config.value })
    .from(schema.config)
    .where(eq(schema.config.key, key))
    .orderBy(desc(schema.config.version))
    .limit(1);
  return typeof row?.value === "boolean" ? row.value : fallback;
}

async function fetchConfigString(handle: DbHandle, key: string, fallback: string): Promise<string> {
  const [row] = await handle.db
    .select({ value: schema.config.value })
    .from(schema.config)
    .where(eq(schema.config.key, key))
    .orderBy(desc(schema.config.version))
    .limit(1);
  return typeof row?.value === "string" ? row.value : fallback;
}

/** Live `EnrichConfig` from the Config table (behaviour rules 3-6). */
async function fetchEnrichConfig(handle: DbHandle): Promise<EnrichConfig> {
  return {
    ruleConfidenceMin: await fetchConfigNumber(handle, "enrich.ruleConfidenceMin", 0.7),
    llmConfidenceMin: await fetchConfigNumber(handle, "enrich.llmConfidenceMin", 0.5),
    enrichAll: await fetchConfigBool(handle, "llm.enrichAll", false),
    modelCheap: await fetchConfigString(handle, "llm.model.cheap", ""),
    modelStrong: await fetchConfigString(handle, "llm.model.strong", ""),
    dealWindowDays: await fetchConfigNumber(handle, "deal.windowDays", 30),
    dealMinPeers: await fetchConfigNumber(handle, "deal.minPeers", 5),
    trendMaxTerms: await fetchConfigNumber(handle, "analytics.trend.maxTermsPerPost", 5),
  };
}

/** Queues whose completed jobs are purged after 1 d (minute-cadence noise). */
export const BOSS_NOISY_QUEUES = [
  "__pgboss__send-it",
  "watchdog",
  "notify_sweep",
  "notify_digest",
  "notify_ops_flush",
  "thumb_sweep",
  "ops_alerts",
  "dlq_monitor",
  "notify_health",
] as const;
export const BOSS_NOISY_DELETE_AFTER_S = 86_400; // 1 d
export const BOSS_DEFAULT_DELETE_AFTER_S = 604_800; // 7 d

/** Explicit completed-job retention on every queue; one failing update never stops boot. */
export async function applyQueueRetention(boss: Pick<PgBoss, "getQueues" | "updateQueue">): Promise<void> {
  const noisy: readonly string[] = BOSS_NOISY_QUEUES;
  const queues = await boss.getQueues();
  for (const queue of queues) {
    const deleteAfterSeconds = noisy.includes(queue.name) ? BOSS_NOISY_DELETE_AFTER_S : BOSS_DEFAULT_DELETE_AFTER_S;
    try {
      await boss.updateQueue(queue.name, { deleteAfterSeconds });
    } catch (err) {
      logger.warn({ err, queue: queue.name }, "queue retention update failed");
    }
  }
}

async function checkDb(handle: DbHandle): Promise<boolean> {
  try {
    await handle.sql`select 1`;
    return true;
  } catch {
    return false;
  }
}

/** pg-boss schema from `PGBOSS_SCHEMA` (default `pgboss`); throws on an unsafe identifier. */
export function bossSchemaFromEnv(env: Record<string, string | undefined> = process.env): string {
  const v = env.PGBOSS_SCHEMA;
  if (v === undefined || v === "") return "pgboss";
  if (!/^[a-z_][a-z0-9_]*$/.test(v)) throw new Error(`invalid PGBOSS_SCHEMA: ${v}`);
  return v;
}

/** `SHUTDOWN_TIMEOUT_MS` override (positive integer) of the configured shutdown timeout; undefined when unset/invalid. */
export function shutdownTimeoutFromEnv(env: Record<string, string | undefined> = process.env): number | undefined {
  const n = Number(env.SHUTDOWN_TIMEOUT_MS);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

async function checkQueue(handle: DbHandle, bossSchema: string): Promise<boolean> {
  try {
    await handle.sql`select 1 from ${handle.sql(bossSchema)}.job limit 1`;
    return true;
  } catch {
    return false;
  }
}

export interface MainOptions {
  bossFactory?: (url: string) => PgBoss;
  /** Runs after the last `register*` call, before dead-letter wiring. */
  registerExtra?: (boss: PgBoss) => Promise<void>;
}

/**
 * Boots the agent process: the health server starts
 * first (so `/healthz` answers while `/readyz` is 503 during boot), then
 * `bootBoss` is retried with backoff. A fresh `PgBoss` is created per
 * attempt; an attempt either completes every registration or is retried
 * from `boss.start()` — no step is skipped. The last failure logs fatal and
 * exits the process so `docker compose restart: unless-stopped` retries the
 * whole boot. No side effects run at module top level: everything lives
 * inside this function, called once from `if (import.meta.main)` below.
 */
export async function main(opts: MainOptions = {}): Promise<void> {
  // Read lazily (not a module-top-level const) so a caller can set
  // `AGENT_PORT`/`DATABASE_URL` per call in the same process (the in-process
  // `main({ bossFactory })` test).
  const PORT = Number(process.env.AGENT_PORT ?? 4821);
  const bossSchema = bossSchemaFromEnv();
  const handle = createDb();

  // One in-memory WatchIndex per agent process; the `match` job
  // always reads it and never queries the Watch table itself.
  const watchIndex = new WatchIndex({ handle });
  // Alias dict for the `enrich` job (Category + CatalogItem).
  const aliasCache = new AliasCache({ handle });

  let bossStarted = false;
  let workersReady = false;
  // watchIndex/aliasCache each `.start()` at most once per
  // process — a retried boot attempt must not re-subscribe a second
  // listener alongside the first.
  let watchIndexStarted = false;
  let aliasCacheStarted = false;

  const app = new Hono();
  app.get("/healthz", (c) => c.json({ ok: true, service: "agent", version: appVersion() }));
  app.get("/readyz", async (c) => {
    const result = await runReadiness({
      db: () => checkDb(handle),
      boss: () => bossStarted,
      queue: () => checkQueue(handle, bossSchema),
      workers: () => workersReady,
      accepting: () => !isShuttingDown(),
    });
    return c.json({ ok: result.ok, service: "agent", version: appVersion(), checks: result.checks }, result.ok ? 200 : 503);
  });

  // `/metrics` on the same health server; the budget is built later in boot, so read it through a holder.
  const budgetHolder: { current?: Budget } = {};
  const metricsRegistry = createAgentMetrics({
    handle,
    budget: { getUsageToday: async () => budgetHolder.current?.getUsageToday() },
  });
  app.route("/", agentMetricsApp(metricsRegistry));

  const server = Bun.serve({ port: PORT, fetch: app.fetch });
  logger.info({ port: PORT, version: appVersion() }, "agent listening");

  let currentAttemptBoss: PgBoss | undefined;

  async function bootBossOnce(): Promise<PgBoss> {
    bossStarted = false;
    workersReady = false;
    const factory = opts.bossFactory ?? ((url: string) => new PgBoss({ connectionString: url, schema: bossSchema }));
    const boss = factory(process.env.DATABASE_URL ?? "");
    currentAttemptBoss = boss;
    boss.on("error", (err: Error) => logger.error({ err }, "pg-boss error"));
    await boss.start();
    bossStarted = true;
    logger.info("pg-boss started");

    await registerWatchdogJob(boss, handle);
    logger.info("watchdog job registered");
    await registerOpsAlertsJob(boss, handle);
    logger.info("ops_alerts job registered");

    if (!watchIndexStarted) {
      await watchIndex.start();
      watchIndexStarted = true;
    }
    logger.info({ version: watchIndex.version }, "watch index started");
    await registerMatchJob(boss, handle, watchIndex);
    logger.info("match job registered");

    // Enrichment. LLM_BASE_URL/LLM_API_KEY missing -> llmClient/budget
    // stay undefined, and `enrich` always writes the rule-engine result
    // ("llm_disabled" path, behaviour rules 5 + test plan "no live network").
    if (!aliasCacheStarted) {
      aliasCache.setRefreshSec(await fetchConfigNumber(handle, "enrich.aliasRefreshSec", 600));
      await aliasCache.start();
      aliasCacheStarted = true;
    }
    logger.info("alias cache started");
    const llmBaseUrl = process.env.LLM_BASE_URL;
    const llmApiKey = process.env.LLM_API_KEY;
    const llmClient =
      llmBaseUrl && llmApiKey
        ? createLlmClient({
            baseUrl: llmBaseUrl,
            apiKey: llmApiKey,
            timeoutMs: await fetchConfigNumber(handle, "llm.timeoutMs", 30000),
            maxRetries: await fetchConfigNumber(handle, "llm.maxRetries", 2),
          })
        : undefined;
    const budget = llmClient
      ? createBudget({
          handle,
          tz: await fetchConfigString(handle, "app.tz", "Asia/Ho_Chi_Minh"),
          dailyTokenBudget: await fetchConfigNumber(handle, "llm.dailyTokenBudget", 2_000_000),
          budgetAlertPct: await fetchConfigNumber(handle, "llm.budgetAlertPct", 80),
        })
      : undefined;
    budgetHolder.current = budget;
    await registerEnrichJob({
      boss,
      handle,
      catalogueSnapshot: () => ({ dict: aliasCache.get(), categories: aliasCache.getCategories(), items: aliasCache.getItems(), attrs: aliasCache.getAttrs() }),
      llmClient,
      budget,
      fetchConfig: () => fetchEnrichConfig(handle),
      fetchOpsUserId: () => fetchOpsUserIdDefault(handle),
    });
    logger.info({ llmEnabled: Boolean(llmClient) }, "enrich job registered");
    // 7-day sentiment / intent-tag backfill (enqueues normal enrich jobs; no LLM call of its own).
    await registerInsightBackfillJob({
      boss,
      handle,
      budget: () => budgetHolder.current,
      bossSchema,
      fetchConfig: async () => ({
        backfillDays: await fetchConfigNumber(handle, "insights.backfillDays", 7),
        maxPerRun: await fetchConfigNumber(handle, "insights.backfillMaxPerRun", 500),
      }),
    });
    // Hourly bounded LLM curation of trending terms (cheap model; budget + 429 breaker + daily token cap).
    await registerTrendCurateJob({
      boss,
      handle,
      llmClient,
      budget: () => budgetHolder.current,
      fetchConfig: async () => ({
        enabled: await fetchConfigBool(handle, "analytics.trend.curate.enabled", true),
        maxCandidates: await fetchConfigNumber(handle, "analytics.trend.curate.maxCandidates", 50),
        dailyTokenCap: await fetchConfigNumber(handle, "analytics.trend.curate.dailyTokenCap", 30000),
        modelCheap: await fetchConfigString(handle, "llm.model.cheap", ""),
        modelStrong: await fetchConfigString(handle, "llm.model.strong", ""),
        tz: await fetchConfigString(handle, "app.tz", "Asia/Ho_Chi_Minh"),
      }),
    });
    logger.info("trend_curate job registered");
    // Regex + price-bound repair of pre-026 enrichment rows (no LLM, no match/notify jobs).
    await registerAttributesBackfillJob({
      boss,
      handle,
      catalogueSnapshot: () => ({ dict: aliasCache.get(), categories: aliasCache.getCategories(), items: aliasCache.getItems(), attrs: aliasCache.getAttrs() }),
      fetchConfig: async () => ({
        batch: await fetchConfigNumber(handle, "attributes.backfillBatch", 500),
        maxPerRun: await fetchConfigNumber(handle, "attributes.backfillMaxPerRun", 20000),
        dealWindowDays: await fetchConfigNumber(handle, "deal.windowDays", 30),
        dealMinPeers: await fetchConfigNumber(handle, "deal.minPeers", 5),
    trendMaxTerms: await fetchConfigNumber(handle, "analytics.trend.maxTermsPerPost", 5),
      }),
    });
    logger.info("attributes_backfill job registered");
    // Replaces the old backfill cron; registered before applyDeadLetters so `reconcile_dlq` exists.
    await registerReconcileJob(boss, handle, bossSchema);
    logger.info("reconcile job registered");

    // TG_BOT_TOKEN missing -> telegram notifier omitted from the
    // map . The process
    // itself does not exit on a missing token here — only apps/bot (the
    // long-polling process, which actually needs a live token to function)
    // does that; the agent can still run match/ingest without Telegram.
    const notifiers = buildNotifierMap({ botToken: process.env.TG_BOT_TOKEN, apiBase: process.env.TG_API_BASE });
    // one shared RateLimiter instance (limits from `notify.rateLimit.*`) is passed
    // into every send path (notify/notify_digest/notify_ops) — two independent limiters
    // each enforcing "1/s per chat" would together allow up to 2 msg/s to the same chat.
    const rateLimiter = new RateLimiter(await fetchRateLimitOptions(handle));
    await registerNotifyJob(boss, handle, notifiers, rateLimiter);
    logger.info("notify job registered");
    await registerNotifyDigestJob(boss, handle, notifiers, rateLimiter);
    // Topic rollup/spikes + daily digest share the notify notifier map and rate limiter.
    await registerTopicRollupJob(boss, handle, notifiers, rateLimiter);
    await registerInsightDigestJob(boss, handle, notifiers, rateLimiter);
    logger.info("notify_digest job registered");
    await registerNotifyOpsJob(boss, handle, notifiers, rateLimiter);
    logger.info("notify_ops job registered");
    await registerNotifyHealthJob(boss, handle);
    logger.info("notify_health job registered");
    // The agent's pg-boss cron is the only retention path.
    await registerRetentionJob(boss, handle);
    logger.info("retention job registered");
    // Server-side thumbnail cache (allow-listed hosts only, no cookies).
    await registerThumbJob(boss, handle, resolve(REPO_ROOT, process.env.MEDIA_DIR ?? "./data/media"));
    logger.info("thumb_sweep job registered");
    // Server-side web polling; a no-op every 5 min until Config web.enabled is true.
    await registerWebPollJob(boss, handle);
    logger.info("web_poll job registered");
    await registerRollup(boss, handle);
    logger.info("rollup job registered");
    // Platform -> topic -> region auto-classification of sources.
    await registerSourceClassifyJob(boss, handle);
    logger.info("source_classify job registered");

    if (opts.registerExtra) await opts.registerExtra(boss);

    // register `dlq_monitor` (and its queue) before wiring dead
    // letters, so it gets its own DLQ on this boot instead of only the next
    // one.
    await registerDlqMonitorJob(boss, handle);
    logger.info("dlq_monitor job registered");

    // dead-letter every queue registered above (and any api
    // created first, e.g. match/enrich via apps/api/src/services/corpus.ts).
    await applyDeadLetters(boss);
    await applyQueueRetention(boss);
    logger.info("queue retention applied");

    workersReady = true;
    return boss;
  }

  let boss: PgBoss;
  try {
    boss = await bootWithRetry(() => bootBossOnce(), {
      delaysMs: bootDelaysFromEnv(),
      logger,
      onFail: async () => {
        await currentAttemptBoss?.stop({ graceful: false, close: true }).catch(() => {});
      },
    });
  } catch (err) {
    logger.fatal({ err }, "pg-boss failed to start after all boot retries; exiting so the process supervisor restarts the service");
    process.exit(1);
    return;
  }

  // never let a DB hiccup here skip registering shutdown handlers —
  // fall back to the default instead.
  let shutdownTimeoutMs = 30_000;
  try {
    shutdownTimeoutMs = shutdownTimeoutFromEnv() ?? (await fetchConfigNumber(handle, "ops.shutdownTimeoutMs", 30_000));
  } catch (err) {
    logger.warn({ err }, "failed to read ops.shutdownTimeoutMs; using default");
  }
  // boss (active jobs finish within the timeout; unfinished ones
  // stay `active` and are retried by pg-boss after `expireInSeconds`), then
  // http, then db.
  onShutdown("boss", () => boss.stop({ graceful: true, timeout: shutdownTimeoutMs, close: true }), { timeoutMs: shutdownTimeoutMs + 1_000 });
  onShutdown("http", () => server.stop(true));
  onShutdown("watchIndex", () => watchIndex.stop());
  onShutdown("aliasCache", () => aliasCache.stop());
  onShutdown("db", () => handle.close());
  installShutdownHandlers({ logger, hardDeadlineMs: shutdownTimeoutMs + 5_000 });
}

if (import.meta.main) await main();
