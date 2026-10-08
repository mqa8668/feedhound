import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { resolveOpsUserId, runOpsAlerts } from "./ops-alerts";

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
    console.warn(`ops-alerts.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
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
  throw new Error("ops-alerts.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("ops-alerts.test.ts: skipped — TEST_DATABASE_URL is unset");
}

describe.skipIf(!canRun)("runOpsAlerts (integration)", () => {
  let handle: DbHandle;
  let teamId: string;
  let userId: string;

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    const [team] = await handle.db.insert(schema.team).values({ name: "ops-alerts-test-team" }).returning({ id: schema.team.id });
    teamId = team!.id;
    const [user] = await handle.db
      .insert(schema.user)
      .values({ teamId, email: `ops-alerts-test-${crypto.randomUUID()}@example.com` })
      .returning({ id: schema.user.id });
    userId = user!.id;
  });

  afterAll(async () => {
    await handle.db.delete(schema.notification).where(eq(schema.notification.userId, userId));
    await handle.db.delete(schema.user).where(eq(schema.user.id, userId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("queue_backlog fires once across three runs in 15 min", async () => {
    const base = new Date("2026-01-01T00:00:00Z");
    for (const minutesOffset of [0, 5, 15]) {
      await runOpsAlerts({
        handle,
        opsUserId: userId,
        now: new Date(base.getTime() + minutesOffset * 60_000),
        countPendingJobs: async () => 600,
      });
    }

    const rows = await handle.db.select().from(schema.notification).where(eq(schema.notification.userId, userId));
    const queueBacklogRows = rows.filter((r) => (r.payload as { rule?: string }).rule === "queue_backlog");
    expect(queueBacklogRows).toHaveLength(1);
  });

  test("llm_budget fires when spend >= 80% of daily budget", async () => {
    const now = new Date("2026-01-02T00:00:00Z");
    const fired = await runOpsAlerts({
      handle,
      opsUserId: userId,
      now,
      getLlmBudget: async () => ({ spendUsd: 8, budgetUsd: 10 }),
    });
    expect(fired).toEqual(["llm_budget"]);

    const secondFired = await runOpsAlerts({
      handle,
      opsUserId: userId,
      now: new Date(now.getTime() + 60_000),
      getLlmBudget: async () => ({ spendUsd: 8, budgetUsd: 10 }),
    });
    expect(secondFired).toEqual([]);
  });

  test("no rule fires when thresholds are not met", async () => {
    const fired = await runOpsAlerts({
      handle,
      opsUserId: userId,
      now: new Date("2026-01-03T00:00:00Z"),
      countPendingJobs: async () => 10,
      getLlmBudget: async () => ({ spendUsd: 1, budgetUsd: 10 }),
    });
    expect(fired).toEqual([]);
  });
});

describe.skipIf(!canRun)("resolveOpsUserId (integration)", () => {
  const KEY = "notify.ops.recipientEmail";
  const tag = crypto.randomUUID().slice(0, 8);
  let handle: DbHandle;
  let teamId: string;
  let oldOp: string;
  let newOp: string;
  let hunter: string;
  let newEmail: string;
  let hunterEmail: string;
  let baseVersion = 0;
  const savedSeedEmail = process.env.SEED_OPERATOR_EMAIL;

  async function setRecipient(value: string): Promise<void> {
    const [latest] = await handle.db.select({ v: schema.config.version }).from(schema.config).where(eq(schema.config.key, KEY)).orderBy(desc(schema.config.version)).limit(1);
    await handle.db.insert(schema.config).values({ key: KEY, version: (latest?.v ?? 0) + 1, value, updatedBy: "test-ops-recipient" });
  }

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    const [latest] = await handle.db.select({ v: schema.config.version }).from(schema.config).where(eq(schema.config.key, KEY)).orderBy(desc(schema.config.version)).limit(1);
    baseVersion = latest?.v ?? 0;
    const [team] = await handle.db.insert(schema.team).values({ name: `ops-recipient-${tag}` }).returning({ id: schema.team.id });
    teamId = team!.id;
    newEmail = `ops-new-${tag}@example.test`;
    hunterEmail = `ops-hunter-${tag}@example.test`;
    const mk = async (email: string, role: "operator" | "hunter", createdAt: Date): Promise<string> => {
      const [u] = await handle.db.insert(schema.user).values({ teamId, email, role, createdAt }).returning({ id: schema.user.id });
      return u!.id;
    };
    oldOp = await mk(`ops-old-${tag}@example.test`, "operator", new Date("1990-01-01T00:00:00Z"));
    newOp = await mk(newEmail, "operator", new Date("1990-01-02T00:00:00Z"));
    hunter = await mk(hunterEmail, "hunter", new Date("1989-01-01T00:00:00Z"));
    delete process.env.SEED_OPERATOR_EMAIL;
  });

  afterAll(async () => {
    if (savedSeedEmail === undefined) delete process.env.SEED_OPERATOR_EMAIL;
    else process.env.SEED_OPERATOR_EMAIL = savedSeedEmail;
    await handle.db.delete(schema.config).where(and(eq(schema.config.key, KEY), gt(schema.config.version, baseVersion)));
    await handle.db.delete(schema.user).where(inArray(schema.user.id, [oldOp, newOp, hunter]));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("unset/empty/unknown/non-operator recipient -> oldest operator (never the newest)", async () => {
    await setRecipient("");
    expect(await resolveOpsUserId(handle)).toBe(oldOp);
    await setRecipient(`nobody-${tag}@example.test`);
    expect(await resolveOpsUserId(handle)).toBe(oldOp);
    await setRecipient(hunterEmail);
    expect(await resolveOpsUserId(handle)).toBe(oldOp);
  });

  test("Config recipientEmail names the operator; SEED_OPERATOR_EMAIL is the fallback", async () => {
    await setRecipient(newEmail);
    expect(await resolveOpsUserId(handle)).toBe(newOp);
    await setRecipient("");
    process.env.SEED_OPERATOR_EMAIL = newEmail;
    expect(await resolveOpsUserId(handle)).toBe(newOp);
  });
});
