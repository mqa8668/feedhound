import { randomUUID } from "node:crypto";
import { ingestPosts } from "@feedhound/api/corpus";
import { configSchemas } from "@feedhound/core/config-schema";
import { createLogger } from "@feedhound/core/logger";
import { serverRawPostSchema, type ServerRawPost } from "@feedhound/core/sources";
import { schema, type DbHandle } from "@feedhound/db";
import { desc, inArray, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { createWebFetcher } from "../web/fetcher";
import { CONNECTORS, connectorFor } from "../web/registry";
import { WebFetchError, WebHttpError, WebParseError, type HttpValidators, type MapCtx, type SiteConnector, type WebHttp } from "../web/types";

const logger = createLogger({ service: "agent" });

export const WEB_POLL_QUEUE = "web_poll";
export const WEB_POLL_CRON = "*/5 * * * *";
/**
 * A run stops starting work once this budget (minus a worst-case request allowance) is spent,
 * and the queue job expires well after it, so the exclusive policy can never see two live runs.
 */
const RUN_BUDGET_MS = 480_000;
const WEB_POLL_EXPIRE_SEC = 900;
const REQUEST_TIMEOUT_MS = 15_000;

export interface WebConfig {
  enabled: boolean;
  pollIntervalSec: number;
  maxSourcesPerRun: number;
  maxPagesPerRun: number;
  pageSize: number;
  minRequestGapMs: number;
  backoffBaseSec: number;
  backoffMaxSec: number;
  userAgent: string;
  allowPrivateHosts: boolean;
}

const CONFIG_DEFAULTS: WebConfig = {
  enabled: false,
  pollIntervalSec: 600,
  maxSourcesPerRun: 5,
  maxPagesPerRun: 3,
  pageSize: 50,
  minRequestGapMs: 5000,
  backoffBaseSec: 300,
  backoffMaxSec: 21600,
  userAgent: "feedhound/0.1 (+https://github.com/mqa8668/feedhound)",
  allowPrivateHosts: false,
};

const CONFIG_KEYS = [
  "web.enabled", "web.pollIntervalSec", "web.maxSourcesPerRun", "web.maxPagesPerRun", "web.pageSize",
  "web.minRequestGapMs", "web.backoffBaseSec", "web.backoffMaxSec", "web.userAgent", "web.allowPrivateHosts",
] as const;

async function readWebConfig(handle: DbHandle): Promise<WebConfig> {
  const rows = await handle.db
    .selectDistinctOn([schema.config.key], { key: schema.config.key, value: schema.config.value })
    .from(schema.config)
    .where(inArray(schema.config.key, [...CONFIG_KEYS]))
    .orderBy(schema.config.key, desc(schema.config.version));
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const pick = <K extends (typeof CONFIG_KEYS)[number]>(key: K, fallback: unknown): unknown => {
    const raw = byKey.get(key);
    const parsed = configSchemas[key].safeParse(raw);
    if (parsed.success) return parsed.data;
    if (raw !== undefined) logger.warn({ key, value: raw }, "web_poll: invalid config value, using default");
    return fallback;
  };
  const d = CONFIG_DEFAULTS;
  return {
    enabled: pick("web.enabled", d.enabled) as boolean,
    pollIntervalSec: pick("web.pollIntervalSec", d.pollIntervalSec) as number,
    maxSourcesPerRun: pick("web.maxSourcesPerRun", d.maxSourcesPerRun) as number,
    maxPagesPerRun: pick("web.maxPagesPerRun", d.maxPagesPerRun) as number,
    pageSize: pick("web.pageSize", d.pageSize) as number,
    minRequestGapMs: pick("web.minRequestGapMs", d.minRequestGapMs) as number,
    backoffBaseSec: pick("web.backoffBaseSec", d.backoffBaseSec) as number,
    backoffMaxSec: pick("web.backoffMaxSec", d.backoffMaxSec) as number,
    userAgent: pick("web.userAgent", d.userAgent) as string,
    allowPrivateHosts: pick("web.allowPrivateHosts", d.allowPrivateHosts) as boolean,
  };
}

export interface WebPollDeps {
  handle: DbHandle;
  boss: PgBoss | undefined;
  http?: WebHttp;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Tests only: replaces individual Config values (bypasses the Config bounds, e.g. pageSize 3). */
  configOverride?: Partial<WebConfig>;
}

type Outcome = "ok" | "error" | "blocked" | "timeout";

interface SourceRun {
  outcome: Outcome;
  reason: string | null;
  retryAfterSec: number | null;
  postsSeen: number;
  postsNew: number;
  pages: number;
  reachedKnownTail: boolean;
  /** Set when the connector reported validators (null clears the stored ones). */
  validators?: HttpValidators | null;
}

interface HealthState {
  ok?: boolean;
  failures?: number;
  backoffUntil?: string;
}

const sharedFetchers = new Map<string, WebHttp>();
/** Refreshed at the start of every run; read by the shared fetchers at request time. */
let dynamicHosts: readonly string[] = [];
let privateHostsAllowed = false;

/** Hosts of active feed sources: a feed's own url host is allowed in addition to the static connector hosts. */
async function activeFeedHosts(handle: DbHandle): Promise<string[]> {
  const rows = await handle.db
    .select({ url: schema.source.url })
    .from(schema.source)
    .where(sql`${schema.source.kind} = 'web' and ${schema.source.status} = 'active' and ${schema.source.platformId} like 'feed:%'`);
  const hosts = new Set<string>();
  for (const r of rows) {
    try {
      hosts.add(new URL(r.url).hostname.toLowerCase());
    } catch {
      // unparsable stored url: its poll fails with invalid_url
    }
  }
  return [...hosts];
}

/** Validators stored in `source.schedule.httpValidators` (the `schedule` column was otherwise unused for web sources). */
function readValidators(schedule: unknown): HttpValidators | null {
  const v = (schedule as { httpValidators?: { etag?: unknown; lastModified?: unknown } } | null)?.httpValidators;
  if (!v) return null;
  const etag = typeof v.etag === "string" ? v.etag : null;
  const lastModified = typeof v.lastModified === "string" ? v.lastModified : null;
  return etag || lastModified ? { etag, lastModified } : null;
}

/** One long-lived fetcher per UA/gap so robots.txt is cached across runs. */
function sharedFetcher(cfg: WebConfig, sleep: ((ms: number) => Promise<void>) | undefined): WebHttp {
  const key = `${cfg.userAgent}|${cfg.minRequestGapMs}`;
  let f = sharedFetchers.get(key);
  if (!f) {
    const staticHosts = [...CONNECTORS.values()].flatMap((c) => c.hosts);
    f = createWebFetcher({
      hosts: () => [...staticHosts, ...dynamicHosts],
      allowPrivateHosts: () => privateHostsAllowed,
      userAgent: cfg.userAgent,
      minRequestGapMs: cfg.minRequestGapMs,
      ...(sleep ? { sleep } : {}),
    });
    sharedFetchers.set(key, f);
  }
  return f;
}

/** How a failure maps onto a visit outcome + reason. */
function classify(err: unknown): { outcome: Outcome; reason: string; retryAfterSec: number | null } {
  if (err instanceof WebHttpError) {
    return { outcome: err.status === 403 ? "blocked" : "error", reason: `http_${err.status}`, retryAfterSec: err.retryAfterSec };
  }
  if (err instanceof WebParseError) return { outcome: "error", reason: "parse", retryAfterSec: null };
  if (err instanceof WebFetchError) {
    if (err.kind === "robots") return { outcome: "blocked", reason: "robots", retryAfterSec: null };
    if (err.kind === "timeout") return { outcome: "timeout", reason: "timeout", retryAfterSec: null };
    return { outcome: "error", reason: err.kind, retryAfterSec: null };
  }
  logger.error({ err }, "web_poll: unexpected source failure");
  return { outcome: "error", reason: "error", retryAfterSec: null };
}

/** Worst case for the next page: robots.txt + list request, each preceded by the per-host gap. */
function hasBudget(now: () => Date, cfg: WebConfig, deadline: number): boolean {
  return now().getTime() + 2 * (cfg.minRequestGapMs + REQUEST_TIMEOUT_MS) <= deadline;
}

async function runSource(
  deps: { handle: DbHandle; boss: PgBoss | undefined; http: WebHttp; now: () => Date },
  cfg: WebConfig,
  source: { id: string; url: string; platformId: string; schedule: unknown },
  connector: SiteConnector,
  deadline: number,
): Promise<SourceRun> {
  const run: SourceRun = { outcome: "ok", reason: null, retryAfterSec: null, postsSeen: 0, postsNew: 0, pages: 0, reachedKnownTail: false };
  const ctx: MapCtx = {
    capturedAt: deps.now(),
    sourceUrl: source.url,
  };
  try {
    let cursor: string | null = null;
    for (let page = 0; page < cfg.maxPagesPerRun; page++) {
      if (page > 0 && !hasBudget(deps.now, cfg, deadline)) break;
      const res = await connector.list(deps.http, source.url, cursor, cfg.pageSize, page === 0 ? { validators: readValidators(source.schedule) } : undefined);
      run.pages++;
      if (res.validators !== undefined) run.validators = res.validators;
      if (res.notModified) {
        run.reachedKnownTail = true;
        break;
      }
      const mapped: ServerRawPost[] = [];
      let invalid = 0;
      for (const item of res.items) {
        const post = connector.map(item, ctx);
        if (!post) continue;
        const checked = serverRawPostSchema.safeParse(post);
        if (checked.success) mapped.push(checked.data);
        else invalid++;
      }
      if (invalid > 0) logger.warn({ sourceId: source.id, invalid }, "web_poll: dropped mapped posts that failed validation");
      run.postsSeen += mapped.length;
      const ingested = await ingestPosts(deps.handle, deps.boss, source.id, mapped);
      run.postsNew += ingested.accepted;
      if (ingested.accepted === 0) {
        run.reachedKnownTail = true;
        break;
      }
      if (res.next === null) break;
      cursor = res.next;
    }
  } catch (err) {
    Object.assign(run, classify(err));
  }
  return run;
}

/** Poll due `web` sources, ingest as `capture = 'api'`, write one visit per source. */
export async function runWebPoll(deps: WebPollDeps): Promise<{ sources: number }> {
  const { handle, boss } = deps;
  const now = deps.now ?? ((): Date => new Date());
  const cfg = { ...(await readWebConfig(handle)), ...deps.configOverride };
  if (!cfg.enabled) return { sources: 0 };

  const t0 = now();
  const due = await handle.db
    .select({
      id: schema.source.id,
      url: schema.source.url,
      platformId: schema.source.platformId,
      schedule: schema.source.schedule,
      health: schema.source.health,
    })
    .from(schema.source)
    .where(
      sql`${schema.source.kind} = 'web' and ${schema.source.status} = 'active'
        and (${schema.source.health}->>'backoffUntil' is null or (${schema.source.health}->>'backoffUntil')::timestamptz <= ${t0.toISOString()}::timestamptz)
        and (${schema.source.lastOkVisitAt} is null
          or ${schema.source.lastOkVisitAt} <= ${t0.toISOString()}::timestamptz - make_interval(secs => coalesce(${schema.source.expectedIntervalSec}, ${cfg.pollIntervalSec}::int)))`,
    )
    .orderBy(sql`${schema.source.lastOkVisitAt} asc nulls first`)
    .limit(cfg.maxSourcesPerRun);
  if (due.length === 0) return { sources: 0 };

  dynamicHosts = await activeFeedHosts(handle);
  privateHostsAllowed = cfg.allowPrivateHosts;
  const http = deps.http ?? sharedFetcher(cfg, deps.sleep);

  const deadline = t0.getTime() + RUN_BUDGET_MS;
  const failed = (reason: string): SourceRun => ({ outcome: "error", reason, retryAfterSec: null, postsSeen: 0, postsNew: 0, pages: 0, reachedKnownTail: false });
  let handled = 0;
  for (const source of due) {
    // Out of time budget: the remaining sources stay due and are picked up by the next run.
    if (handled > 0 && !hasBudget(now, cfg, deadline)) break;
    handled++;
    const startedAt = now();
    const connector = connectorFor(source.platformId);
    // Re-validate the stored url at poll time: the fetch target must still be what the connector accepts.
    const urlCheck = connector?.parseSourceUrl(source.url);
    const run: SourceRun = !connector
      ? failed("unknown_connector")
      : !urlCheck?.ok || urlCheck.url !== source.url
        ? failed("invalid_url")
        : await runSource({ handle, boss, http, now }, cfg, source, connector, deadline);
    const finishedAt = now();

    await handle.db.insert(schema.visit).values({
      id: randomUUID(),
      sourceId: source.id,
      startedAt,
      finishedAt,
      outcome: run.outcome,
      mode: "normal",
      postsSeen: run.postsSeen,
      postsNew: run.postsNew,
      pages: run.pages,
      reachedKnownTail: run.reachedKnownTail,
      reason: run.reason,
    });

    const prev = (source.health ?? {}) as HealthState;
    const patch: Partial<typeof schema.source.$inferInsert> = { lastHealthAt: finishedAt };
    if (run.postsNew > 0) patch.lastIngestAt = finishedAt;
    if (run.outcome === "ok") {
      patch.lastOkVisitAt = finishedAt;
      patch.health = { ok: true };
      if (run.validators !== undefined) {
        const restSchedule = { ...((source.schedule ?? {}) as Record<string, unknown>) };
        delete restSchedule.httpValidators;
        patch.schedule = run.validators ? { ...restSchedule, httpValidators: run.validators } : restSchedule;
      }
    } else {
      const failures = (prev.ok === false && typeof prev.failures === "number" ? prev.failures : 0) + 1;
      const backoffSec = Math.min(Math.max(cfg.backoffBaseSec * 2 ** Math.min(failures - 1, 30), run.retryAfterSec ?? 0), cfg.backoffMaxSec);
      patch.health = { ok: false, reason: run.reason, failures, backoffUntil: new Date(finishedAt.getTime() + backoffSec * 1000).toISOString() };
      logger.warn({ sourceId: source.id, outcome: run.outcome, reason: run.reason, failures }, "web_poll: source failed");
    }
    await handle.db.update(schema.source).set(patch).where(sql`${schema.source.id} = ${source.id}::uuid`);
  }
  return { sources: handled };
}

export async function registerWebPollJob(boss: PgBoss, handle: DbHandle): Promise<void> {
  // Exclusive policy: no overlapping runs; expiry (900 s) is well above the run's own time budget (480 s).
  await boss.createQueue(WEB_POLL_QUEUE, { expireInSeconds: WEB_POLL_EXPIRE_SEC, policy: "exclusive" });
  await boss.schedule(WEB_POLL_QUEUE, WEB_POLL_CRON, {});
  await boss.work(WEB_POLL_QUEUE, async () => {
    await runWebPoll({ handle, boss });
  });
}
