import { formatVndCompact } from "@feedhound/core/listing";
import type { PriceQualifier } from "@/api/types";

const TIME_ZONE = "Asia/Ho_Chi_Minh";

/** `15.000.000 VND`, em dash for null — shared by LiveFeed and the matches inbox. */
export function formatPrice(v: number | null): string {
  if (v == null) return "—";
  return `${v.toLocaleString("vi-VN")} VND`;
}

function compactTr(n: number): string {
  return formatVndCompact(n);
}

/** "200M", "> 200M" (floor), "< 200M" (ceiling), "~350M" (approx), "180–200M" (range). */
export function formatPriceQualified(v: number | null, qualifier?: PriceQualifier | string | null, maxVnd?: number | null): string {
  if (v == null) return "—";
  const base = compactTr(v);
  switch (qualifier) {
    case "floor": return `> ${base}`;
    case "ceiling": return `< ${base}`;
    case "approx": return `~${base}`;
    case "range": return maxVnd != null && maxVnd > v ? `${base.replace(/M$/, "")}–${compactTr(maxVnd)}` : base;
    default: return base;
  }
}

/** Intent -> Badge variant. Same map for every list that shows an intent badge. */
export const INTENT_VARIANT: Record<string, "success-subtle" | "info-subtle"> = {
  sell: "success-subtle",
  buy: "info-subtle",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const ABSOLUTE_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  day: "2-digit",
  month: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** `18 Sep 2026, 10:46` in the `Asia/Ho_Chi_Minh` zone. */
export function formatAbsolute(input: Date | string | number): string {
  const date = input instanceof Date ? input : new Date(input);
  const parts = ABSOLUTE_FORMATTER.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")} ${MONTHS[Number(get("month")) - 1] ?? ""} ${get("year")}, ${get("hour")}:${get("minute")}`;
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31536000],
  ["month", 2592000],
  ["week", 604800],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

const RELATIVE_FORMATTER = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "5m ago" / "in 2h" style relative label, computed against `now` (defaults to `Date.now()`). */
export function formatRelative(input: Date | string | number, now: Date | string | number = Date.now()): string {
  const date = input instanceof Date ? input : new Date(input);
  const reference = now instanceof Date ? now : new Date(now);
  const diffSec = Math.round((date.getTime() - reference.getTime()) / 1000);
  const abs = Math.abs(diffSec);

  if (abs < 5) return "just now";

  for (const [unit, secondsInUnit] of UNITS) {
    if (abs >= secondsInUnit || unit === "second") {
      const value = Math.round(diffSec / secondsInUnit);
      return RELATIVE_FORMATTER.format(value, unit);
    }
  }
  return "just now";
}

/** Relative label for display + absolute string for the `title` attribute. */
export function formatDateCell(input: Date | string | number | null | undefined): { relative: string; absolute: string | undefined } {
  if (input == null) return { relative: "—", absolute: undefined };
  return { relative: formatRelative(input), absolute: formatAbsolute(input) };
}

/** Short VND for chips and cards: `25M`, `17.9M`, `500k`, `1.5B`. */
export function formatVndShort(v: number): string {
  const trim = (n: number): string => {
    const s = (Math.round(n * 10) / 10).toString();
    return s;
  };
  if (v >= 1_000_000_000) return `${trim(v / 1_000_000_000)}B`;
  if (v >= 1_000_000) return `${trim(v / 1_000_000)}M`;
  if (v >= 1_000) return `${trim(v / 1_000)}k`;
  return String(v);
}
