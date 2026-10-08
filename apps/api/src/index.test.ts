import { describe, expect, test } from "bun:test";
import type { PgBoss } from "pg-boss";
import { createBoss } from "./index";

/** Pg-boss failing to start must reject (so the process exits), not silently return an unstarted boss. */
describe("createBoss", () => {
  test("resolves with the boss when start() succeeds", async () => {
    const fakeBoss = {
      on: () => undefined,
      start: async () => undefined,
    } as unknown as PgBoss;

    const boss = await createBoss("postgres://fake", () => fakeBoss);
    expect(boss).toBe(fakeBoss);
  });

  test("rejects when start() fails, so callers can exit(1) instead of degrading silently", async () => {
    const fakeBoss = {
      on: () => undefined,
      start: async () => {
        throw new Error("connection refused");
      },
    } as unknown as PgBoss;

    await expect(createBoss("postgres://fake", () => fakeBoss)).rejects.toThrow("connection refused");
  });
});
