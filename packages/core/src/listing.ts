// Listing-card helpers shared by api and web. Pure and browser-safe (no node:crypto).
import { z } from "zod";
import { authorKey, fingerprintText } from "./normalize";

// ---- sha256 (pure; keeps this module importable from the browser bundle) ----

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

export function sha256Hex(input: string): string {
  const msg = new TextEncoder().encode(input);
  const padded = new Uint8Array(((msg.length + 9 + 63) >> 6) << 6);
  padded.set(msg);
  padded[msg.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((msg.length * 8) / 0x100000000));
  view.setUint32(padded.length - 4, (msg.length * 8) >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15]!;
      const w2 = w[i - 2]!;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h[0]!;
    let b = h[1]!;
    let c = h[2]!;
    let d = h[3]!;
    let e = h[4]!;
    let f = h[5]!;
    let g = h[6]!;
    let hh = h[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i++) h[i] = (h[i]! + next[i]!) >>> 0;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
}

/** Same seller + same text across groups (no scope). Null when the author or the fingerprintable text is empty. */
export function repostKey(i: { authorId?: string | null; authorName?: string | null; text: string }): string | null {
  const a = authorKey(i);
  const t = fingerprintText(i.text);
  if (a === "" || t === "") return null;
  return sha256Hex(`${a}\u001f${t}`);
}

// ---- DTO ----

const attrValue = z.union([z.string(), z.number(), z.boolean()]);

export const listingFieldsSchema = z.object({
  displayTitle: z.string().nullable(),
  thumbUrl: z.string().nullable(),
  categoryId: z.string().nullable(),
  attributes: z.record(z.string(), attrValue).nullable(),
  region: z.string().nullable(),
  dealPct: z.number().nullable(),
  priceSuspect: z.boolean(),
  hasPhone: z.boolean(),
  repostKey: z.string().nullable(),
  alsoIn: z.array(z.object({ postId: z.string(), sourceId: z.string(), url: z.string() })),
  saved: z.boolean(),
});
export type ListingFields = z.infer<typeof listingFieldsSchema>;

/** 026-A car attribute keys in chip order: make, year, odometer (km), transmission, fuel. One constant to rename. */
export const CAR_CHIP_KEYS = ["make", "year", "odo_km", "transmission", "fuel"] as const;

// ---- formatting ----

function decimal(n: number): string {
  return String(n);
}

export function formatVndCompact(n: number): string {
  if (n >= 1e9) return `${decimal(Math.round((n / 1e9) * 10) / 10)}B`;
  if (n >= 1e6) {
    const tr = n / 1e6;
    return `${tr < 10 ? decimal(Math.round(tr * 10) / 10) : Math.round(tr)}M`;
  }
  return `${Math.round(n / 1e3)}k`;
}

export function formatKm(n: number): string {
  return `${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ".")} km`;
}

export function dealBadge(pct: number | null): { text: string; tone: "good" | "muted" } | null {
  if (pct === null) return null;
  const n = Math.round(Math.abs(pct));
  if (n === 0) return { text: "≈ avg", tone: "muted" };
  return pct < 0 ? { text: `▼${n}% vs avg`, tone: "good" } : { text: `▲${n}% vs avg`, tone: "muted" };
}

// ---- watch draft ----

export const watchDraftSchema = z.object({
  name: z.string(),
  include: z.array(z.string()),
  categoryIds: z.array(z.string()),
  attributeFilters: z.array(z.object({ key: z.string(), op: z.enum(["eq", "in", "gte", "lte"]), value: z.union([z.string(), z.number()]).optional() })),
  priceMin: z.number().optional(),
  priceMax: z.number().optional(),
  intents: z.array(z.enum(["sell", "buy", "other"])),
});
export type WatchDraft = z.infer<typeof watchDraftSchema>;

export function watchDraftFromListing(l: ListingFields & { priceVnd: number | null; title: string | null }): WatchDraft {
  const a = l.attributes ?? {};
  const str = (k: string): string | null => {
    const v = a[k];
    return typeof v === "string" && v !== "" ? v : null;
  };
  const make = str("make");
  const model = str("model");
  const year = typeof a.year === "number" ? a.year : null;
  const nameParts = [make, model, year === null ? null : String(year)].filter((x): x is string => x !== null);
  const name = nameParts.length > 0 ? nameParts.join(" ") : (l.displayTitle ?? l.title ?? "").slice(0, 40);
  const include = [make, model].filter((x): x is string => x !== null).map((x) => x.toLowerCase());
  const attributeFilters: WatchDraft["attributeFilters"] = [];
  if (make) attributeFilters.push({ key: "make", op: "eq", value: make });
  if (model) attributeFilters.push({ key: "model", op: "eq", value: model });
  if (year !== null) {
    attributeFilters.push({ key: "year", op: "gte", value: year - 1 });
    attributeFilters.push({ key: "year", op: "lte", value: year + 1 });
  }
  const draft: WatchDraft = { name, include, categoryIds: l.categoryId ? [l.categoryId] : [], attributeFilters, intents: ["sell"] };
  if (l.priceVnd !== null && !l.priceSuspect) {
    draft.priceMin = Math.round((l.priceVnd * 0.85) / 1e6) * 1e6;
    draft.priceMax = Math.round((l.priceVnd * 1.15) / 1e6) * 1e6;
  }
  return draft;
}
