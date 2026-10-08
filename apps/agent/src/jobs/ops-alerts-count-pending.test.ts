import type { PgBoss } from "pg-boss";
import { describe, expect, test } from "bun:test";
import { countPendingJobs } from "./ops-alerts";

/**
 * Pure unit test for `countPendingJobs`: no DB, no
 * pg-boss instance, just a fake `getQueues()` shaped like pg-boss's
 * `QueueResult[]`. Safe to run standalone (no TEST_DATABASE_URL needed).
 */
function fakeBoss(readyCounts: number[]): Pick<PgBoss, "getQueues"> {
  return {
    getQueues: async () =>
      readyCounts.map(
        (readyCount, i) =>
          ({
            name: `queue-${i}`,
            readyCount,
          }) as Awaited<ReturnType<PgBoss["getQueues"]>>[number],
      ),
  };
}

describe("countPendingJobs", () => {
  test("sums readyCount across every queue", async () => {
    const boss = fakeBoss([10, 0, 495]) as PgBoss;
    expect(await countPendingJobs(boss)).toBe(505);
  });

  test("returns 0 when there are no queues", async () => {
    const boss = fakeBoss([]) as PgBoss;
    expect(await countPendingJobs(boss)).toBe(0);
  });
});
