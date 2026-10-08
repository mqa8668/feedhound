import { describe, expect, test } from "bun:test";
import { RateLimiter } from "./rate-limit";

/** Deterministic virtual clock: `sleep` advances `now` instantly instead of waiting for real time. */
function makeVirtualClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
}

describe("RateLimiter", () => {
  test("limits to perChatPerSec, then waits", async () => {
    const clock = makeVirtualClock();
    const limiter = new RateLimiter({ perChatPerSec: 1, perChatPerMin: 20, globalPerSec: 25, now: clock.now, sleep: clock.sleep });
    const timestamps: number[] = [];
    for (let i = 0; i < 3; i++) {
      await limiter.acquire(1);
      timestamps.push(clock.now());
    }
    expect(timestamps[1]! - timestamps[0]!).toBeGreaterThanOrEqual(1_000);
    expect(timestamps[2]! - timestamps[1]!).toBeGreaterThanOrEqual(1_000);
  });

  test("30 pending for one chat: <=20 in the first 60s, rest after", async () => {
    const clock = makeVirtualClock();
    const limiter = new RateLimiter({ perChatPerSec: 1, perChatPerMin: 20, globalPerSec: 25, now: clock.now, sleep: clock.sleep });
    const timestamps: number[] = [];
    for (let i = 0; i < 30; i++) {
      await limiter.acquire(1);
      timestamps.push(clock.now());
    }
    const within60s = timestamps.filter((t) => t < 60_000).length;
    expect(within60s).toBeLessThanOrEqual(20);
    expect(timestamps.some((t) => t >= 60_000)).toBe(true);
  });

  test("pause() delays acquire by at least the given ms", async () => {
    const clock = makeVirtualClock();
    const limiter = new RateLimiter({ perChatPerSec: 1, perChatPerMin: 20, globalPerSec: 25, now: clock.now, sleep: clock.sleep });
    await limiter.acquire(2);
    limiter.pause(2, 2_000);
    const before = clock.now();
    await limiter.acquire(2);
    expect(clock.now() - before).toBeGreaterThanOrEqual(2_000);
  });
});
