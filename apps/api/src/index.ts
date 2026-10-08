import { piiMask } from "./middleware/pii-mask";
import { createDb, schema, type DbHandle } from "@feedhound/db";
import { createLogger } from "@feedhound/core/logger";
import { createRegistry } from "@feedhound/core/metrics";
import { bootDelaysFromEnv, bootWithRetry, installShutdownHandlers, onShutdown } from "@feedhound/core/shutdown";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import { apiKeyAuth, type ApiKeyContext } from "./middleware/api-key";
import { csrfGuard, hasSessionCookie, isSameOrigin } from "./middleware/local-auth";
import { assertAuthConfig, assertNotDemoHash } from "./middleware/auth-mode";
import { authRoute } from "./routes/auth";
import { resolveSession, type Session } from "./middleware/cf-access";
import { catalogueRoute } from "./routes/catalogue";
import { configRoute } from "./routes/config";
import { analyticsRoute } from "./routes/analytics";
import { dashboardMatchesRoute } from "./routes/dashboard-matches";
import { healthRoute } from "./routes/health";
import { healthzRoute } from "./routes/healthz";
import { ingestRoute } from "./routes/ingest";
import { keysRoute } from "./routes/keys";
import { matchesRoute } from "./routes/matches";
import { metricsRoute, opsSloRoute, routePattern } from "./routes/metrics";
import { meRoute } from "./routes/me";
import { notificationsRoute } from "./routes/notifications";
import { notifiersRoute } from "./routes/notifiers";
import { opsDlqRoute } from "./routes/ops-dlq";
import { opsHealthRoute } from "./routes/ops-health";
import { opsNotifyRoute } from "./routes/ops-notify";
import { pickersRoute } from "./routes/pickers";
import { mediaRoute } from "./routes/media";
import { postFlagsRoute } from "./routes/post-flags";
import { postsRoute } from "./routes/posts";
import { reenrichRoute } from "./routes/reenrich";
import type { WebHttp } from "../../agent/src/web/types";
import { sourcesRoute } from "./routes/sources";
import { unclassifiedRoute } from "./routes/unclassified";
import { usersRoute } from "./routes/users";
import { visitsRoute } from "./routes/visits";
import { watchParseRoute } from "./routes/watch-parse";
import { watchesRoute } from "./routes/watches";
import { savedSearchesRoute } from "./routes/saved-searches";
import { dealDecisionRoute } from "./routes/deal-decision";
import { insightsOverviewRoute } from "./routes/insights-overview";
import { insightsRoute } from "./routes/insights";
import { topicsRoute } from "./routes/topics";
import { searchRoute } from "./routes/search";
import { sourceGroupsRoute } from "./routes/source-groups";
import type { LlmProvider } from "./services/llm";
import { LiveFeed, type LiveClient } from "./ws/live";

const PORT = Number(process.env.API_PORT ?? 4820);
const logger = createLogger({ service: "api" });

export type ApiApp = Hono<{
  Variables: { apiKey: ApiKeyContext; session: Session; requestId: string; log: ReturnType<typeof createLogger> };
}>;

export function createApp(handle: DbHandle, boss?: PgBoss, opts: { llm?: LlmProvider; now?: () => Date; webHttp?: WebHttp } = {}): ApiApp {
  const app: ApiApp = new Hono();

  // Per-app registry; `route` label is the matched route pattern, never the raw path.
  const registry = createRegistry();
  const httpRequests = registry.counter("http_requests_total", "HTTP requests by matched route pattern and status", ["route", "status"]);
  app.use(async (c, next) => {
    await next();
    httpRequests.inc({ route: routePattern(c.req.matchedRoutes), status: String(c.res.status) });
  });

  app.use(async (c, next) => {
    const requestId = randomUUID();
    c.set("requestId", requestId);
    const requestLogger = logger.child({ requestId });
    c.set("log", requestLogger);
    try {
      await next();
    } finally {
      requestLogger.info({ method: c.req.method, path: c.req.path, status: c.res.status });
    }
  });

  app.use("/api/*", csrfGuard()); // cookie-authenticated writes must be same-origin
  app.use("/api/*", piiMask(handle)); // Before every /api route

  app.route("/", healthzRoute("api", handle, boss));
  app.route("/", metricsRoute(handle, registry));
  app.route("/", opsSloRoute(handle));

  // Scoped test route used by apps/api/src/auth.test.ts; real ingest routes are registered elsewhere.
  app.get("/api/ingest/_ping", apiKeyAuth(["ingest"], handle), (c) => c.json({ ok: true }));

  app.route("/", ingestRoute(handle, boss));
  app.route("/", healthRoute(handle));
  app.route("/", visitsRoute(handle));
  app.route("/", sourcesRoute(handle, { http: opts.webHttp }));
  app.route("/", opsNotifyRoute(handle));
  app.route("/", opsDlqRoute(handle, boss));
  app.route("/", watchParseRoute(handle, { llm: opts.llm, now: opts.now }));
  app.route("/", watchesRoute(handle));
  app.route("/", matchesRoute(handle));
  app.route("/", notificationsRoute(handle, boss));
  app.route("/", notifiersRoute(handle));

  // Dashboard core (session auth, users/keys/config/pickers/health).
  app.route("/", authRoute(handle));
  app.route("/", meRoute(handle));
  app.route("/", usersRoute(handle));
  app.route("/", keysRoute(handle));
  app.route("/", configRoute(handle));
  app.route("/", pickersRoute(handle));
  app.route("/", opsHealthRoute(handle));
  app.route("/", postsRoute(handle));
  // Per-user saved/hidden flags and the cached thumbnail.
  app.route("/", postFlagsRoute(handle));
  app.route("/", mediaRoute(handle));
  // Session-facing matches inbox.
  app.route("/", dashboardMatchesRoute(handle));
  // Overview KPIs, trending, per-source rates.

  // Enrichment (catalogue CRUD, unclassified queue, re-enrich).
  app.route("/", catalogueRoute(handle));
  app.route("/", unclassifiedRoute(handle));
  app.route("/", reenrichRoute(handle, boss));

  // Analytics read routes (session auth, team-scoped rollups).
  app.route("/", analyticsRoute(handle));

  // Corpus search, saved searches, save-as-watch, CSV export.
  app.route("/", searchRoute(handle));
  app.route("/", savedSearchesRoute(handle));

  // Source library tree + override + reclassify.
  app.route("/", sourceGroupsRoute(handle, boss));

  // Topics (series + spikes) and the insights inbox.
  app.route("/", topicsRoute(handle, boss, opts.now));
  app.route("/", insightsRoute(handle));
  // Deal decision (verdict, compare) and the insights overview.
  app.route("/", dealDecisionRoute(handle));
  app.route("/", insightsOverviewRoute(handle, opts.now));

  return app;
}

/**
 * Starts pg-boss, injectable via `bossFactory` for tests. Throws (rejects) if
 * `.start()` fails, so the caller can decide what "queue down at boot" means.
 */
export async function createBoss(databaseUrl: string, bossFactory: (url: string) => PgBoss = (url) => new PgBoss(url)): Promise<PgBoss> {
  const boss = bossFactory(databaseUrl);
  boss.on("error", (err: Error) => logger.error({ err }, "pg-boss error"));
  await boss.start();
  return boss;
}

/** `ops.shutdownTimeoutMs` (config, fallback 30_000); read once at boot. */
async function fetchShutdownTimeoutMs(handle: DbHandle): Promise<number> {
  const [row] = await handle.db
    .select({ value: schema.config.value })
    .from(schema.config)
    .where(eq(schema.config.key, "ops.shutdownTimeoutMs"))
    .orderBy(desc(schema.config.version))
    .limit(1);
  return typeof row?.value === "number" ? row.value : 30_000;
}

/** True when the demo seed wrote `demo.enabled=true` into config. */
async function isDemoEnabled(handle: DbHandle): Promise<boolean> {
  const [row] = await handle.db.select({ value: schema.config.value }).from(schema.config).where(eq(schema.config.key, "demo.enabled")).orderBy(desc(schema.config.version)).limit(1);
  return row?.value === true;
}

if (import.meta.main) {
  try {
    for (const w of assertAuthConfig()) logger.warn(w);
  } catch (err) {
    logger.error({ err }, err instanceof Error ? err.message : "invalid auth configuration");
    process.exit(1);
  }
  const handle = createDb();
  try {
    await assertNotDemoHash(process.env, () => isDemoEnabled(handle));
  } catch (err) {
    logger.error({ err }, err instanceof Error ? err.message : "invalid auth configuration");
    process.exit(1);
  }
  let boss: PgBoss;
  let currentAttemptBoss: PgBoss | undefined;
  try {
    // same boot-retry ladder as the agent
    // preserved — a queue that never comes up must not leave the API
    // serving /api/ingest -> 503 forever); final failure still exits.
    boss = await bootWithRetry(
      () => {
        const factory = (url: string) => {
          const b = new PgBoss(url);
          currentAttemptBoss = b;
          return b;
        };
        return createBoss(process.env.DATABASE_URL ?? "", factory);
      },
      {
        delaysMs: bootDelaysFromEnv(),
        logger,
        onFail: async () => {
          await currentAttemptBoss?.stop({ graceful: false, close: true }).catch(() => {});
        },
      },
    );
  } catch (err) {
    logger.error({ err }, "pg-boss failed to start after all boot retries; exiting so the process supervisor restarts the service");
    process.exit(1);
  }
  const app = createApp(handle, boss);
  const liveFeed = new LiveFeed(handle);

  // read config before any shutdown hooks are registered, but never
  // let a DB hiccup here skip registering them — fall back to the default
  // instead of leaving the process without shutdown handlers installed.
  let shutdownTimeoutMs = 30_000;
  try {
    shutdownTimeoutMs = await fetchShutdownTimeoutMs(handle);
  } catch (err) {
    logger.warn({ err }, "failed to read ops.shutdownTimeoutMs; using default");
  }

  // `/ws`: same auth as `/api/*`, then handed off to
  // `LiveFeed` for the connection's lifetime. Not routable through Hono's
  // `app.fetch` (no `server.upgrade()` access there), so it is intercepted
  // here before falling through to the Hono app for every other path.
  // count HTTP requests currently being handled by `app.fetch` so the
  // "http" shutdown hook can stop waiting the moment it's safe, instead of
  // always sleeping the full 5s even with nothing in flight.
  let inFlightRequests = 0;
  const server = Bun.serve<{ session: Session }>({
    port: PORT,
    // Bun's default (10 s) cuts long LLM routes such as POST /api/watches/parse; stay just above Cloudflare's ~100 s origin timeout.
    idleTimeout: 120,
    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        // Cookie-authenticated upgrades must come from our own origin (cross-site WebSocket hijacking).
        if (hasSessionCookie(req.headers) && req.headers.get("origin") && !isSameOrigin(req.headers)) {
          return new Response("forbidden origin", { status: 403 });
        }
        const session = await resolveSession(req.headers, handle);
        if (session === undefined) return new Response("unauthenticated", { status: 401 });
        if (session === "not_provisioned") return new Response("not_provisioned", { status: 403 });
        const upgraded = server.upgrade(req, { data: { session } });
        if (upgraded) return undefined as unknown as Response;
        return new Response("upgrade failed", { status: 400 });
      }
      inFlightRequests++;
      try {
        return await app.fetch(req);
      } finally {
        inFlightRequests--;
      }
    },
    websocket: {
      open(ws) {
        const client: LiveClient = { session: ws.data.session, send: (frame) => ws.send(JSON.stringify(frame)) };
        // 30s heartbeat ping.
        const heartbeat = setInterval(() => ws.ping(), 30_000);
        (ws.data as { session: Session; unsubscribe?: () => void; heartbeat?: ReturnType<typeof setInterval> }).unsubscribe =
          liveFeed.addClient(client);
        (ws.data as { heartbeat?: ReturnType<typeof setInterval> }).heartbeat = heartbeat;
      },
      message() {
        // Client -> server: none.
      },
      close(ws) {
        clearInterval((ws.data as { heartbeat?: ReturnType<typeof setInterval> }).heartbeat);
        (ws.data as { unsubscribe?: () => void }).unsubscribe?.();
      },
    },
  });
  logger.info({ port: PORT }, "api listening");

  // http -> boss -> db, in registration order (FIFO).
  onShutdown(
    "http",
    async () => {
      server.stop(false);
      const deadline = Date.now() + 5_000;
      while (inFlightRequests > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await server.stop(true);
    },
    { timeoutMs: 10_000 },
  );
  onShutdown("boss", () => boss.stop({ graceful: true, timeout: shutdownTimeoutMs, close: true }), { timeoutMs: shutdownTimeoutMs + 1_000 });
  onShutdown("db", () => handle.close());
  installShutdownHandlers({ logger, hardDeadlineMs: shutdownTimeoutMs + 5_000 });
}
