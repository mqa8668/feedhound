import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { createApp } from "../index";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const MUST_RUN = Boolean(process.env.CI) || Boolean(TEST_DATABASE_URL);
let canRun = false;
if (TEST_DATABASE_URL) {
  const probe = createDb(TEST_DATABASE_URL);
  try {
    const rows = await probe.sql<{ name: string }[]>`select current_database() as name`;
    const name = rows[0]?.name;
    if (!name || !name.endsWith("_test")) throw new Error(`refusing to run against non-test database: ${name ?? "unknown"}`);
    canRun = true;
  } catch (err) {
    if (MUST_RUN) throw err;
  } finally {
    await probe.close();
  }
} else if (MUST_RUN) {
  throw new Error("ops-health.test.ts: TEST_DATABASE_URL is required (CI is set)");
}

// 15:00 Asia/Ho_Chi_Minh
const NOW = new Date("2026-10-03T08:00:00Z");
const CONFIG: Record<string, unknown> = {
  "app.tz": "Asia/Ho_Chi_Minh",
  "schedule.activeHours": { start: "07:00", end: "23:00" },
  "schedule.visitEverySec": { min: 900, max: 2700 },
  "schedule.dailyCapPerSource": 12,
  "watchdog.gapMultiplier": 1.5,
  "watchdog.gapGraceMin": 5,
};

describe.skipIf(!canRun)("GET /api/ops/health ingest silence", () => {
  let handle: DbHandle;
  let teamId: string;
  let email: string;
  let sourceId: string;
  let originalNodeEnv: string | undefined;
  let originalBypass: string | undefined;
  const injected: { key: string; version: number }[] = [];

  async function health(): Promise<{ ingest: { lastVisitAt: string | null; silent: boolean; thresholdSec: number } }> {
    const res = await createApp(handle).request("/api/ops/health", { headers: { "X-Dev-User": email } });
    expect(res.status).toBe(200);
    return (await res.json()) as never;
  }

  beforeAll(async () => {
    originalNodeEnv = process.env.NODE_ENV;
    originalBypass = process.env.DEV_AUTH_BYPASS;
    process.env.NODE_ENV = "development";
    process.env.DEV_AUTH_BYPASS = "1";
    handle = createDb(TEST_DATABASE_URL);

    // Config is append-only: add one newer version per key, delete exactly those rows afterwards.
    for (const [key, value] of Object.entries(CONFIG)) {
      const [latest] = await handle.db.select({ version: schema.config.version }).from(schema.config).where(eq(schema.config.key, key)).orderBy(desc(schema.config.version)).limit(1);
      const version = (latest?.version ?? 0) + 1;
      await handle.db.insert(schema.config).values({ key, version, value, updatedBy: "ops-health.test.ts" });
      injected.push({ key, version });
    }

    const [team] = await handle.db.insert(schema.team).values({ name: `ops-health-${crypto.randomUUID()}` }).returning({ id: schema.team.id });
    teamId = team!.id;
    email = `ops-health-${crypto.randomUUID()}@example.com`;
    await handle.db.insert(schema.user).values({ teamId, email, role: "operator" });
    const [src] = await handle.db
      .insert(schema.source)
      .values({
        teamId,
        kind: "push",
        platformId: `oh-${crypto.randomUUID()}`,
        name: "Ops health group",
        url: "https://feeds.example.test/oh",
        createdAt: new Date(NOW.getTime() - 4 * 3600_000),
      })
      .returning({ id: schema.source.id });
    sourceId = src!.id;
  });

  afterEach(async () => {
    setSystemTime();
    await handle.db.delete(schema.visit).where(eq(schema.visit.sourceId, sourceId));
    await handle.db.update(schema.source).set({ status: "active", health: { ok: null }, lastHealthAt: null }).where(eq(schema.source.id, sourceId));
  });

  afterAll(async () => {
    setSystemTime();
    for (const { key, version } of injected) await handle.db.delete(schema.config).where(and(eq(schema.config.key, key), eq(schema.config.version, version)));
    await handle.db.delete(schema.source).where(eq(schema.source.teamId, teamId));
    await handle.db.delete(schema.user).where(eq(schema.user.teamId, teamId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalBypass === undefined) delete process.env.DEV_AUTH_BYPASS;
    else process.env.DEV_AUTH_BYPASS = originalBypass;
    await handle.close();
  });

  async function visitAt(at: Date): Promise<void> {
    await handle.db.insert(schema.visit).values({ id: crypto.randomUUID(), sourceId, startedAt: at, finishedAt: at, outcome: "ok" });
  }

  test("Last visit 3 h ago at 15:00 -> silent with lastVisitAt", async () => {
    const at = new Date(NOW.getTime() - 3 * 3600_000);
    await visitAt(at);
    setSystemTime(NOW);
    const h = await health();
    expect(h.ingest.silent).toBe(true);
    expect(h.ingest.lastVisitAt).toBe(at.toISOString());
    expect(h.ingest.thresholdSec).toBe(7500);
  });

  test("Last visit 20 min ago -> not silent", async () => {
    await visitAt(new Date(NOW.getTime() - 20 * 60_000));
    setSystemTime(NOW);
    expect((await health()).ingest.silent).toBe(false);
  });

  test("02:00 local (outside active hours) -> not silent", async () => {
    const night = new Date("2026-10-02T19:00:00Z");
    await visitAt(new Date(night.getTime() - 5 * 3600_000));
    setSystemTime(night);
    expect((await health()).ingest.silent).toBe(false);
  });

  test("No visits ever, source created 4 h ago -> silent with lastVisitAt null", async () => {
    setSystemTime(NOW);
    const h = await health();
    expect(h.ingest.silent).toBe(true);
    expect(h.ingest.lastVisitAt).toBeNull();
  });

  test("A fresh web visit does not mask a silent push source; web-only team is not silent", async () => {
    const pushAt = new Date(NOW.getTime() - 3 * 3600_000);
    await visitAt(pushAt);
    const [web] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `oh-web-${crypto.randomUUID()}`, name: "web", url: "https://feeds.example.test/web-x", createdAt: new Date(NOW.getTime() - 4 * 3600_000) })
      .returning({ id: schema.source.id });
    await handle.db.insert(schema.visit).values({ id: crypto.randomUUID(), sourceId: web!.id, startedAt: new Date(NOW.getTime() - 60_000), finishedAt: new Date(NOW.getTime() - 60_000), outcome: "ok" });
    setSystemTime(NOW);
    const h = await health();
    expect(h.ingest.silent).toBe(true);
    expect(h.ingest.lastVisitAt).toBe(pushAt.toISOString());

    // Web-only team.
    const [team2] = await handle.db.insert(schema.team).values({ name: `ops-health-web-${crypto.randomUUID()}` }).returning({ id: schema.team.id });
    const email2 = `ops-health-web-${crypto.randomUUID()}@example.com`;
    await handle.db.insert(schema.user).values({ teamId: team2!.id, email: email2, role: "operator" });
    await handle.db
      .insert(schema.source)
      .values({ teamId: team2!.id, kind: "web", platformId: `oh-web2-${crypto.randomUUID()}`, name: "web2", url: "https://feeds.example.test/web-y", createdAt: new Date(NOW.getTime() - 4 * 3600_000) });
    const res = await createApp(handle).request("/api/ops/health", { headers: { "X-Dev-User": email2 } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ingest: { silent: boolean } }).ingest.silent).toBe(false);

    await handle.db.delete(schema.visit).where(eq(schema.visit.sourceId, web!.id));
    await handle.db.delete(schema.source).where(eq(schema.source.teamId, team2!.id));
    await handle.db.delete(schema.source).where(eq(schema.source.id, web!.id));
    await handle.db.delete(schema.user).where(eq(schema.user.teamId, team2!.id));
    await handle.db.delete(schema.team).where(eq(schema.team.id, team2!.id));
  });

});

// Debt D6 (plan 2026-10-05 ruling 3): an `ops`-scope Bearer key may read this GET.
describe.skipIf(!canRun)("GET /api/ops/health accepts an ops-scope api key (debt D6)", () => {
  let handle: DbHandle;
  let teamId: string;
  let userId: string;
  const opsToken = `ops_${crypto.randomUUID().replaceAll("-", "")}`;
  const ingestToken = `ing_${crypto.randomUUID().replaceAll("-", "")}`;

  async function sha256Hex(input: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  const get = (token?: string) =>
    createApp(handle).request("/api/ops/health", { headers: token ? { Authorization: `Bearer ${token}` } : {} });

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    const [team] = await handle.db.insert(schema.team).values({ name: `ops-key-${crypto.randomUUID()}` }).returning({ id: schema.team.id });
    teamId = team!.id;
    const [user] = await handle.db.insert(schema.user).values({ teamId, email: `ops-key-${crypto.randomUUID()}@example.com`, role: "operator" }).returning({ id: schema.user.id });
    userId = user!.id;
    await handle.db.insert(schema.apiKey).values([
      { userId, name: "ops-d6", prefix: opsToken.slice(0, 8), hash: await sha256Hex(opsToken), scopes: ["ops"] },
      { userId, name: "ingest-d6", prefix: ingestToken.slice(0, 8), hash: await sha256Hex(ingestToken), scopes: ["ingest"] },
    ]);
  });

  afterAll(async () => {
    await handle.db.delete(schema.apiKey).where(eq(schema.apiKey.userId, userId));
    await handle.db.delete(schema.user).where(eq(schema.user.id, userId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("ops key -> 200 with the health body; ingest-only key -> 403; no credentials -> 401; bad key -> 401", async () => {
    const ok = await get(opsToken);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toHaveProperty("ingest");
    expect((await get(ingestToken)).status).toBe(403);
    const anon = await get();
    expect(anon.status).toBe(401);
    expect(await anon.json()).toEqual({ error: "unauthenticated" });
    expect((await get("ops_does-not-exist")).status).toBe(401);
  });
});

// --- 10 s per-team cache -------------------------------------------------------
import { Hono } from "hono";
import { opsHealthRoute } from "./ops-health";

describe.skipIf(!canRun)("GET /api/ops/health cache", () => {
  let handle: DbHandle;
  const teams: { teamId: string; email: string }[] = [];
  let originalNodeEnv: string | undefined;
  let originalBypass: string | undefined;
  let probes = 0;
  let dbDown = false;

  /** Counting double: wraps `handle.sql` so `select 1` probes are counted (and can fail). */
  function counting(real: DbHandle): DbHandle {
    const sql = new Proxy(real.sql, {
      apply(target, thisArg, args: unknown[]) {
        const first = args[0];
        if (Array.isArray(first) && String(first[0]).trim() === "select 1") {
          probes++;
          if (dbDown) return Promise.reject(new Error("down"));
        }
        return Reflect.apply(target, thisArg, args);
      },
    });
    return { ...real, sql } as DbHandle;
  }

  beforeAll(async () => {
    originalNodeEnv = process.env.NODE_ENV;
    originalBypass = process.env.DEV_AUTH_BYPASS;
    process.env.NODE_ENV = "development";
    process.env.DEV_AUTH_BYPASS = "1";
    handle = createDb(TEST_DATABASE_URL);
    for (let i = 0; i < 2; i++) {
      const [team] = await handle.db.insert(schema.team).values({ name: `ops-cache-${crypto.randomUUID()}` }).returning({ id: schema.team.id });
      const email = `ops-cache-${crypto.randomUUID()}@example.com`;
      await handle.db.insert(schema.user).values({ teamId: team!.id, email, role: "operator" });
      teams.push({ teamId: team!.id, email });
    }
  });

  afterAll(async () => {
    for (const t of teams) {
      await handle.db.delete(schema.user).where(eq(schema.user.teamId, t.teamId));
      await handle.db.delete(schema.team).where(eq(schema.team.id, t.teamId));
    }
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalBypass === undefined) delete process.env.DEV_AUTH_BYPASS;
    else process.env.DEV_AUTH_BYPASS = originalBypass;
    await handle.close();
  });

  function build(clock: { t: number }): Hono {
    const app = new Hono();
    app.route("/", opsHealthRoute(counting(handle), { now: () => clock.t }));
    return app;
  }
  const get = (app: Hono, email: string): Promise<Response> => Promise.resolve(app.request("/api/ops/health", { headers: { "X-Dev-User": email } }));

  test("20 requests in 10 s evaluate once; TTL expiry, second team and db-down re-evaluate", async () => {
    probes = 0;
    dbDown = false;
    const clock = { t: 1_000_000 };
    const app = build(clock);
    const [a, b] = teams;
    for (let i = 0; i < 20; i++) {
      clock.t += 400; // 8 s in total
      const res = await get(app, a!.email);
      expect(res.status).toBe(200);
    }
    expect(probes).toBe(1);
    expect(((await (await get(app, a!.email)).json()) as { db: string }).db).toBe("ok");

    await get(app, b!.email);
    expect(probes).toBe(2);

    clock.t += 10_001;
    await get(app, a!.email);
    expect(probes).toBe(3);

    dbDown = true;
    clock.t += 10_001;
    const down = (await (await get(app, a!.email)).json()) as { db: string };
    expect(down.db).toBe("down");
    expect(probes).toBe(4);
    dbDown = false;
    const recovered = (await (await get(app, a!.email)).json()) as { db: string };
    expect(recovered.db).toBe("ok");
    expect(probes).toBe(5);
  });
});
