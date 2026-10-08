import { createDb, type DbHandle } from "@feedhound/db";
import { __resetShutdownForTests, runShutdown } from "@feedhound/core/shutdown";
import { afterAll, describe, expect, test } from "bun:test";
import type { PgBoss } from "pg-boss";
import {
  applyQueueRetention,
  BOSS_DEFAULT_DELETE_AFTER_S,
  BOSS_NOISY_DELETE_AFTER_S,
  bossSchemaFromEnv,
  main,
  shutdownTimeoutFromEnv,
} from "./index";
import { readFileSync } from "node:fs";

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
    console.warn(`index.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
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
  throw new Error("index.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("index.test.ts: skipped — TEST_DATABASE_URL is unset");
}

function getFreePort(): number {
  const server = Bun.listen({ port: 0, hostname: "127.0.0.1", socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

async function pollReadyz(port: number, deadlineMs: number): Promise<{ status: number; body: { ok: boolean; checks?: Record<string, string> } } | undefined> {
  const deadline = Date.now() + deadlineMs;
  let last: { status: number; body: { ok: boolean; checks?: Record<string, string> } } | undefined;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/readyz`);
      const body = (await res.json()) as { ok: boolean; checks?: Record<string, string> };
      last = { status: res.status, body };
      if (body.ok) return last;
    } catch {
      // server not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return last;
}

// never spread `process.env` into a spawned fixture — this repo's
// dev shell can carry TG_BOT_TOKEN/LLM_BASE_URL/LLM_API_KEY/TG_API_BASE, and
// the fixture boots the real `main()`, which would happily send a real
// Telegram message or bill a real LLM call from a `feedhound_test` job. Build the
// child's env from an explicit allow-list instead.
const SECRET_ENV_KEYS = ["TG_BOT_TOKEN", "LLM_BASE_URL", "LLM_API_KEY", "TG_API_BASE"] as const;

function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "NODE_ENV", "LOG_LEVEL"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

const spawned: ReturnType<typeof Bun.spawn>[] = [];
afterAll(() => {
  for (const proc of spawned) {
    try {
      proc.kill();
    } catch {
      // already exited
    }
  }
});

test("childEnv never leaks secret keys from process.env", () => {
  const previous: Record<string, string | undefined> = {};
  try {
    // childEnv reads process.env directly; simulate a shell that carries secrets.
    for (const key of SECRET_ENV_KEYS) {
      previous[key] = process.env[key];
      process.env[key] = "leaked-secret";
    }
    const built = childEnv({ AGENT_PORT: "0", DATABASE_URL: "postgres://x/feedhound_test" });
    for (const key of SECRET_ENV_KEYS) {
      expect(Object.hasOwn(built, key)).toBe(false);
    }
  } finally {
    for (const key of SECRET_ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

describe.skipIf(!canRun)("agent boot", () => {
  test(
    "SIGTERM while a job is active lets it finish, then exits 0",
    async () => {
      const port = getFreePort();
      const proc = Bun.spawn({
        cmd: ["bun", "./sigterm.fixture.ts"],
        cwd: import.meta.dir,
        env: childEnv({ AGENT_PORT: String(port), DATABASE_URL: TEST_DATABASE_URL ?? "" }),
        stdout: "pipe",
        stderr: "pipe",
      });
      spawned.push(proc);

      try {
        const ready = await pollReadyz(port, 20_000);
        expect(ready?.body.ok).toBe(true);

        const handle: DbHandle = createDb(TEST_DATABASE_URL);
        try {
          // Wait for the fixture's job to actually be picked up (state = active).
          let active = false;
          const activeDeadline = Date.now() + 10_000;
          while (Date.now() < activeDeadline) {
            const rows = await handle.sql<{ state: string }[]>`select state from pgboss.job where name = 't016_slow' order by created_on desc limit 1`;
            if (rows[0]?.state === "active") {
              active = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          expect(active).toBe(true);

          proc.kill("SIGTERM");
          const exitCode = await proc.exited;
          expect(exitCode).toBe(0);

          const rows = await handle.sql<{ state: string }[]>`select state from pgboss.job where name = 't016_slow' order by created_on desc limit 1`;
          expect(rows[0]?.state).toBe("completed");
          await handle.sql`delete from pgboss.job where name in ('t016_slow', 't016_slow_dlq')`;
        } finally {
          await handle.close();
        }
      } finally {
        // kill this test's child here rather than relying solely on
        // `afterAll` (which only runs once the whole file is done).
        try {
          proc.kill();
        } catch {
          // already exited
        }
      }
    },
    30_000,
  );

  test(
    "Unreachable DB retries 6 attempts, /readyz 503 with workers=fail, then exits 1",
    async () => {
      const port = getFreePort();
      const proc = Bun.spawn({
        cmd: ["bun", "./sigterm.fixture.ts"],
        cwd: import.meta.dir,
        env: childEnv({
          AGENT_PORT: String(port),
          DATABASE_URL: "postgres://x@127.0.0.1:1/feedhound_test",
          BOOT_RETRY_DELAYS_MS: "50,50,50,50,50",
        }),
        stdout: "pipe",
        stderr: "pipe",
      });
      spawned.push(proc);

      try {
        const observed: { status: number; workers?: string }[] = [];
        const pollUntilExit = (async () => {
          while (proc.exitCode === null) {
            try {
              const res = await fetch(`http://127.0.0.1:${port}/readyz`);
              const body = (await res.json()) as { checks?: Record<string, string> };
              observed.push({ status: res.status, workers: body.checks?.workers });
            } catch {
              // server not up yet
            }
            await new Promise((resolve) => setTimeout(resolve, 15));
          }
        })();

        const exitCode = await proc.exited;
        await pollUntilExit;
        const stdout = await new Response(proc.stdout).text();

        expect(exitCode).toBe(1);
        expect((stdout.match(/boot attempt failed/g) ?? []).length).toBe(6);
        expect(observed.some((o) => o.status === 503 && o.workers === "fail")).toBe(true);
      } finally {
        // this fixture already exits on its own (exitCode 1), but
        // kill defensively so a failed assertion above doesn't leak it.
        try {
          proc.kill();
        } catch {
          // already exited
        }
      }
    },
    10_000,
  );

  test("part 2: a bossFactory failing only its 3rd call on attempt 1 still boots on attempt 2", async () => {
    function makeFakeBoss(failOnCall: number | null): PgBoss {
      let calls = 0;
      const target: Record<string, (...args: unknown[]) => unknown> = {
        on: () => undefined,
        start: async () => undefined,
        stop: async () => undefined,
        createQueue: async () => undefined,
        schedule: async () => undefined,
        work: async () => undefined,
        getQueues: async () => [],
        getQueue: async () => null,
        updateQueue: async () => undefined,
        send: async () => "fake-job-id",
        fetch: async () => [],
        complete: async () => ({}),
      };
      return new Proxy(target, {
        get(t, prop: string) {
          const orig = t[prop];
          if (typeof orig !== "function") return orig;
          return async (...args: unknown[]) => {
            calls++;
            if (failOnCall !== null && calls === failOnCall) throw new Error(`fake boss failure on call ${calls}`);
            return orig(...args);
          };
        },
      }) as unknown as PgBoss;
    }

    let attempt = 0;
    const port = getFreePort();
    // this test boots the real in-process `main()`, which starts a
    // `Bun.serve` server, a DB handle, timers (watchIndex/aliasCache polls)
    // and installs SIGTERM/SIGINT handlers — all via module-level state in
    // `@feedhound/core/shutdown`. Restore env and run/clear that state in
    // `finally` so it never leaks into the next test.
    const previousAgentPort = process.env.AGENT_PORT;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.AGENT_PORT = String(port);
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    try {
      await main({
        bossFactory: () => {
          attempt++;
          return makeFakeBoss(attempt === 1 ? 3 : null);
        },
      });
      expect(attempt).toBe(2);

      const res = await fetch(`http://127.0.0.1:${port}/readyz`);
      const body = (await res.json()) as { ok: boolean; checks: Record<string, string> };
      expect(res.status).toBe(200);
      expect(body.checks.workers).toBe("ok");
    } finally {
      if (previousAgentPort === undefined) delete process.env.AGENT_PORT;
      else process.env.AGENT_PORT = previousAgentPort;
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      // Runs the hooks `main()` registered (boss.stop, server.stop, db.close)
      // then clears shutdown module state so it doesn't leak into other tests.
      await runShutdown("test-cleanup");
      __resetShutdownForTests();
    }
  });
});

describe("env knobs", () => {
  test("bossSchemaFromEnv defaults to pgboss and validates the identifier", () => {
    expect(bossSchemaFromEnv({})).toBe("pgboss");
    expect(bossSchemaFromEnv({ PGBOSS_SCHEMA: "pgboss_e2e_ab12" })).toBe("pgboss_e2e_ab12");
    expect(() => bossSchemaFromEnv({ PGBOSS_SCHEMA: 'x"; drop' })).toThrow();
    expect(() => bossSchemaFromEnv({ PGBOSS_SCHEMA: "Bad" })).toThrow();
  });
  test("shutdownTimeoutFromEnv accepts positive integers only", () => {
    expect(shutdownTimeoutFromEnv({ SHUTDOWN_TIMEOUT_MS: "500" })).toBe(500);
    expect(shutdownTimeoutFromEnv({ SHUTDOWN_TIMEOUT_MS: "-1" })).toBeUndefined();
    expect(shutdownTimeoutFromEnv({})).toBeUndefined();
  });
});

// Explicit per-queue completed-job retention.
describe("applyQueueRetention", () => {
  function fakeBoss(names: string[], failOn?: string): { boss: Pick<PgBoss, "getQueues" | "updateQueue">; updates: [string, unknown][] } {
    const updates: [string, unknown][] = [];
    const boss = {
      getQueues: async () => names.map((name) => ({ name })),
      updateQueue: async (name: string, options: unknown) => {
        if (name === failOn) throw new Error("boom");
        updates.push([name, options]);
      },
    } as unknown as Pick<PgBoss, "getQueues" | "updateQueue">;
    return { boss, updates };
  }

  test("noisy queues get 1 d, the rest 7 d", async () => {
    const { boss, updates } = fakeBoss(["watchdog", "__pgboss__send-it", "match", "enrich_dlq"]);
    await applyQueueRetention(boss);
    expect(updates).toEqual([
      ["watchdog", { deleteAfterSeconds: 86_400 }],
      ["__pgboss__send-it", { deleteAfterSeconds: 86_400 }],
      ["match", { deleteAfterSeconds: 604_800 }],
      ["enrich_dlq", { deleteAfterSeconds: 604_800 }],
    ]);
    expect(BOSS_NOISY_DELETE_AFTER_S).toBe(86_400);
    expect(BOSS_DEFAULT_DELETE_AFTER_S).toBe(604_800);
  });

  test("a rejected updateQueue does not stop the rest", async () => {
    const { boss, updates } = fakeBoss(["watchdog", "match", "enrich_dlq"], "match");
    await applyQueueRetention(boss);
    expect(updates.map((u) => u[0])).toEqual(["watchdog", "enrich_dlq"]);
  });

  test("main() applies retention after dead-letter wiring", () => {
    const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(src.indexOf("applyQueueRetention(boss)")).toBeGreaterThan(src.indexOf("applyDeadLetters(boss)"));
  });
});
