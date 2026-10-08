import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configSchemas } from "@feedhound/core/config-schema";
import { createLogger } from "@feedhound/core/logger";
import { schema, type DbHandle } from "@feedhound/db";
import { desc, inArray } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import sharp from "sharp";

const logger = createLogger({ service: "agent" });

/**
 * Server-side thumbnail cache. Fetches a post's first image from an allow-listed host
 * over HTTPS with no cookies or session, shrinks it to a 160-px webp and stores it under
 * `${MEDIA_DIR}/thumbs/<id[0:2]>/<id>.webp`. Terminal states (`none`, `expired`, `failed`, `purged`) are never retried.
 */
export const THUMB_QUEUE = "thumb_sweep";
export const THUMB_CRON = "* * * * *";
/** Live-feed channel: one NOTIFY per sweep with the posts that just got a thumbnail (relayed by apps/api/src/ws/live.ts). */
export const THUMB_READY_CHANNEL = "thumb_ready";
/** 100 uuids is about 4 KB of JSON, far below pg_notify's 8000-byte cap. */
export const THUMB_READY_MAX_IDS = 100;

const MAX_IN_FLIGHT = 2;
const MIN_START_GAP_MS = 250;
const MAX_REDIRECTS = 2;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MIN = 10;
const THUMB_WIDTH = 160;
const THUMB_QUALITY = 70;

export interface ThumbConfig {
  enabled: boolean;
  userAgent: string;
  batch: number;
  backfillDays: number;
  maxBytes: number;
  timeoutMs: number;
  allowedHosts: string[];
}

const CONFIG_DEFAULTS: ThumbConfig = {
  enabled: true,
  userAgent: "feedhound-thumbs/0.1 (+https://github.com/mqa8668/feedhound)",
  batch: 20,
  backfillDays: 7,
  maxBytes: 5_242_880,
  timeoutMs: 15_000,
  allowedHosts: [],
};

export async function readThumbConfig(handle: DbHandle): Promise<ThumbConfig> {
  const keys = ["media.thumbs.enabled", "media.thumbs.userAgent", "media.thumbs.batch", "media.thumbs.backfillDays", "media.thumbs.maxBytes", "media.thumbs.timeoutMs", "media.thumbs.allowedHosts"] as const;
  const rows = await handle.db
    .selectDistinctOn([schema.config.key], { key: schema.config.key, value: schema.config.value })
    .from(schema.config)
    .where(inArray(schema.config.key, [...keys]))
    .orderBy(schema.config.key, desc(schema.config.version));
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const pick = <K extends (typeof keys)[number]>(key: K): unknown => {
    const parsed = configSchemas[key].safeParse(byKey.get(key));
    return parsed.success ? parsed.data : undefined;
  };
  const enabled = pick("media.thumbs.enabled");
  const userAgent = pick("media.thumbs.userAgent");
  const batch = pick("media.thumbs.batch");
  const backfillDays = pick("media.thumbs.backfillDays");
  const maxBytes = pick("media.thumbs.maxBytes");
  const timeoutMs = pick("media.thumbs.timeoutMs");
  const hostsRaw = byKey.get("media.thumbs.allowedHosts");
  const hostsParsed = configSchemas["media.thumbs.allowedHosts"].safeParse(hostsRaw);
  if (!hostsParsed.success && hostsRaw !== undefined) logger.warn({ value: hostsRaw }, "thumbs: invalid media.thumbs.allowedHosts, using default");
  return {
    enabled: typeof enabled === "boolean" ? enabled : CONFIG_DEFAULTS.enabled,
    userAgent: typeof userAgent === "string" ? userAgent : CONFIG_DEFAULTS.userAgent,
    batch: typeof batch === "number" ? batch : CONFIG_DEFAULTS.batch,
    backfillDays: typeof backfillDays === "number" ? backfillDays : CONFIG_DEFAULTS.backfillDays,
    maxBytes: typeof maxBytes === "number" ? maxBytes : CONFIG_DEFAULTS.maxBytes,
    timeoutMs: typeof timeoutMs === "number" ? timeoutMs : CONFIG_DEFAULTS.timeoutMs,
    allowedHosts: hostsParsed.success ? hostsParsed.data : CONFIG_DEFAULTS.allowedHosts,
  };
}

/** Where a post's thumbnail lives. The id must already be a parsed uuid. */
export function thumbPath(mediaDir: string, postId: string): string {
  return join(mediaDir, "thumbs", postId.slice(0, 2), `${postId}.webp`);
}

const MAX_INPUT_PIXELS = 40e6;
const ALLOWED_FORMATS: ReadonlySet<string> = new Set(["jpeg", "png", "webp", "gif"]);
/** A sweep stops starting new work after this long; the next cron tick continues. */
const SWEEP_BUDGET_MS = 240_000;

/** Resize to a 160-px-wide webp (no enlargement). Throws on undecodable input. */
export async function toThumb(buf: Buffer): Promise<Buffer> {
  const img = sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS });
  const { format } = await img.metadata(); // throws when the header claims more than the pixel limit
  if (format === undefined || !ALLOWED_FORMATS.has(format)) throw new Error(`unsupported image format: ${format ?? "unknown"}`);
  return img.rotate().resize({ width: THUMB_WIDTH, withoutEnlargement: true }).webp({ quality: THUMB_QUALITY }).toBuffer();
}

/** https, no port, and host equal to or a subdomain of an allowed host. */
function isAllowedUrl(raw: string, allowedHosts: readonly string[]): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.port !== "") return null;
  const host = u.hostname.toLowerCase();
  if (!allowedHosts.some((h) => host === h || host.endsWith(`.${h}`))) return null;
  return u;
}

function firstImageUrl(media: unknown): string | null {
  if (!Array.isArray(media)) return null;
  for (const m of media) {
    if (typeof m === "object" && m !== null) {
      const o = m as { type?: unknown; url?: unknown };
      if (o.type === "image" && typeof o.url === "string" && o.url !== "") return o.url;
    }
  }
  return null;
}

/** `oe` is the CDN expiry as hex unix seconds. */
function isExpired(u: URL, nowMs: number): boolean {
  const oe = u.searchParams.get("oe");
  if (oe === null || !/^[0-9a-f]{1,12}$/i.test(oe)) return false;
  return Number.parseInt(oe, 16) * 1000 < nowMs;
}

type FetchOutcome = { kind: "ok"; buf: Buffer } | { kind: "expired" } | { kind: "failed" } | { kind: "retry" };

export interface ThumbDeps {
  handle: DbHandle;
  mediaDir: string;
  fetch?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  toThumb?: (buf: Buffer) => Promise<Buffer>;
  config?: ThumbConfig;
  /** Wall-clock budget for one sweep (default 240 s). */
  budgetMs?: number;
}

export interface ThumbSweepResult {
  picked: number;
  ok: number;
  none: number;
  expired: number;
  failed: number;
  retry: number;
}

export async function runThumbSweep(deps: ThumbDeps): Promise<ThumbSweepResult> {
  const { handle, mediaDir } = deps;
  const doFetch = deps.fetch ?? fetch;
  const nowFn = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const shrink = deps.toThumb ?? toThumb;
  const cfg = deps.config ?? (await readThumbConfig(handle));
  const result: ThumbSweepResult = { picked: 0, ok: 0, none: 0, expired: 0, failed: 0, retry: 0 };
  if (!cfg.enabled) return result;

  const now = nowFn();
  const nowIso = now.toISOString();
  const sinceIso = new Date(now.getTime() - cfg.backfillDays * 86_400_000).toISOString();
  const rows = await handle.sql<{ id: string; media: unknown; thumb_attempts: number }[]>`
    select id, media, thumb_attempts from post
    where thumb_state is null
      and first_seen_at > ${sinceIso}::timestamptz
      and (thumb_checked_at is null
           or thumb_checked_at < ${nowIso}::timestamptz - make_interval(mins => ${BACKOFF_BASE_MIN}::int * power(2, thumb_attempts)::int))
    order by first_seen_at desc
    limit ${cfg.batch}`;
  result.picked = rows.length;

  // At most MAX_IN_FLIGHT requests, and at least MIN_START_GAP_MS between request starts.
  let nextStart = 0;
  async function pace(): Promise<void> {
    const t = nowFn().getTime();
    const start = Math.max(t, nextStart);
    nextStart = start + MIN_START_GAP_MS;
    if (start > t) await sleep(start - t);
  }

  async function fetchImage(startUrl: URL): Promise<FetchOutcome> {
    let url = startUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await pace();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
      try {
        // Only these two headers; no cookies, credentials, Referer or session of any kind.
        const res = await doFetch(url.toString(), {
          method: "GET",
          headers: { "User-Agent": cfg.userAgent, Accept: "image/*" },
          redirect: "manual",
          credentials: "omit",
          signal: ctrl.signal,
        });
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get("location");
          await res.body?.cancel();
          if (!loc) return { kind: "failed" };
          let next: URL | null;
          try {
            next = isAllowedUrl(new URL(loc, url).toString(), cfg.allowedHosts);
          } catch {
            next = null;
          }
          if (!next) return { kind: "failed" };
          url = next;
          continue;
        }
        if (res.status === 403 || res.status === 404 || res.status === 410) {
          await res.body?.cancel();
          return { kind: "expired" };
        }
        if (res.status === 429 || res.status >= 500) {
          await res.body?.cancel();
          return { kind: "retry" };
        }
        if (res.status < 200 || res.status >= 300) {
          await res.body?.cancel();
          return { kind: "failed" };
        }
        if (!(res.headers.get("content-type") ?? "").toLowerCase().startsWith("image/")) {
          await res.body?.cancel();
          return { kind: "failed" };
        }
        const declared = Number(res.headers.get("content-length") ?? "");
        if (Number.isFinite(declared) && declared > cfg.maxBytes) {
          await res.body?.cancel();
          return { kind: "failed" };
        }
        const reader = res.body?.getReader();
        if (!reader) return { kind: "failed" };
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > cfg.maxBytes) {
            await reader.cancel();
            return { kind: "failed" };
          }
          chunks.push(value);
        }
        return { kind: "ok", buf: Buffer.concat(chunks) };
      } catch {
        return { kind: "retry" };
      } finally {
        clearTimeout(timer);
      }
    }
    return { kind: "failed" }; // more than MAX_REDIRECTS hops
  }

  async function settle(id: string, state: "ok" | "none" | "expired" | "failed"): Promise<void> {
    await handle.sql`update post set thumb_state = ${state}, thumb_checked_at = ${nowIso}::timestamptz where id = ${id}::uuid and thumb_state is null`;
  }

  async function processOne(row: { id: string; media: unknown; thumb_attempts: number }): Promise<void> {
    const raw = firstImageUrl(row.media);
    if (raw === null) {
      await settle(row.id, "none");
      result.none++;
      return;
    }
    const url = isAllowedUrl(raw, cfg.allowedHosts);
    if (url === null) {
      await settle(row.id, "failed");
      result.failed++;
      return;
    }
    if (isExpired(url, nowFn().getTime())) {
      await settle(row.id, "expired");
      result.expired++;
      return;
    }
    const out = await fetchImage(url);
    if (out.kind === "ok") {
      try {
        const webp = await shrink(out.buf);
        const path = thumbPath(mediaDir, row.id);
        await mkdir(dirname(path), { recursive: true });
        const tmp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
        await writeFile(tmp, webp);
        await rename(tmp, path);
        await settle(row.id, "ok");
        readyIds.push(row.id);
        result.ok++;
      } catch (err) {
        logger.warn({ err, postId: row.id }, "thumb: could not decode/store image");
        await settle(row.id, "failed");
        result.failed++;
      }
      return;
    }
    if (out.kind === "expired" || out.kind === "failed") {
      await settle(row.id, out.kind);
      result[out.kind]++;
      return;
    }
    const attempts = row.thumb_attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await handle.sql`update post set thumb_state = 'failed', thumb_attempts = ${attempts}, thumb_checked_at = ${nowIso}::timestamptz where id = ${row.id}::uuid and thumb_state is null`;
      result.failed++;
    } else {
      await handle.sql`update post set thumb_attempts = ${attempts}, thumb_checked_at = ${nowIso}::timestamptz where id = ${row.id}::uuid and thumb_state is null`;
      result.retry++;
    }
  }

  const readyIds: string[] = [];
  const queue = [...rows];
  const budgetMs = deps.budgetMs ?? SWEEP_BUDGET_MS;
  const startedAt = Date.now();
  const worker = async (): Promise<void> => {
    for (let row = queue.shift(); row !== undefined; row = queue.shift()) {
      if (Date.now() - startedAt >= budgetMs) {
        logger.warn({ left: queue.length + 1 }, "thumb sweep: time budget reached, rest deferred");
        return;
      }
      try {
        await processOne(row);
      } catch (err) {
        logger.error({ err, postId: row.id }, "thumb: unexpected error");
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_IN_FLIGHT, rows.length) }, worker));
  if (readyIds.length > 0) {
    try {
      const payload = JSON.stringify({ postIds: readyIds.slice(0, THUMB_READY_MAX_IDS) });
      await handle.sql`select pg_notify(${THUMB_READY_CHANNEL}, ${payload})`;
    } catch (err) {
      logger.warn({ err }, "thumb: live notify failed"); // cosmetic; feed refetches on its own interval
    }
  }
  if (result.picked > 0) logger.info(result, "thumb sweep");
  return result;
}

export async function registerThumbJob(boss: PgBoss, handle: DbHandle, mediaDir: string): Promise<void> {
  await boss.createQueue(THUMB_QUEUE, { expireInSeconds: 900, policy: "exclusive" });
  await boss.schedule(THUMB_QUEUE, THUMB_CRON, {});
  await boss.work(THUMB_QUEUE, async () => {
    await runThumbSweep({ handle, mediaDir });
  });
}
