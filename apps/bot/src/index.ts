import { runReadiness } from "@feedhound/core/health";
import { installShutdownHandlers, isShuttingDown, onShutdown } from "@feedhound/core/shutdown";
import { createLogger } from "@feedhound/core/logger";
import { appVersion } from "@feedhound/core/version";
import { createRegistry, METRICS_CONTENT_TYPE, type MetricsRegistry } from "@feedhound/core/metrics";
import { createDb, schema, type DbHandle } from "@feedhound/db";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { createTelegramApiClient, type TelegramApiClient } from "./telegram-api";
import { pollOnce, setupCommands, type PollDeps } from "./poll";


const logger = createLogger({ service: "bot" });

async function checkDb(handle: DbHandle): Promise<boolean> {
  try {
    await handle.sql`select 1`;
    return true;
  } catch {
    return false;
  }
}

/** Bot poll-loop series for `/metrics`. */
export function createBotMetrics(): { registry: MetricsRegistry; pollOk(now: Date): void; pollError(): void } {
  const registry = createRegistry();
  const lastOk = registry.gauge("bot_poll_last_ok_timestamp_seconds", "Unix time of the last successful Telegram poll", []);
  const errors = registry.counter("bot_poll_errors_total", "Failed Telegram poll cycles", []);
  // Gauges are cleared on every render, so the last-ok time is re-published by a collector.
  let lastOkSeconds: number | undefined;
  registry.collector("poll", async () => {
    if (lastOkSeconds !== undefined) lastOk.set(undefined, lastOkSeconds);
  });
  return {
    registry,
    pollOk: (now) => {
      lastOkSeconds = now.getTime() / 1000;
    },
    pollError: () => errors.inc(),
  };
}

/** `/healthz` (liveness) + `/readyz` (readiness: `db`, `accepting`) + optional `/metrics` for the bot process (017). */
export function createBotApp(handle: DbHandle, metrics?: MetricsRegistry): Hono {
  const app = new Hono();

  if (metrics) {
    app.get("/metrics", async (c) => c.body(await metrics.render(), 200, { "Content-Type": METRICS_CONTENT_TYPE }));
  }

  app.get("/healthz", (c) => c.json({ ok: true, service: "bot", version: appVersion() }));

  app.get("/readyz", async (c) => {
    const result = await runReadiness({
      db: () => checkDb(handle),
      accepting: () => !isShuttingDown(),
    });
    return c.json({ ok: result.ok, service: "bot", version: appVersion(), checks: result.checks }, result.ok ? 200 : 503);
  });

  return app;
}

async function fetchOffsetConfig(handle: DbHandle): Promise<number> {
  const [row] = await handle.db
    .select({ value: schema.config.value })
    .from(schema.config)
    .where(eq(schema.config.key, "bot.telegram.updateOffset"))
    .orderBy(desc(schema.config.version))
    .limit(1);
  return typeof row?.value === "number" ? row.value : 0;
}

async function persistOffset(handle: DbHandle, offset: number): Promise<void> {
  const [latest] = await handle.db
    .select({ version: schema.config.version })
    .from(schema.config)
    .where(eq(schema.config.key, "bot.telegram.updateOffset"))
    .orderBy(desc(schema.config.version))
    .limit(1);
  await handle.db.insert(schema.config).values({
    key: "bot.telegram.updateOffset",
    version: (latest?.version ?? 0) + 1,
    value: offset,
    updatedBy: "bot",
  });
}

/**
 * Long polling (`getUpdates`, timeout 30s), offset
 * persisted in `bot.telegram.updateOffset` after each batch; DB/Telegram
 * errors are logged, never exit the process.
 *
 * Checks `isShuttingDown()` before starting the next
 * `pollOnce` (never mid-poll — the in-flight `getUpdates` long poll is never
 * aborted); `onPersist` reports the in-flight `persistOffset` promise so the
 * `poll` shutdown hook can await it (bounded by its own `timeoutMs`) without
 * ever waiting on `getUpdates` itself.
 */
export async function runPollLoop(
  handle: DbHandle,
  onPersist: (p: Promise<void>) => void,
  metrics: { pollOk(now: Date): void; pollError(): void },
  opts: { api?: TelegramApiClient; maxCycles?: number } = {},
): Promise<void> {
  // `opts.api` / `opts.maxCycles` are a test seam; TG_BOT_TOKEN is only required without `opts.api`.
  let api = opts.api;
  if (!api) {
    const botToken = process.env.TG_BOT_TOKEN;
    if (!botToken) {
      logger.error("TG_BOT_TOKEN is not set; bot cannot poll Telegram");
      process.exit(1);
    }
    api = createTelegramApiClient({ botToken, apiBase: process.env.TG_API_BASE });
  }
  await setupCommands(api);

  let offset = await fetchOffsetConfig(handle);
  const deps: PollDeps = { handle, api };

  for (let cycle = 0; !isShuttingDown() && (opts.maxCycles === undefined || cycle < opts.maxCycles); cycle++) {
    try {
      const nextOffset = await pollOnce(deps, offset, 30);
      metrics.pollOk(new Date());
      if (nextOffset !== offset) {
        offset = nextOffset;
        const persisting = persistOffset(handle, offset);
        // report a promise that never rejects — a rejected
        // `persistOffset` is already logged below via `await persisting`;
        // the shutdown hook only needs to know the write settled, not
        // re-throw the same error and fail shutdown.
        onPersist(persisting.catch(() => undefined));
        await persisting;
      }
    } catch (err) {
      metrics.pollError();
      logger.error({ err }, "bot: poll cycle failed");
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}

if (import.meta.main) {
  const PORT = Number(process.env.BOT_PORT ?? 4822);
  const handle = createDb();
  const botMetrics = createBotMetrics();
  const app = createBotApp(handle, botMetrics.registry);

  const server = Bun.serve({ port: PORT, fetch: app.fetch });
  logger.info({ port: PORT, version: appVersion() }, "bot listening");

  let currentPersist: Promise<void> = Promise.resolve();
  void runPollLoop(
    handle,
    (p) => {
      currentPersist = p;
    },
    botMetrics,
  );

  const shutdownTimeoutMs = 30_000; // bot has no pg-boss; not config-driven.
  onShutdown("poll", () => currentPersist, { timeoutMs: 5_000 });
  onShutdown("http", () => server.stop(true));
  onShutdown("db", () => handle.close());
  installShutdownHandlers({ logger, hardDeadlineMs: shutdownTimeoutMs + 5_000 });
}
