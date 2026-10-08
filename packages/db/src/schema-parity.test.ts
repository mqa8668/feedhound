import { afterAll, describe, expect, test } from "bun:test";
import type postgres from "postgres";
import { createDb } from "./index";
import { diffObjects, dbObjects, drizzleObjects, type TableObjects } from "./schema-parity";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const MUST_RUN = Boolean(process.env.CI) || Boolean(TEST_DATABASE_URL);

if (TEST_DATABASE_URL && !new URL(TEST_DATABASE_URL).pathname.replace(/^\//, "").endsWith("_test")) {
  throw new Error("TEST_DATABASE_URL must point at a database whose name ends in '_test'");
}

const fx = (indexes: string[]): Record<string, TableObjects> => ({
  t: { indexes, checks: [], uniques: [], fks: [] },
});

describe("diffObjects (pure)", () => {
  test("one differing index name yields exactly one entry naming it", () => {
    const d = diffObjects(fx(["a_idx", "b_idx"]), fx(["a_idx", "c_idx"]));
    expect(d).toHaveLength(2); // b_idx only in first, c_idx only in second
    expect(d.some((l) => l.includes("b_idx"))).toBe(true);
    expect(diffObjects(fx(["a_idx"]), fx(["a_idx", "c_idx"]))).toEqual(["t.indexes: c_idx only in second"]);
  });

  test("identical fixtures are at parity", () => {
    expect(diffObjects(fx(["a"]), fx(["a"]))).toEqual([]);
  });
});

const dbDescribe = TEST_DATABASE_URL || MUST_RUN ? describe : describe.skip;

dbDescribe("schema parity + CHECK constraints (migrated test DB)", () => {
  if (!TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is required (CI or explicit)");
  const h = createDb(TEST_DATABASE_URL);
  afterAll(async () => {
    await h.close();
  });

  test("Drizzle declarations match the migrated DB", async () => {
    const dbo = await dbObjects(h);
    expect(diffObjects(drizzleObjects(), dbo)).toEqual([]);
    expect(dbo.post?.indexes).toContain("post_tsv_idx");
    expect(dbo.metric_rollup?.indexes).toContain("metric_rollup_bucket_ts_dims_key");
    expect(dbo.notification?.indexes).toContain("notification_ops_dedupe_key_unique");
    expect(dbo.notification?.fks.find((f) => f.name === "notification_match_id_match_id_fk")?.onDelete).toBe("cascade");
  });

  class Rollback extends Error {}
  async function inTx(fn: (tx: postgres.TransactionSql) => Promise<void>): Promise<void> {
    try {
      await h.sql.begin(async (tx) => {
        await fn(tx);
        throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
  }
  async function seedTeamUser(tx: postgres.TransactionSql): Promise<{ teamId: string; userId: string }> {
    const email = `p019-${crypto.randomUUID()}@example.test`;
    const [t] = await tx<{ id: string }[]>`insert into team (name) values ('p019') returning id`;
    const [u] = await tx<{ id: string }[]>`insert into "user" (team_id, email, role) values (${t!.id}, ${email}, 'hunter') returning id`;
    return { teamId: t!.id, userId: u!.id };
  }
  async function violation(fn: (tx: postgres.TransactionSql) => Promise<void>): Promise<{ code?: string; constraint?: string }> {
    try {
      await inTx(fn);
    } catch (e) {
      const err = e as { code?: string; constraint_name?: string };
      return { code: err.code, constraint: err.constraint_name };
    }
    return {};
  }

  test("Invalid enum-like values are rejected with <table>_<col>_check", async () => {
    const bad = async (name: string, fn: (tx: postgres.TransactionSql) => Promise<void>) => {
      expect(await violation(fn)).toEqual({ code: "23514", constraint: name });
    };
    await bad("source_status_check", async (tx) => {
      const { teamId } = await seedTeamUser(tx);
      await tx`insert into source (team_id, kind, platform_id, name, url, status) values (${teamId}, 'web', 'p', 'n', 'u', 'bogus')`;
    });
    await bad("source_kind_check", async (tx) => {
      const { teamId } = await seedTeamUser(tx);
      await tx`insert into source (team_id, kind, platform_id, name, url) values (${teamId}, 'myspace', 'p', 'n', 'u')`;
    });
    await bad("notification_status_check", async (tx) => {
      const { userId } = await seedTeamUser(tx);
      await tx`insert into notification (user_id, channel, status) values (${userId}, 'ops', 'bogus')`;
    });
    await bad("user_role_check", async (tx) => {
      const { teamId } = await seedTeamUser(tx);
      await tx`insert into "user" (team_id, email, role) values (${teamId}, ${`p019-${crypto.randomUUID()}@example.test`}, 'admin')`;
    });
    await bad("enrichment_intent_check", async (tx) => {
      const { teamId } = await seedTeamUser(tx);
      const [s] = await tx<{ id: string }[]>`insert into source (team_id, kind, platform_id, name, url) values (${teamId}, 'web', 'p', 'n', 'u') returning id`;
      const [p] = await tx<{ id: string }[]>`insert into post (source_id, platform_post_id, url) values (${s!.id}, 'x', 'u') returning id`;
      await tx`insert into enrichment (post_id, intent) values (${p!.id}, 'rent')`;
    });
  });

  test("Every allowed value inserts; null intent ok; default role is hunter", async () => {
    await inTx(async (tx) => {
      const { teamId, userId } = await seedTeamUser(tx);
      for (const status of ["active", "paused", "paused_by_health"]) {
        await tx`insert into source (team_id, kind, platform_id, name, url, status) values (${teamId}, 'web', ${status}, 'n', 'u', ${status})`;
      }
      for (const kind of ["web", "telegram", "push"]) {
        await tx`insert into source (team_id, kind, platform_id, name, url) values (${teamId}, ${kind}, ${`k-${kind}`}, 'n', 'u')`;
      }
      for (const status of ["pending", "sending", "sent", "merged", "suppressed", "failed", "skipped"]) {
        await tx`insert into notification (user_id, channel, status) values (${userId}, 'ops', ${status})`;
      }
      await tx`insert into "user" (team_id, email, role) values (${teamId}, ${`p019-${crypto.randomUUID()}@example.test`}, 'operator')`;
      const [s] = await tx<{ id: string }[]>`select id from source where team_id = ${teamId} limit 1`;
      let i = 0;
      for (const intent of ["sell", "buy", "other", null]) {
        const [p] = await tx<{ id: string }[]>`insert into post (source_id, platform_post_id, url) values (${s!.id}, ${`e${i++}`}, 'u') returning id`;
        await tx`insert into enrichment (post_id, intent) values (${p!.id}, ${intent})`;
      }
      const [u] = await tx<{ role: string }[]>`insert into "user" (team_id, email) values (${teamId}, ${`p019-${crypto.randomUUID()}@example.test`}) returning role`;
      expect(u!.role).toBe("hunter");
    });
  });
});
