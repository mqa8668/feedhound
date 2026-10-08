import { createDb, schema, type DbHandle } from "@feedhound/db";
import { ALLOWED_LABELS, METRICS_CONTENT_TYPE } from "@feedhound/core/metrics";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { createApp } from "../index";
import { routePattern } from "./metrics";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const MUST_RUN = Boolean(process.env.CI) || Boolean(TEST_DATABASE_URL);

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
    console.warn(`metrics.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
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
  throw new Error("metrics.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("metrics.test.ts: skipped — TEST_DATABASE_URL is unset");
}

describe.skipIf(!canRun)("api /metrics + /api/ops/slo", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  let handle: DbHandle;
  let originalNodeEnv: string | undefined;
  let originalDevBypass: string | undefined;
  const teamIds: string[] = [];
  const emails: Record<"A" | "B", string> = { A: `slo-a-${suffix}@example.com`, B: `slo-b-${suffix}@example.com` };
  const sourceIds: Record<"A" | "B", string> = { A: "", B: "" };

  beforeAll(async () => {
    originalNodeEnv = process.env.NODE_ENV;
    originalDevBypass = process.env.DEV_AUTH_BYPASS;
    process.env.NODE_ENV = "development";
    process.env.DEV_AUTH_BYPASS = "1";
    handle = createDb(TEST_DATABASE_URL);
    for (const k of ["A", "B"] as const) {
      const [team] = await handle.db.insert(schema.team).values({ name: `slo-route-${k}-${suffix}` }).returning({ id: schema.team.id });
      teamIds.push(team!.id);
      await handle.db.insert(schema.user).values({ teamId: team!.id, email: emails[k], role: "hunter" });
      const [src] = await handle.db
        .insert(schema.source)
        .values({ teamId: team!.id, kind: "web", platformId: `slo-route-${k}-${suffix}`, name: `slo-route-${k}-${suffix}`, url: `https://example.com/${k}-${suffix}` })
        .returning({ id: schema.source.id });
      sourceIds[k] = src!.id;
    }
  });

  afterAll(async () => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalDevBypass === undefined) delete process.env.DEV_AUTH_BYPASS;
    else process.env.DEV_AUTH_BYPASS = originalDevBypass;
    await handle.db.delete(schema.source).where(inArray(schema.source.teamId, teamIds));
    await handle.db.delete(schema.user).where(inArray(schema.user.teamId, teamIds));
    for (const id of teamIds) await handle.db.delete(schema.team).where(eq(schema.team.id, id));
    await handle.close();
  });

  test("http_requests_total uses matched route patterns, never raw paths", async () => {
    const app = createApp(handle);
    await app.request("/healthz");
    await app.request("/healthz");
    const uuid = crypto.randomUUID();
    await app.request(`/api/sources/${uuid}/visits`);
    for (let i = 0; i < 3; i++) await app.request(`/nope/${crypto.randomUUID()}`);

    const res = await app.request("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(METRICS_CONTENT_TYPE);
    const body = await res.text();
    expect(body).toContain('http_requests_total{route="/healthz",status="200"} 2');
    expect(body).toMatch(/http_requests_total\{route="\/api\/sources\/:id\/visits",status="\d+"\} 1/);
    expect(body).toContain('http_requests_total{route="unmatched",status="404"} 3');
    const routeLabels = [...body.matchAll(/route="([^"]*)"/g)].map((m) => m[1]!);
    for (const r of routeLabels) {
      expect(r).not.toContain(uuid);
      expect(r).not.toContain("/nope/");
    }
  });

  test("/api/ops/slo returns only the session team's sources; 401 without a session", async () => {
    const app = createApp(handle);
    const res = await app.request("/api/ops/slo", { headers: { "X-Dev-User": emails.A } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { targets: unknown; sources: { sourceId: string }[] };
    expect(body.targets).toEqual({ coverageOk: 0.98, coverageComplete: 0.95, windowHours: 24 });
    expect(body.sources.map((s) => s.sourceId)).toEqual([sourceIds.A]);
    expect((await app.request("/api/ops/slo")).status).toBe(401);
  });

  test("Infra files match the emitted metrics", async () => {
    const root = resolve(import.meta.dir, "../../../..");
    const prom = Bun.YAML.parse(readFileSync(resolve(root, "infra/metrics/prometheus.yml"), "utf8")) as {
      scrape_configs: { job_name: string; metrics_path: string; static_configs: { targets: string[] }[] }[];
    };
    const jobs = prom.scrape_configs.map((j) => [j.job_name, j.metrics_path, j.static_configs[0]!.targets[0]]);
    expect(jobs).toEqual([
      ["api", "/metrics", "api:4820"],
      ["agent", "/metrics", "agent:4821"],
      ["bot", "/metrics", "bot:4822"],
    ]);
    const compose = readFileSync(resolve(root, "docker-compose.yml"), "utf8");
    for (const svc of ["api", "agent", "bot"]) expect(compose).toMatch(new RegExp(`^  ${svc}:`, "m"));

    // Defined metrics: api via its rendered TYPE lines; agent + bot by reading their definitions
    // (a cross-package import would break the api tsconfig rootDir; their own tests cover runtime output).
    const apiBody = await (await createApp(handle).request("/metrics")).text();
    const defined = new Set([...apiBody.matchAll(/^# TYPE (\S+) /gm)].map((m) => m[1]!));
    for (const file of ["apps/agent/src/metrics.ts", "apps/bot/src/index.ts"]) {
      const src = readFileSync(resolve(root, file), "utf8");
      for (const m of src.matchAll(/\.(?:gauge|counter)\(\s*"([^"]+)",\s*"[^"]*",\s*\[([^\]]*)\]/g)) {
        defined.add(m[1]!);
        for (const l of [...m[2]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!)) expect((ALLOWED_LABELS as readonly string[]).includes(l)).toBe(true);
      }
    }
    expect(defined.has("source_coverage_ratio")).toBe(true);
    expect(defined.has("pgboss_jobs")).toBe(true);
    expect(defined.has("bot_poll_errors_total")).toBe(true);

    const dash = JSON.parse(readFileSync(resolve(root, "infra/metrics/dashboards/feedhound-overview.json"), "utf8")) as {
      panels: { targets: { expr: string }[] }[];
    };
    const words = new Set(["rate", "sum", "avg", "max", "min", "increase"]);
    for (const panel of dash.panels) {
      for (const { expr } of panel.targets) {
        const stripped = expr.replace(/"[^"]*"/g, "").replace(/\{[^}]*\}/g, "").replace(/\[[^\]]*\]/g, "").replace(/\bby\s*\([^)]*\)/g, "");
        for (const tok of stripped.match(/[a-zA-Z_:][a-zA-Z0-9_:]*/g) ?? []) {
          if (words.has(tok) || tok === "up") continue;
          expect(defined.has(tok)).toBe(true);
        }
      }
    }
  });
});

describe("routePattern", () => {
  test("a literal route registered before a :param sibling is reported as the literal", async () => {
    const seen: string[] = [];
    const app = new Hono();
    app.use(async (c, next) => {
      await next();
      seen.push(routePattern(c.req.matchedRoutes));
    });
    app.get("/api/things/special", (c) => c.text("special"));
    app.get("/api/things/:id", (c) => c.text("by id"));
    await app.request("/api/things/special");
    await app.request("/api/things/42");
    await app.request("/elsewhere");
    expect(seen).toEqual(["/api/things/special", "/api/things/:id", "unmatched"]);
  });
});
