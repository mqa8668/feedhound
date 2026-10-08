/** Pure helpers for the live-feed row grammar (and 15). */

export type TimeBucket = "Last 10 minutes" | "Last hour" | "Earlier today" | "Older";

export const BUCKET_ORDER: readonly TimeBucket[] = ["Last 10 minutes", "Last hour", "Earlier today", "Older"];

/** Trimmed title if non-empty, else snippet, else null (caller renders the muted "(no text)"). */
export function displayTitle(title: string | null | undefined, snippet: string | null | undefined): string | null {
  const t = title?.trim();
  if (t) return t;
  const s = snippet?.trim();
  return s ? s : null;
}

export function timeBucket(firstSeenAt: string | Date, now: Date, dayStart: Date): TimeBucket {
  const t = new Date(firstSeenAt).getTime();
  const age = now.getTime() - t;
  if (age < 10 * 60_000) return "Last 10 minutes";
  if (age < 60 * 60_000) return "Last hour";
  if (t >= dayStart.getTime()) return "Earlier today";
  return "Older";
}

const GENERIC_WORDS = new Set(["hoi", "nhom", "group", "cong dong", "cong", "dong", "cho"]);

function fold(w: string): string {
  return w.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d");
}

// Words of car-trading group names ("mua bán", "xe ô tô cũ", ...) that carry no identity; skipped anywhere in the name.
const CAR_WORDS = new Set(["mua", "ban", "trao", "doi", "xe", "o", "to", "oto", "cu", "da", "qua", "su", "dung"]);

function firstLetter(w: string): string {
  return Array.from(w)[0]?.toUpperCase() ?? "";
}

/** First letters of the first two meaningful words (generic words skipped); falls back to the original first two words; `?` when none. */
export function initials(name: string): string {
  const words = name.match(/\p{L}[\p{L}\p{M}]*/gu) ?? [];
  let start = 0;
  while (start < words.length - 1 && GENERIC_WORDS.has(fold(words[start] ?? ""))) start++;
  const kept = words.slice(start).filter((w) => !(CAR_WORDS.has(fold(w)) || w.toLowerCase() === "hơi"));
  let out: string;
  if (kept.length >= 2) out = kept.slice(0, 2).map(firstLetter).join("");
  else if (kept.length === 1 && words.length > 1 && Array.from(kept[0] ?? "").length >= 2) {
    out = Array.from(kept[0] ?? "").slice(0, 2).join("").toUpperCase();
  } else out = words.slice(0, 2).map(firstLetter).join("");
  if (!out && words.length > 0) out = words.slice(0, 2).map(firstLetter).join("");
  return out || "?";
}

function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Stable avatar palette slot 1..8 for a source id. */
export function avatarSlot(sourceId: string): number {
  return 1 + (fnv1a32(sourceId) % 8);
}

/** Local midnight in the browser zone, used. */
export function browserDayStart(now: Date): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}
