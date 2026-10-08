import { createDb } from "@feedhound/db";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ConfigService } from "./config";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
// In CI (or whenever TEST_DATABASE_URL is explicitly set) a DB test that can't
// reach its database is a failure, not a skip — otherwise CI can go green
// while silently running zero DB tests.
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

// Guard: only ever run against a database whose name ends in "_test" (never
// the dev/prod "feedhound" database). Confirmed after connecting, not just via the
// URL string, and only when it is actually reachable (the server DB may not
// be reachable from this machine yet — in which case we skip, unless MUST_RUN).
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
    console.warn(`config.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
  }
  if (reachable) {
    // Never skipped: refuse to run against a non-test database even if MUST_RUN is false.
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
  throw new Error("config.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("config.test.ts: skipped — TEST_DATABASE_URL is unset");
}

describe.skipIf(!canRun)("ConfigService (integration)", () => {
  test("setConfig in one instance is visible via getConfig in another within 1s, via NOTIFY", async () => {
    const key = `test.config.${crypto.randomUUID()}`;
    const processA = new ConfigService({ databaseUrl: TEST_DATABASE_URL });
    const processB = new ConfigService({ databaseUrl: TEST_DATABASE_URL });
    try {
      await processA.setConfig(key, 1, "test-a");

      const start = Date.now();
      let value: number | undefined;
      while (Date.now() - start < 1000) {
        value = await processB.getConfig(key, z.number());
        if (value === 1) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(value).toBe(1);
    } finally {
      await processA.close();
      await processB.close();
    }
  }, 5000);

  test("onChange fires when another process updates the key", async () => {
    const key = `test.config.${crypto.randomUUID()}`;
    const processA = new ConfigService({ databaseUrl: TEST_DATABASE_URL });
    const processB = new ConfigService({ databaseUrl: TEST_DATABASE_URL });
    try {
      await processA.setConfig(key, "initial", "test-a");
      await processB.getConfig(key, z.string());

      const changed = new Promise<unknown>((resolve) => {
        processB.onChange(key, resolve);
      });
      await processA.setConfig(key, "updated", "test-a");

      const value = await Promise.race([
        changed,
        new Promise((resolve) => setTimeout(() => resolve(undefined), 1000)),
      ]);
      expect(value).toBe("updated");
    } finally {
      await processA.close();
      await processB.close();
    }
  }, 5000);

  test("setConfig then getConfig with a mismatched schema rejects instead of returning the raw value", async () => {
    const key = `test.config.${crypto.randomUUID()}`;
    const service = new ConfigService({ databaseUrl: TEST_DATABASE_URL });
    try {
      await service.setConfig(key, "not-a-number", "test-a");
      await expect(service.getConfig(key, z.number())).rejects.toThrow();
    } finally {
      await service.close();
    }
  }, 5000);
});

describe("ConfigService (unhandled rejection safety)", () => {
  test("onChange against an unreachable database does not produce an unhandled rejection", async () => {
    const rejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);

    // Port 1 is not a listening Postgres server on any reachable host, so the
    // connection (and therefore `listen()`) will fail.
    const service = new ConfigService({ databaseUrl: "postgres://user:pass@127.0.0.1:1/db" });
    try {
      service.onChange("some.key", () => {});
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      await service.close();
    }
  }, 5000);
});
