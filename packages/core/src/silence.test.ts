import { describe, expect, test } from "bun:test";
import { activeWindowStart, deriveSilenceConfig, isWithinActiveHours, silenceGap, sourceSilenceIntervalSec } from "./silence";

const TZ = "Asia/Ho_Chi_Minh";
const AH = { start: "07:00", end: "23:00" };
// 15:00 VN = 08:00Z
const NOW = new Date("2026-10-03T08:00:00Z");

describe("silence", () => {
  test("deriveSilenceConfig defaults and formula", () => {
    const cfg = deriveSilenceConfig({});
    expect(cfg).toEqual({ tz: TZ, activeHours: AH, gapMultiplier: 1.5, gapGraceSec: 300, fallbackIntervalSec: 4800, visitEveryMaxSec: 2700, activeWindowSec: 57600 });
    expect(deriveSilenceConfig({ "schedule.visitEverySec": { min: 1, max: 9000 } }).fallbackIntervalSec).toBe(9000);
  });

  test("isWithinActiveHours", () => {
    expect(isWithinActiveHours(NOW, TZ, AH)).toBe(true);
    expect(isWithinActiveHours(new Date("2026-10-02T19:00:00Z"), TZ, AH)).toBe(false); // 02:00 VN
  });

  test("activeWindowStart is today's 07:00 local", () => {
    expect(activeWindowStart(NOW, TZ, AH).toISOString()).toBe("2026-10-03T00:00:00.000Z");
  });

  test("sourceSilenceIntervalSec uses the source interval, else the fallback", () => {
    const cfg = deriveSilenceConfig({});
    expect(sourceSilenceIntervalSec({ id: "a", expectedIntervalSec: 3600 }, cfg)).toBe(3600);
    expect(sourceSilenceIntervalSec({ id: "a", expectedIntervalSec: null }, cfg)).toBe(4800);
  });

  test("silenceGap clamps to the window start and returns the threshold", () => {
    const cfg = deriveSilenceConfig({});
    const old = silenceGap(new Date("2026-10-02T12:00:00Z"), NOW, 4800, cfg);
    expect(old.gapSec).toBe(8 * 3600);
    expect(old.thresholdSec).toBe(7500);
    const recent = silenceGap(new Date(NOW.getTime() - 20 * 60_000), NOW, 4800, cfg);
    expect(recent.gapSec).toBe(1200);
  });
});
