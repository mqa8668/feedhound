import { createDb, schema, type DbHandle } from "@feedhound/db";
import { seedTaxonomyAndCatalogue } from "@feedhound/db/src/seed";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../index";
import { fakeFeedHttp, RSS_BODY } from "./test-feed-http";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const MUST_RUN = Boolean(process.env.CI) || Boolean(TEST_DATABASE_URL);

function isTestDbUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    return new URL(url).pathname.replace(/^\//, "").endsWith("_test");
  } catch {
    return false;
  }
}

if (TEST_DATABASE_URL && !isTestDbUrl(TEST_DATABASE_URL)) {
  throw new Error("TEST_DATABASE_URL must point at a database whose name ends in '_test'");
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

let canRun = false;
if (TEST_DATABASE_URL) {
  const probe = createDb(TEST_DATABASE_URL);
  let reachable = true;
  try {
    await probe.sql`select 1`;
  } catch (err) {
    reachable = false;
    if (MUST_RUN) {
      await probe.close();
      throw err;
    }
    console.warn(`sources.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
  }
  if (reachable) {
    const rows = await probe.sql<{ name: string }[]>`select current_database() as name`;
    const name = rows[0]?.name;
    if (!name || !name.endsWith("_test")) {
      await probe.close();
      throw new Error(`refusing to run against non-test database: ${name ?? "unknown"}`);
    }
    canRun = true;
  }
  await probe.close();
} else if (MUST_RUN) {
  throw new Error("sources.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("sources.test.ts: skipped — TEST_DATABASE_URL is unset");
}

// Code-review finding #7: POST/PATCH /api/sources must be scoped to the
// caller's team (never trust a client-supplied teamId), require the
// operator role, and only accept an `assignedKeyId` on the same team.
describe.skipIf(!canRun)("POST/PATCH /api/sources team scoping (code-review finding #7)", () => {
  let handle: DbHandle;
  let teamA: string;
  let teamB: string;
  let operatorKey: string;
  let hunterKey: string;
  let teamBKeyId: string;
  let revokedKeyId: string;
  let noIngestScopeKeyId: string;

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);

    const [a] = await handle.db.insert(schema.team).values({ name: "sources-test-team-a" }).returning({ id: schema.team.id });
    teamA = a!.id;
    const [b] = await handle.db.insert(schema.team).values({ name: "sources-test-team-b" }).returning({ id: schema.team.id });
    teamB = b!.id;

    const [operatorUser] = await handle.db
      .insert(schema.user)
      .values({ teamId: teamA, email: `sources-op-${crypto.randomUUID()}@example.com`, role: "operator" })
      .returning({ id: schema.user.id });
    const [hunterUser] = await handle.db
      .insert(schema.user)
      .values({ teamId: teamA, email: `sources-hunter-${crypto.randomUUID()}@example.com`, role: "hunter" })
      .returning({ id: schema.user.id });
    const [teamBUser] = await handle.db
      .insert(schema.user)
      .values({ teamId: teamB, email: `sources-b-op-${crypto.randomUUID()}@example.com`, role: "operator" })
      .returning({ id: schema.user.id });

    operatorKey = `sk_test_${crypto.randomUUID().replaceAll("-", "")}`;
    await handle.db.insert(schema.apiKey).values({
      userId: operatorUser!.id,
      name: "operator",
      prefix: operatorKey.slice(0, 8),
      hash: await sha256Hex(operatorKey),
      scopes: ["sources:read", "sources:write"],
    });

    hunterKey = `sk_test_${crypto.randomUUID().replaceAll("-", "")}`;
    await handle.db.insert(schema.apiKey).values({
      userId: hunterUser!.id,
      name: "hunter",
      prefix: hunterKey.slice(0, 8),
      hash: await sha256Hex(hunterKey),
      scopes: ["sources:read", "sources:write"],
    });

    const teamBKeyToken = `sk_test_${crypto.randomUUID().replaceAll("-", "")}`;
    const [teamBKey] = await handle.db
      .insert(schema.apiKey)
      .values({
        userId: teamBUser!.id,
        name: "team-b",
        prefix: teamBKeyToken.slice(0, 8),
        hash: await sha256Hex(teamBKeyToken),
        scopes: ["ingest"],
      })
      .returning({ id: schema.apiKey.id });
    teamBKeyId = teamBKey!.id;

    // Same-team keys that are revoked or lack the `ingest` scope must not be
    // assignable either, matching what the dashboard's key picker filters.
    const revokedKeyToken = `sk_test_${crypto.randomUUID().replaceAll("-", "")}`;
    const [revokedKey] = await handle.db
      .insert(schema.apiKey)
      .values({
        userId: operatorUser!.id,
        name: "revoked",
        prefix: revokedKeyToken.slice(0, 8),
        hash: await sha256Hex(revokedKeyToken),
        scopes: ["ingest"],
        revokedAt: new Date(),
      })
      .returning({ id: schema.apiKey.id });
    revokedKeyId = revokedKey!.id;

    const noIngestScopeToken = `sk_test_${crypto.randomUUID().replaceAll("-", "")}`;
    const [noIngestScopeKey] = await handle.db
      .insert(schema.apiKey)
      .values({
        userId: operatorUser!.id,
        name: "no-ingest-scope",
        prefix: noIngestScopeToken.slice(0, 8),
        hash: await sha256Hex(noIngestScopeToken),
        scopes: ["sources:read"],
      })
      .returning({ id: schema.apiKey.id });
    noIngestScopeKeyId = noIngestScopeKey!.id;
  });

  afterAll(async () => {
    await handle.db.delete(schema.source).where(eq(schema.source.teamId, teamA));
    await handle.db.delete(schema.source).where(eq(schema.source.teamId, teamB));
    for (const teamId of [teamA, teamB]) {
      const users = await handle.db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.teamId, teamId));
      for (const u of users) {
        await handle.db.delete(schema.apiKey).where(eq(schema.apiKey.userId, u.id));
      }
      await handle.db.delete(schema.user).where(eq(schema.user.teamId, teamId));
    }
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamA));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamB));
    await handle.close();
  });

  test("POST rejects a non-operator key (403)", async () => {
    const app = createApp(handle);
    const res = await app.request("/api/sources", {
      method: "POST",
      headers: { Authorization: `Bearer ${hunterKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "web", platformId: "g1", name: "G1", url: "https://feeds.example.test/g1" }),
    });
    expect(res.status).toBe(403);
  });

  test("POST ignores a client-supplied teamId and uses the caller's team", async () => {
    const app = createApp(handle);
    const res = await app.request("/api/sources", {
      method: "POST",
      headers: { Authorization: `Bearer ${operatorKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        teamId: teamB, // must be ignored
        kind: "web",
        platformId: "g-spoofed",
        name: "Spoofed",
        url: "https://feeds.example.test/g-spoofed",
      }),
    });
    expect(res.status).toBe(201);
    const row = (await res.json()) as { teamId: string; id: string };
    expect(row.teamId).toBe(teamA);
  });

  test("POST rejects assignedKeyId belonging to a different team", async () => {
    const app = createApp(handle);
    const res = await app.request("/api/sources", {
      method: "POST",
      headers: { Authorization: `Bearer ${operatorKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "web",
        platformId: "g-cross-team",
        name: "Cross team",
        url: "https://feeds.example.test/g-cross-team",
        assignedKeyId: teamBKeyId,
      }),
    });
    expect(res.status).toBe(400);
  });

  test("POST rejects a revoked same-team assignedKeyId", async () => {
    const app = createApp(handle);
    const res = await app.request("/api/sources", {
      method: "POST",
      headers: { Authorization: `Bearer ${operatorKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "web",
        platformId: "g-revoked-key",
        name: "Revoked key",
        url: "https://feeds.example.test/g-revoked-key",
        assignedKeyId: revokedKeyId,
      }),
    });
    expect(res.status).toBe(400);
  });

  test("POST rejects a same-team assignedKeyId without the ingest scope", async () => {
    const app = createApp(handle);
    const res = await app.request("/api/sources", {
      method: "POST",
      headers: { Authorization: `Bearer ${operatorKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "web",
        platformId: "g-no-ingest-scope",
        name: "No ingest scope",
        url: "https://feeds.example.test/g-no-ingest-scope",
        assignedKeyId: noIngestScopeKeyId,
      }),
    });
    expect(res.status).toBe(400);
  });

  test("POST rejects a url that isn't an http(s) URL", async () => {
    const app = createApp(handle);
    const res = await app.request("/api/sources", {
      method: "POST",
      headers: { Authorization: `Bearer ${operatorKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "web",
        platformId: "g-bad-url",
        name: "Bad url",
        url: "ftp://feeds.example.test/g1",
      }),
    });
    expect(res.status).toBe(400);
  });

  test("PATCH rejects a non-http(s) url on a push source", async () => {
    const app = createApp(handle);
    const [source] = await handle.db
      .insert(schema.source)
      .values({
        teamId: teamA,
        kind: "push",
        platformId: "g-patch-url",
        name: "Patch url",
        url: "https://feeds.example.test/g-patch-url",
      })
      .returning({ id: schema.source.id });

    const res = await app.request("/api/sources", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${operatorKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: source!.id, url: "ftp://feeds.example.test/g-patch-url" }),
    });
    expect(res.status).toBe(400);
  });

  test("Web PATCH rejects a real key/url change, accepts null key and unchanged url", async () => {
    const app = createApp(handle);
    const webUrl = "https://feeds.example.test/v1/items?cat=2010&sort=new";
    const [source] = await handle.db
      .insert(schema.source)
      .values({ teamId: teamA, kind: "web", platformId: "feeds.example.test/v1/items", name: "web patch", url: webUrl })
      .returning({ id: schema.source.id });
    const patch = (body: Record<string, unknown>) =>
      app.request("/api/sources", {
        method: "PATCH",
        headers: { Authorization: `Bearer ${operatorKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ id: source!.id, ...body }),
      });
    for (const body of [{ assignedKeyId: teamBKeyId }, { url: "https://feeds.example.test/x" }]) {
      expect((await patch(body)).status).toBe(400);
    }
    const [unchanged] = await handle.db.select().from(schema.source).where(eq(schema.source.id, source!.id));
    expect(unchanged).toMatchObject({ url: webUrl, assignedKeyId: null, name: "web patch" });

    expect((await patch({ schedule: { x: 1 }, assignedKeyId: null })).status).toBe(200);
    const same = await patch({ url: webUrl });
    expect(same.status).toBe(200);
    expect(((await same.json()) as { assignedKeyId: string | null }).assignedKeyId).toBeNull();
    expect((await patch({ name: "renamed" })).status).toBe(200);
    const [after] = await handle.db.select().from(schema.source).where(eq(schema.source.id, source!.id));
    expect(after).toMatchObject({ url: webUrl, assignedKeyId: null, name: "renamed" });
  });

  test("PATCH on a source from another team returns 404 (no existence leak)", async () => {
    const app = createApp(handle);
    const [otherTeamSource] = await handle.db
      .insert(schema.source)
      .values({ teamId: teamB, kind: "web", platformId: "g-b", name: "Team B group", url: "https://feeds.example.test/g-b" })
      .returning({ id: schema.source.id });

    const res = await app.request("/api/sources", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${operatorKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: otherTeamSource!.id, name: "Renamed" }),
    });
    expect(res.status).toBe(404);
  });
});

// API: session-based pause/resume and
// pause / resume.
describe.skipIf(!canRun)("sources routes (session pause/resume)", () => {
  let handle: DbHandle;
  let teamId: string;
  let operatorEmail: string;
  let hunterEmail: string;
  let sourceId: string;
  let originalNodeEnv: string | undefined;
  let originalDevBypass: string | undefined;

  beforeAll(async () => {
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    originalDevBypass = process.env.DEV_AUTH_BYPASS;
    process.env.DEV_AUTH_BYPASS = "1"; // the bypass requires this explicit opt-in, not just NODE_ENV
    handle = createDb(TEST_DATABASE_URL);

    const [team] = await handle.db.insert(schema.team).values({ name: "sources-session-test-team" }).returning({ id: schema.team.id });
    teamId = team!.id;
    operatorEmail = `sources-session-op-${crypto.randomUUID()}@example.com`;
    hunterEmail = `sources-session-hunter-${crypto.randomUUID()}@example.com`;
    await handle.db.insert(schema.user).values({ teamId, email: operatorEmail, role: "operator" });
    await handle.db.insert(schema.user).values({ teamId, email: hunterEmail, role: "hunter" });

    const [source] = await handle.db
      .insert(schema.source)
      .values({
        teamId,
        kind: "web",
        platformId: "session-pause-test",
        name: "Session pause test",
        url: "https://feeds.example.test/session-pause-test",
        status: "paused",
        health: { ok: false, reason: "blocked" },
      })
      .returning({ id: schema.source.id });
    sourceId = source!.id;
  });

  afterAll(async () => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.DEV_AUTH_BYPASS = originalDevBypass;
    await handle.db.delete(schema.source).where(eq(schema.source.teamId, teamId));
    await handle.db.delete(schema.user).where(eq(schema.user.teamId, teamId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("F-8: session add-by-URL normalises the feed url (fragment dropped, host lower-cased) so duplicates give 409", async () => {
    const app = createApp(handle, undefined, { webHttp: fakeFeedHttp(RSS_BODY) });
    const slug = `f8-${crypto.randomUUID().slice(0, 8)}`;
    const platformId = `feed:https://feeds.example.test/${slug}?ref=share`;
    const post = (url: string) =>
      app.request("/api/sources", {
        method: "POST",
        headers: { "X-Dev-User": operatorEmail, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "F8", url }),
      });
    const first = await post(`https://Feeds.Example.test/${slug}?ref=share#top`);
    expect(first.status).toBe(201);
    const [row] = await handle.db.select().from(schema.source).where(eq(schema.source.platformId, platformId));
    expect(row?.url).toBe(`https://feeds.example.test/${slug}?ref=share`);
    expect((await post(`https://feeds.example.test/${slug}?ref=share`)).status).toBe(409);
    if (row) await handle.db.delete(schema.source).where(eq(schema.source.id, row.id));
  });

  test("operator pause then resume a source via session flips status and clears health.reason", async () => {
    const app = createApp(handle);
    const pauseRes = await app.request(`/api/sources/${sourceId}/pause`, { method: "POST", headers: { "X-Dev-User": operatorEmail } });
    expect(pauseRes.status).toBe(200);
    const paused = (await pauseRes.json()) as { status: string };
    expect(paused.status).toBe("paused");

    const resumeRes = await app.request(`/api/sources/${sourceId}/resume`, { method: "POST", headers: { "X-Dev-User": operatorEmail } });
    expect(resumeRes.status).toBe(200);
    const resumed = (await resumeRes.json()) as { status: string; health: { reason: string | null } };
    expect(resumed.status).toBe("active");
    expect(resumed.health.reason).toBeNull();
  });

  // API half: `withHealth` maps a never-visited source
  // (health `{}` — no ok, no reason) to `ok: null` (neutral), while a source
  // with `ok: false` and a reason stays `ok: false` (degraded).
  test("Health {} maps to ok:null; ok:false with a reason stays false", async () => {
    const app = createApp(handle);
    const [neutralSource] = await handle.db
      .insert(schema.source)
      .values({
        teamId,
        kind: "web",
        platformId: "health-neutral",
        name: "Health neutral",
        url: "https://feeds.example.test/health-neutral",
        health: {},
      })
      .returning({ id: schema.source.id });
    const [degradedSource] = await handle.db
      .insert(schema.source)
      .values({
        teamId,
        kind: "web",
        platformId: "health-degraded",
        name: "Health degraded",
        url: "https://feeds.example.test/health-degraded",
        health: { ok: false, reason: "blocked" },
      })
      .returning({ id: schema.source.id });

    const res = await app.request("/api/sources", { headers: { "X-Dev-User": operatorEmail } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sources: { id: string; health: { ok: boolean | null; reason: string | null } }[] };
    const neutral = body.sources.find((s) => s.id === neutralSource!.id)!;
    expect(neutral.health.ok).toBeNull();
    expect(neutral.health.reason).toBeNull();

    const degraded = body.sources.find((s) => s.id === degradedSource!.id)!;
    expect(degraded.health.ok).toBe(false);
    expect(degraded.health.reason).toBe("blocked");
  });

  test("CoveragePct = round(100 * ok/expected) over the last 24h; lastOkVisitAt set; no rows -> null", async () => {
    const app = createApp(handle);

    const [coveredSource] = await handle.db
      .insert(schema.source)
      .values({
        teamId,
        kind: "web",
        platformId: `coverage-${crypto.randomUUID()}`,
        name: "Coverage source",
        url: `https://feeds.example.test/coverage-${crypto.randomUUID()}`,
        lastOkVisitAt: new Date(),
      })
      .returning({ id: schema.source.id });
    const [noRowsSource] = await handle.db
      .insert(schema.source)
      .values({
        teamId,
        kind: "web",
        platformId: `no-coverage-${crypto.randomUUID()}`,
        name: "No coverage rows",
        url: `https://feeds.example.test/no-coverage-${crypto.randomUUID()}`,
      })
      .returning({ id: schema.source.id });

    const ts = new Date();
    ts.setUTCMinutes(0, 0, 0);
    const rows = [
      { expected: 6, ok: 5 },
      { expected: 4, ok: 3 },
    ];
    for (const [i, r] of rows.entries()) {
      const hourTs = new Date(ts.getTime() - i * 3_600_000);
      await handle.db.insert(schema.metricRollup).values({
        bucket: "hour",
        ts: hourTs,
        dims: { metric: "coverage", sourceId: coveredSource!.id },
        counts: { visits_expected: r.expected, visits_ok: r.ok, visits_complete: 0, posts_new: 0 },
      });
    }

    try {
      const res = await app.request("/api/sources", { headers: { "X-Dev-User": operatorEmail } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { sources: { id: string; health: { coveragePct: number | null; lastOkVisitAt: string | null } }[] };

      const covered = body.sources.find((s) => s.id === coveredSource!.id)!;
      expect(covered.health.coveragePct).toBe(80); // round(100 * 8/10)
      expect(covered.health.lastOkVisitAt).not.toBeNull();

      const noRows = body.sources.find((s) => s.id === noRowsSource!.id)!;
      expect(noRows.health.coveragePct).toBeNull();
    } finally {
      await handle.sql`delete from metric_rollup where dims->>'sourceId' in (${coveredSource!.id}, ${noRowsSource!.id})`;
    }
  });
});

// API: source defaults validation.
describe.skipIf(!canRun)("sources routes defaults", () => {
  let handle: DbHandle;
  let teamId: string;
  let operatorEmail: string;
  let sourceId: string;
  let carsId: string;
  let originalNodeEnv: string | undefined;
  let originalDevBypass: string | undefined;

  async function patch(body: unknown): Promise<Response> {
    return createApp(handle).request(`/api/sources/${sourceId}`, {
      method: "PATCH",
      headers: { "X-Dev-User": operatorEmail, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  beforeAll(async () => {
    originalNodeEnv = process.env.NODE_ENV;
    originalDevBypass = process.env.DEV_AUTH_BYPASS;
    process.env.NODE_ENV = "development";
    process.env.DEV_AUTH_BYPASS = "1";
    handle = createDb(TEST_DATABASE_URL);
    const [seeded] = await handle.sql<{ n: number }[]>`select count(*)::int as n from category where slug = 'cars' and attribute_schema <> '[]'::jsonb`;
    if (!seeded?.n) await seedTaxonomyAndCatalogue(TEST_DATABASE_URL);
    const [cars] = await handle.sql<{ id: string }[]>`select id from category where slug = 'cars'`;
    carsId = cars!.id;
    const [team] = await handle.db.insert(schema.team).values({ name: "sources-defaults-test-team" }).returning({ id: schema.team.id });
    teamId = team!.id;
    operatorEmail = `sources-defaults-op-${crypto.randomUUID()}@example.com`;
    await handle.db.insert(schema.user).values({ teamId, email: operatorEmail, role: "operator" });
    const [source] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: "defaults-test", name: "Defaults test", url: "https://feeds.example.test/defaults-test" })
      .returning({ id: schema.source.id });
    sourceId = source!.id;
  }, 120_000);

  afterAll(async () => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.DEV_AUTH_BYPASS = originalDevBypass;
    await handle.db.delete(schema.source).where(eq(schema.source.teamId, teamId));
    await handle.db.delete(schema.user).where(eq(schema.user.teamId, teamId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("(a) region HCM is stored canonical; (b) unknown key and (c) invalid value -> 422 with the field", async () => {
    const a = await patch({ defaults: { region: "HCM" } });
    expect(a.status).toBe(200);
    expect(((await a.json()) as { defaults: unknown }).defaults).toEqual({ region: "hcm" });

    const b = await patch({ defaults: { foo: 1 } });
    expect(b.status).toBe(422);
    expect(((await b.json()) as { field: string }).field).toBe("defaults.foo");

    const c = await patch({ defaults: { region: "atlantis" } });
    expect(c.status).toBe(422);
    expect(((await c.json()) as { field: string }).field).toBe("defaults.region");

    const [row] = await handle.db.select({ defaults: schema.source.defaults }).from(schema.source).where(eq(schema.source.id, sourceId));
    expect(row?.defaults).toEqual({ region: "hcm" });
  });

  test("categoryId default must name an existing category; GET /api/sources returns defaults", async () => {
    const bad = await patch({ defaults: { categoryId: crypto.randomUUID() } });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { field: string }).field).toBe("defaults.categoryId");

    const ok = await patch({ defaults: { region: "hcm", categoryId: carsId } });
    expect(ok.status).toBe(200);

    const list = await createApp(handle).request("/api/sources", { headers: { "X-Dev-User": operatorEmail } });
    const { sources } = (await list.json()) as { sources: { id: string; defaults: unknown }[] };
    expect(sources.find((s) => s.id === sourceId)?.defaults).toEqual({ region: "hcm", categoryId: carsId });
  });
});

// session POST /api/sources half: no key -> null, explicit key wins.
describe.skipIf(!canRun)("session source create auto-assign", () => {
  let handle: DbHandle;
  let teamId: string;
  let userId: string;
  let email: string;
  let explicitKeyId: string;
  const prev = { env: process.env.NODE_ENV, bypass: process.env.DEV_AUTH_BYPASS };
  const post = (slug: string, extra: Record<string, unknown> = {}) =>
    createApp(handle, undefined, { webHttp: fakeFeedHttp(RSS_BODY) }).request("/api/sources", {
      method: "POST",
      headers: { "X-Dev-User": email, "Content-Type": "application/json" },
      body: JSON.stringify({ url: `https://feeds.example.test/${slug}`, ...extra }),
    });
  const mkKey = async (): Promise<string> => {
    const [k] = await handle.db.insert(schema.apiKey).values({ userId, name: "aa", prefix: "sk_aa", hash: crypto.randomUUID(), scopes: ["ingest"] }).returning({ id: schema.apiKey.id });
    return k!.id;
  };

  beforeAll(async () => {
    process.env.NODE_ENV = "development";
    process.env.DEV_AUTH_BYPASS = "1";
    handle = createDb(TEST_DATABASE_URL);
    const [team] = await handle.db.insert(schema.team).values({ name: `aa-${crypto.randomUUID()}` }).returning({ id: schema.team.id });
    teamId = team!.id;
    email = `aa-${crypto.randomUUID()}@example.com`;
    const [u] = await handle.db.insert(schema.user).values({ teamId, email, role: "operator" }).returning({ id: schema.user.id });
    userId = u!.id;
    explicitKeyId = await mkKey();
  });

  afterAll(async () => {
    process.env.NODE_ENV = prev.env;
    process.env.DEV_AUTH_BYPASS = prev.bypass;
    await handle.db.delete(schema.source).where(eq(schema.source.teamId, teamId));
    await handle.db.delete(schema.apiKey).where(eq(schema.apiKey.userId, userId));
    await handle.db.delete(schema.user).where(eq(schema.user.teamId, teamId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("no key -> 201 with assignedKeyId null and kind web; explicit key wins; explicit null stays null", async () => {
    const slug = `aa-none-${crypto.randomUUID().slice(0, 8)}`;
    const none = await post(slug);
    expect(none.status).toBe(201);
    const noneBody = (await none.json()) as { assignedKeyId: string | null; kind: string; platformId: string; schedule: unknown };
    expect(noneBody.assignedKeyId).toBeNull();
    expect(noneBody.kind).toBe("web");
    expect(noneBody.platformId).toBe(`feed:https://feeds.example.test/${slug}`);
    expect(noneBody.schedule).toEqual({});

    const explicit = await post(`aa-exp-${crypto.randomUUID().slice(0, 8)}`, { assignedKeyId: explicitKeyId });
    expect(((await explicit.json()) as { assignedKeyId: string | null }).assignedKeyId).toBe(explicitKeyId);

    const nulled = await post(`aa-null-${crypto.randomUUID().slice(0, 8)}`, { assignedKeyId: null });
    expect(nulled.status).toBe(201);
    expect(((await nulled.json()) as { assignedKeyId: string | null }).assignedKeyId).toBeNull();
  });
});
