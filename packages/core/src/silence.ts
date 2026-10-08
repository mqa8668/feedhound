// Platform-neutral source-silence math, shared by the agent
// watchdog and the api (`GET /api/ops/health`). Pure: `now` is always injected.

export interface ActiveHours {
  start: string; // "HH:MM"
  end: string; // "HH:MM"
}

/** `fallbackIntervalSec` covers a source with no `expectedIntervalSec`. */
export interface SilenceConfig {
  tz: string;
  activeHours: ActiveHours;
  gapMultiplier: number;
  gapGraceSec: number;
  fallbackIntervalSec: number;
  visitEveryMaxSec: number;
  activeWindowSec: number;
}

export const SILENCE_CONFIG_KEYS = [
  "app.tz",
  "schedule.activeHours",
  "schedule.visitEverySec",
  "schedule.dailyCapPerSource",
  "watchdog.gapMultiplier",
  "watchdog.gapGraceMin",
] as const;

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** `HH:MM` wall-clock time of `at` in `tz`. */
function wallClockTime(at: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(at);
  const hh = parts.find((p) => p.type === "hour")?.value ?? "00";
  const mm = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${hh}:${mm}`;
}

/** Same defaults and formula the watchdog has always used for its config. */
export function deriveSilenceConfig(raw: Partial<Record<(typeof SILENCE_CONFIG_KEYS)[number], unknown>>): SilenceConfig {
  const tz = (raw["app.tz"] as string | undefined) ?? "Asia/Ho_Chi_Minh";
  const activeHours = (raw["schedule.activeHours"] as ActiveHours | undefined) ?? { start: "07:00", end: "23:00" };
  const visitEverySec = (raw["schedule.visitEverySec"] as { min: number; max: number } | undefined) ?? { min: 900, max: 2700 };
  const dailyCapPerSource = (raw["schedule.dailyCapPerSource"] as number | undefined) ?? 12;
  const gapMultiplier = (raw["watchdog.gapMultiplier"] as number | undefined) ?? 1.5;
  const gapGraceMin = (raw["watchdog.gapGraceMin"] as number | undefined) ?? 5;

  const activeWindowSec = Math.max(0, hhmmToMinutes(activeHours.end) - hhmmToMinutes(activeHours.start)) * 60;
  const fallbackIntervalSec = Math.max(visitEverySec.max, Math.ceil(activeWindowSec / dailyCapPerSource));
  return {
    tz,
    activeHours,
    gapMultiplier,
    gapGraceSec: gapGraceMin * 60,
    fallbackIntervalSec,
    visitEveryMaxSec: visitEverySec.max,
    activeWindowSec,
  };
}

/** Seconds between expected polls of `source`. */
export function sourceSilenceIntervalSec(source: { id: string; expectedIntervalSec: number | null }, cfg: SilenceConfig): number {
  return source.expectedIntervalSec ?? cfg.fallbackIntervalSec;
}

export function isWithinActiveHours(at: Date, tz: string, ah: ActiveHours): boolean {
  const current = wallClockTime(at, tz);
  return current >= ah.start && current < ah.end;
}

/**
 * The instant `ah.start` occurred today (in `tz`): `now` minus the wall-clock
 * minutes elapsed since `ah.start`. Only meaningful once `now` is inside the
 * active window (elapsed >= 0).
 */
export function activeWindowStart(now: Date, tz: string, ah: ActiveHours): Date {
  const elapsedMin = hhmmToMinutes(wallClockTime(now, tz)) - hhmmToMinutes(ah.start);
  return new Date(now.getTime() - elapsedMin * 60_000);
}

/** Gap since `lastAt`, clamped to today's active window, and the alert threshold for `intervalSec`. */
export function silenceGap(lastAt: Date, now: Date, intervalSec: number, cfg: SilenceConfig): { gapSec: number; thresholdSec: number } {
  const windowStart = activeWindowStart(now, cfg.tz, cfg.activeHours);
  const ref = Math.max(lastAt.getTime(), windowStart.getTime());
  return { gapSec: (now.getTime() - ref) / 1000, thresholdSec: intervalSec * cfg.gapMultiplier + cfg.gapGraceSec };
}
