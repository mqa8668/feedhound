// Test fixture only: boots the real agent `main()` with one
// extra queue, `t016_slow`, whose worker sleeps 3s. `apps/agent/src/index.test.ts`
// spawns this file as a child process, waits for the job to go `active`, sends
// SIGTERM, and asserts the process exits 0 within 30s with the job `completed`
// (i.e. the graceful `boss.stop` window let the in-flight job finish).
import { PgBoss } from "pg-boss";
import { main } from "./index";

export const SLOW_QUEUE = "t016_slow";
const SLOW_JOB_MS = 3_000;

await main({
  registerExtra: async (boss: PgBoss) => {
    await boss.createQueue(SLOW_QUEUE, { retryLimit: 0 });
    await boss.work(SLOW_QUEUE, async () => {
      await new Promise((resolve) => setTimeout(resolve, SLOW_JOB_MS));
    });
    await boss.send(SLOW_QUEUE, {});
  },
});
