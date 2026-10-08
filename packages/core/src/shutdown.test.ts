import { afterAll, describe, expect, test, beforeEach } from "bun:test";
import { createLogger } from "./logger";
import { __resetShutdownForTests, bootDelaysFromEnv, bootWithRetry, isShuttingDown, onShutdown, runShutdown } from "./shutdown";

const logger = createLogger({ service: "shutdown-test", level: "silent" });

beforeEach(() => {
  __resetShutdownForTests();
});

// `bun test` runs every file in one process, so the module-level shutdown
// state in `./shutdown` is shared beyond this file — leaving `isShuttingDown()`
// true here would fail any later suite's `accepting` readiness check.
afterAll(() => {
  __resetShutdownForTests();
});

describe("runShutdown", () => {
  test("Runs hooks in order, a throwing hook does not block later hooks, a slow hook is abandoned at its timeoutMs", async () => {
    const order: string[] = [];
    onShutdown("a", () => {
      order.push("a");
    });
    onShutdown("b", () => {
      order.push("b");
      throw new Error("b failed");
    });
    onShutdown(
      "c",
      () =>
        new Promise(() => {
          order.push("c");
          // never resolves
        }),
      { timeoutMs: 50 },
    );

    const start = Date.now();
    const result = await runShutdown("test", logger);
    const elapsed = Date.now() - start;

    expect(order).toEqual(["a", "b", "c"]);
    expect(result).toBe(1);
    expect(elapsed).toBeLessThan(1000);
    expect(isShuttingDown()).toBe(true);

    const second = runShutdown("test-again", logger);
    expect(await second).toBe(result);
  });

  test("resolves 0 when every hook succeeds", async () => {
    onShutdown("ok1", () => {});
    onShutdown("ok2", async () => {
      await Promise.resolve();
    });
    const result = await runShutdown("test");
    expect(result).toBe(0);
  });

  test("second call returns the same promise instance as the first", () => {
    onShutdown("noop", () => {});
    const p1 = runShutdown("only-once");
    const p2 = runShutdown("only-once");
    expect(p1).toBe(p2);
  });
});

describe("bootWithRetry", () => {
  test("succeeds on the first attempt without waiting", async () => {
    let calls = 0;
    const result = await bootWithRetry(
      async () => {
        calls++;
        return "ok";
      },
      { delaysMs: [10, 10], logger },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  test("retries delaysMs.length times then rejects", async () => {
    let calls = 0;
    const failedAttempts: number[] = [];
    await expect(
      bootWithRetry(
        async () => {
          calls++;
          throw new Error(`fail ${calls}`);
        },
        {
          delaysMs: [1, 1, 1],
          logger,
          onFail: async (_err, n) => {
            failedAttempts.push(n);
          },
        },
      ),
    ).rejects.toThrow("fail 4");
    expect(calls).toBe(4);
    expect(failedAttempts).toEqual([1, 2, 3, 4]);
  });

  test("succeeds on a later attempt after earlier ones fail", async () => {
    let calls = 0;
    const result = await bootWithRetry(
      async (n) => {
        calls++;
        if (n < 3) throw new Error("not yet");
        return n;
      },
      { delaysMs: [1, 1, 1], logger },
    );
    expect(result).toBe(3);
    expect(calls).toBe(3);
  });
});

describe("bootDelaysFromEnv", () => {
  test("defaults to the 5-step ladder when unset", () => {
    delete process.env.BOOT_RETRY_DELAYS_MS;
    expect(bootDelaysFromEnv()).toEqual([1000, 2000, 4000, 8000, 16000]);
  });

  test("parses BOOT_RETRY_DELAYS_MS", () => {
    process.env.BOOT_RETRY_DELAYS_MS = "50,50,50";
    expect(bootDelaysFromEnv()).toEqual([50, 50, 50]);
    delete process.env.BOOT_RETRY_DELAYS_MS;
  });
});
