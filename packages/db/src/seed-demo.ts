import { and, desc, eq } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import { createDb } from "./index";
import { config, source, team, user, watch } from "./schema/index";
import type * as schema from "./schema/index";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = PgTransaction<any, typeof schema, any>;

export const DEMO_TEAM_NAME = "Default Team";
export const DEMO_OPERATOR_EMAIL = "operator@feedhound.local";
export const DEMO_FEED_BASE = "http://demo-feeds:8080";
export const HN_FEED_URL = "https://hnrss.org/newest?q=self-hosted";

export interface DemoSeedOptions {
  /** Skip the internet-facing source (hnrss.org) so the demo works with no network. */
  offline?: boolean;
  /** Base URL of the fixture server as seen by the agent. */
  feedBase?: string;
  operatorEmail?: string;
}

export interface DemoSeedResult {
  sources: number;
  watches: number;
}

/** Demo-only config. `web.allowPrivateHosts` lets the agent reach the compose-internal fixture host. */
export const DEMO_CONFIG: Readonly<Record<string, unknown>> = {
  /** Marker read by the api at boot: the published demo password hash is accepted in production only when this is true. */
  "demo.enabled": true,
  "web.enabled": true,
  "web.allowPrivateHosts": true,
  "web.pollIntervalSec": 60,
  "web.minRequestGapMs": 1000,
  "match.reloadIntervalSec": 15,
};

interface DemoWatch {
  name: string;
  include?: string[];
  includeAll?: string[];
  exclude?: string[];
  priceMax?: number;
}

export const DEMO_WATCHES: readonly DemoWatch[] = [
  // Price filters read VND amounts; the fixture quotes "8.900.000 VND" for the matching item.
  { name: "GPU under budget", include: ["rtx 4070", "rtx 4060", "rx 7800 xt"], exclude: ["sealed"], priceMax: 10_000_000 },
  { name: "NAS / Synology", include: ["synology", "nas", "qnap"] },
  { name: "self-hosted", include: ["self-hosted", "self hosted", "homelab"] },
];

function demoSources(opts: Required<Pick<DemoSeedOptions, "offline" | "feedBase">>): { name: string; url: string }[] {
  const base = opts.feedBase.replace(/\/+$/, "");
  const list = [
    { name: "Demo Deals (RSS)", url: `${base}/deals.xml` },
    { name: "Demo Homelab (Atom)", url: `${base}/homelab.atom` },
  ];
  if (!opts.offline) list.push({ name: "Hacker News: self-hosted", url: HN_FEED_URL });
  return list;
}

/**
 * Idempotent demo data: team, operator, feed sources, watches and web.* config.
 * Re-running leaves row counts unchanged (config only gains a version when a value differs).
 */
export async function seedDemo(databaseUrl?: string, opts: DemoSeedOptions = {}): Promise<DemoSeedResult> {
  const offline = opts.offline ?? false;
  const feedBase = opts.feedBase ?? DEMO_FEED_BASE;
  const email = opts.operatorEmail ?? DEMO_OPERATOR_EMAIL;
  const handle = createDb(databaseUrl);
  try {
    return await handle.db.transaction(async (tx) => {
      const teamId = await ensureTeam(tx);
      const userId = await ensureOperator(tx, teamId, email);
      await setDemoConfig(tx);
      const sources = demoSources({ offline, feedBase });
      for (const s of sources) await ensureSource(tx, teamId, s.name, s.url);
      for (const w of DEMO_WATCHES) await ensureWatch(tx, userId, w);
      return { sources: sources.length, watches: DEMO_WATCHES.length };
    });
  } finally {
    await handle.close();
  }
}

async function ensureTeam(tx: Tx): Promise<string> {
  const [existing] = await tx.select({ id: team.id }).from(team).where(eq(team.name, DEMO_TEAM_NAME)).limit(1);
  if (existing) return existing.id;
  const [row] = await tx.insert(team).values({ name: DEMO_TEAM_NAME, settings: {} }).returning({ id: team.id });
  if (!row) throw new Error("seed-demo: failed to insert team");
  return row.id;
}

async function ensureOperator(tx: Tx, teamId: string, email: string): Promise<string> {
  await tx.insert(user).values({ teamId, email, role: "operator" }).onConflictDoNothing({ target: user.email });
  const [row] = await tx.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
  if (!row) throw new Error("seed-demo: operator missing");
  return row.id;
}

async function setDemoConfig(tx: Tx): Promise<void> {
  for (const [key, value] of Object.entries(DEMO_CONFIG)) {
    const [cur] = await tx.select({ version: config.version, value: config.value }).from(config).where(eq(config.key, key)).orderBy(desc(config.version)).limit(1);
    if (cur && JSON.stringify(cur.value) === JSON.stringify(value)) continue;
    await tx.insert(config).values({ key, version: (cur?.version ?? 0) + 1, value, updatedBy: "demo-seed" }).onConflictDoNothing();
  }
}

async function ensureSource(tx: Tx, teamId: string, name: string, url: string): Promise<void> {
  const platformId = `feed:${url}`;
  const [existing] = await tx
    .select({ id: source.id })
    .from(source)
    .where(and(eq(source.teamId, teamId), eq(source.platformId, platformId)))
    .limit(1);
  if (existing) return;
  await tx.insert(source).values({ teamId, kind: "web", platformId, name, url, defaults: {}, assignedKeyId: null });
}

async function ensureWatch(tx: Tx, userId: string, w: DemoWatch): Promise<void> {
  const values = {
    include: w.include ?? [],
    includeAll: w.includeAll ?? [],
    exclude: w.exclude ?? [],
    priceMax: w.priceMax ?? null,
    enabled: true,
  };
  const [existing] = await tx.select({ id: watch.id }).from(watch).where(and(eq(watch.userId, userId), eq(watch.name, w.name))).limit(1);
  if (existing) await tx.update(watch).set(values).where(eq(watch.id, existing.id));
  else await tx.insert(watch).values({ userId, name: w.name, ...values });
}

if (import.meta.main) {
  const r = await seedDemo(undefined, {
    offline: ["1", "true", "yes"].includes((process.env.DEMO_OFFLINE ?? "").toLowerCase()),
    feedBase: process.env.DEMO_FEED_BASE || undefined,
    operatorEmail: process.env.SEED_OPERATOR_EMAIL || undefined,
  });
  console.log(`seed-demo: done (${r.sources} sources, ${r.watches} watches)`);
}
