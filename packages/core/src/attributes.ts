// Typed product attributes. Pure (no I/O): schema resolution, canonical values, regex extraction, filters.

import { z } from "zod";
import { normalizeText } from "./normalize";

/** Bump when extraction rules change; the backfill re-processes rows with a different stored version. */
export const ATTRIBUTES_VERSION = 2;

export type AttributeValue = string | number;
export type Attributes = Record<string, AttributeValue>;

export interface AttributeAlias {
  value: string;
  label?: string;
  /** Match strings (any case/diacritics; folded at use). */
  match: string[];
  /** Keys filled (when absent) if this alias is found in text. */
  implies?: Attributes;
}

export type NumberUnit = "gb" | "pct" | "in" | "months" | "year" | "km" | "count";

interface DefBase {
  key: string;
  label: string;
  keyAttr: boolean;
  /** Key used for deal peers only if the post has it. */
  keyOptional?: true;
}
export type AttributeDef = DefBase &
  (
    | { kind: "enum"; values: string[]; aliases?: AttributeAlias[] }
    | { kind: "ordered"; values: string[] }
    | { kind: "text"; maxLen: number; aliases?: AttributeAlias[] }
    | { kind: "number"; unit: NumberUnit; min: number; max: number; tolerance?: number }
  );
export type AttributeSchema = AttributeDef[];

const aliasZ = z.object({
  value: z.string().min(1),
  label: z.string().optional(),
  match: z.array(z.string().min(1)).min(1),
  implies: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});
const baseZ = {
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().min(1),
  keyAttr: z.boolean().default(false),
  keyOptional: z.literal(true).optional(),
};
export const attributeDefSchema = z.discriminatedUnion("kind", [
  z.object({ ...baseZ, kind: z.literal("enum"), values: z.array(z.string().min(1)).min(1), aliases: z.array(aliasZ).optional() }),
  z.object({ ...baseZ, kind: z.literal("ordered"), values: z.array(z.string().min(1)).min(1) }),
  z.object({ ...baseZ, kind: z.literal("text"), maxLen: z.number().int().min(1).max(200), aliases: z.array(aliasZ).optional() }),
  z.object({
    ...baseZ,
    kind: z.literal("number"),
    unit: z.enum(["gb", "pct", "in", "months", "year", "km", "count"]),
    min: z.number(),
    max: z.number(),
    tolerance: z.number().min(0).optional(),
  }),
]);
export const attributeSchemaZ = z.array(attributeDefSchema);

export interface PriceBounds {
  min: number;
  max: number;
}

export const attributeFilterSchema = z
  .object({
    key: z.string().min(1).max(40),
    op: z.enum(["eq", "in", "gte", "lte"]),
    value: z.union([z.string().max(60), z.number()]).optional(),
    values: z.array(z.union([z.string().max(60), z.number()])).min(1).max(20).optional(),
  })
  .superRefine((f, ctx) => {
    if (f.op === "in") {
      if (!f.values) ctx.addIssue({ code: "custom", message: "`in` needs values", path: ["values"] });
    } else if (f.value === undefined) {
      ctx.addIssue({ code: "custom", message: `\`${f.op}\` needs value`, path: ["value"] });
    }
  });
export type AttributeFilter = z.infer<typeof attributeFilterSchema>;

// ---- schema / bounds resolution (nearest ancestor wins) ----

/** `categoryId -> ltree path`; same shape as the matcher's `CategoryTree`. */
type Tree = Map<string, string>;

/** Ancestor chain (root first, self last) of `categoryId`, as category ids present in `tree`. */
export function ancestorIds(categoryId: string, tree: Tree): string[] {
  const path = tree.get(categoryId);
  if (path === undefined) return [categoryId];
  const byPath = new Map<string, string>();
  for (const [id, p] of tree) byPath.set(p, id);
  const parts = path.split(".");
  const out: string[] = [];
  for (let i = 1; i <= parts.length; i++) {
    const id = byPath.get(parts.slice(0, i).join("."));
    if (id !== undefined) out.push(id);
  }
  return out;
}

/** Schema for `categoryId`: ancestors' defs overridden per key by nearer ones. */
export function resolveSchema(categoryId: string, tree: Tree, byCategory: Map<string, AttributeSchema>): AttributeSchema {
  const merged = new Map<string, AttributeDef>();
  for (const id of ancestorIds(categoryId, tree)) {
    for (const def of byCategory.get(id) ?? []) merged.set(def.key, def);
  }
  return [...merged.values()];
}

export interface RawBounds {
  min: number | null;
  max: number | null;
}

/** Nearest ancestor wins per bound; a missing side is open. `null` when neither bound is set anywhere. */
export function resolvePriceBounds(categoryId: string, tree: Tree, byCategory: Map<string, RawBounds>): PriceBounds | null {
  let min: number | null = null;
  let max: number | null = null;
  for (const id of ancestorIds(categoryId, tree)) {
    const b = byCategory.get(id);
    if (!b) continue;
    if (b.min !== null) min = b.min;
    if (b.max !== null) max = b.max;
  }
  if (min === null && max === null) return null;
  return { min: min ?? 0, max: max ?? Number.MAX_SAFE_INTEGER };
}

export interface CategoryAttrRow {
  id: string;
  path: string;
  attributeSchema: unknown;
}

/** Schema declared on each category row itself (invalid JSON in a row counts as no schema). */
export function declaredSchemas(rows: CategoryAttrRow[]): Map<string, AttributeSchema> {
  const out = new Map<string, AttributeSchema>();
  for (const r of rows) {
    const parsed = attributeSchemaZ.safeParse(r.attributeSchema);
    if (parsed.success && parsed.data.length > 0) out.set(r.id, parsed.data);
  }
  return out;
}

/** Resolved (inherited) schema for every category that has one, keyed by category id. */
export function resolveAllSchemas(rows: CategoryAttrRow[]): Map<string, AttributeSchema> {
  const tree = new Map(rows.map((r) => [r.id, r.path]));
  const declared = declaredSchemas(rows);
  const out = new Map<string, AttributeSchema>();
  for (const r of rows) {
    const schema = resolveSchema(r.id, tree, declared);
    if (schema.length > 0) out.set(r.id, schema);
  }
  return out;
}

// ---- canonical values ----

function fold(s: string): string {
  return normalizeText(s).folded;
}

function snake(s: string): string {
  return fold(s).replace(/\/a$/, "").replace(/[\s-]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
}

function effectiveMax(def: Extract<AttributeDef, { kind: "number" }>, now: Date): number {
  return def.unit === "year" ? Math.min(def.max, now.getUTCFullYear() + 1) : def.max;
}

function aliasHit(aliases: AttributeAlias[] | undefined, raw: string): string | undefined {
  if (!aliases) return undefined;
  const f = fold(raw).replace(/[\s_-]+/g, " ");
  for (const a of aliases) {
    if (a.value.replace(/_/g, " ") === f || a.match.some((m) => fold(m).replace(/[\s_-]+/g, " ") === f)) return a.value;
  }
  return undefined;
}

/** Canonical value for `raw` against `def`, or `undefined` when invalid. */
export function canonValue(def: AttributeDef, raw: unknown, now: Date = new Date()): AttributeValue | undefined {
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  if (def.kind === "number") {
    let n: number;
    if (typeof raw === "number") n = raw;
    else {
      const m = /^\s*(-?\d+(?:[.,]\d+)?)\s*[a-z%"]*\s*$/i.exec(raw);
      if (!m) return undefined;
      n = Number((m[1] as string).replace(",", "."));
    }
    if (!Number.isFinite(n) || n < def.min || n > effectiveMax(def, now)) return undefined;
    return n;
  }
  const text = String(raw);
  const viaAlias = def.kind === "ordered" ? undefined : aliasHit(def.aliases, text);
  if (def.kind === "text") {
    if (viaAlias !== undefined) return viaAlias;
    const s = snake(text);
    return s.length > 0 && s.length <= def.maxLen ? s : undefined;
  }
  const s = viaAlias ?? snake(text);
  return def.values.includes(s) ? s : undefined;
}

/** Keeps only schema keys with valid values; never throws. */
export function validateAttributes(raw: unknown, schema: AttributeSchema, now: Date = new Date()): Attributes {
  const out: Attributes = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const rec = raw as Record<string, unknown>;
  for (const def of schema) {
    if (!(def.key in rec)) continue;
    const v = canonValue(def, rec[def.key], now);
    if (v !== undefined) out[def.key] = v;
  }
  return out;
}

/** Rendered value for titles: alias label, else title-cased words; `gb`/`km` get units. */
export function renderValue(def: AttributeDef, v: AttributeValue): string {
  if (def.kind === "number") {
    const n = Number(v);
    if (def.unit === "gb") return n >= 1024 && n % 1024 === 0 ? `${n / 1024}TB` : `${n}GB`;
    if (def.unit === "km") return `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".")} km`;
    if (def.unit === "pct") return `${n}%`;
    if (def.unit === "in") return `${n}"`;
    return String(n);
  }
  const s = String(v);
  if (def.kind === "enum" || def.kind === "text") {
    const a = def.aliases?.find((x) => x.value === s && x.label !== undefined);
    if (a?.label) return a.label;
  }
  return s
    .split("_")
    .map((w) => (w.length > 0 ? w[0]?.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// ---- filters ----

/** Error reason for an invalid filter against `def`, else `null`. */
export function checkFilter(def: AttributeDef, f: AttributeFilter): string | null {
  if ((f.op === "gte" || f.op === "lte") && def.kind !== "ordered" && def.kind !== "number") {
    return `${f.op} is only valid on ordered or number attributes`;
  }
  if (f.op === "in" && def.kind !== "enum" && def.kind !== "ordered" && def.kind !== "text") {
    return "in is only valid on enum, ordered or text attributes";
  }
  if (def.kind === "text" && f.op !== "eq" && f.op !== "in") return "text attributes allow eq/in only";
  const vals = f.op === "in" ? (f.values ?? []) : f.value === undefined ? [] : [f.value];
  if (vals.length === 0) return f.op === "in" ? "in needs values" : `${f.op} needs value`;
  for (const v of vals) if (canonValue(def, v) === undefined) return `invalid value ${JSON.stringify(v)} for ${def.key}`;
  return null;
}

/** Same filter with values in canonical form (call after `checkFilter` passed). */
export function canonFilter(def: AttributeDef, f: AttributeFilter): AttributeFilter {
  const out: AttributeFilter = { key: f.key, op: f.op };
  if (f.op === "in") out.values = (f.values ?? []).map((v) => canonValue(def, v) ?? v);
  else if (f.value !== undefined) out.value = canonValue(def, f.value) ?? f.value;
  return out;
}

function rank(def: AttributeDef, v: AttributeValue): number | undefined {
  if (def.kind === "ordered") {
    const i = def.values.indexOf(String(v));
    return i >= 0 ? i : undefined;
  }
  if (def.kind === "number") return typeof v === "number" ? v : undefined;
  return undefined;
}

/** True when `value` satisfies the filter; a missing value always fails. */
export function evalFilter(def: AttributeDef, f: AttributeFilter, value: AttributeValue | undefined): boolean {
  if (value === undefined) return false;
  if (f.op === "eq") return f.value !== undefined && String(f.value) === String(value);
  if (f.op === "in") return (f.values ?? []).some((v) => String(v) === String(value));
  if (f.value === undefined) return false;
  const a = rank(def, value);
  const b = rank(def, typeof f.value === "string" && def.kind === "number" ? Number(f.value) : f.value);
  if (a === undefined || b === undefined) return false;
  return f.op === "gte" ? a >= b : a <= b;
}

// ---- regex extraction ----

const CHIP_RE = /\bm([1-5])\s*(pro|max|ultra)?\b/;
const CHIP_COMPACT_RE = /\bm([1-5])(p|m)\b/;
const SLASH_RE = /\b(\d{1,3})\s*\/\s*(\d{1,4})\s*(gb|g|tb)?(?![a-z0-9])/g;
const RAM_RE = /\bram\s*(\d{1,3})\b/;
const SSD_RE = /\bssd\s*(\d{1,4})\s*(gb|g|tb)?(?![a-z0-9])/;
const STORAGE_RE = /(?<![\d.,/])(64|128|256|512)\s?g(?:b)?(?![a-z0-9])/;
const STORAGE_BARE_RE = /(?<![\d.,/])(128|256|512)(?![\d.,/])/;
const STORAGE_TB_RE = /(?<![\d.,])1\s?tb\b/;
const BATTERY_RE = /\b(?:pin|battery)\s*(\d{2,3})\s*%?/;
const MARKET_RE = /\b(vn|ll|zd|za|j|ch|kh)\s?\/\s?a\b/;
const SCREEN_RE = /\b(13|14|15|16)\s?(?:inch|in(?![a-z])|")/;
const YEAR_KW_RE = /(?<![a-z])(?:nam sx|sx|doi|model)\s*[:.]?\s*((?:19|20)\d\d)(?!\d)/g;
const YEAR_BARE_RE = /(?<!\d)(?:19|20)\d\d(?!\d)/g;
const ODO_V_RE = /(?<![\d.,])(\d{1,3})(?:[.,](\d))?\s*v(an)?\s*(\d)?\b/g;
const ODO_KM_RE = /(\d{1,3}(?:[.,]\d{3})+|\d{4,6})\s*km\b/;
const ODO_KW_RE = /\bodo\s*[:.]?\s*(\d{1,3}(?:[.,]\d{3})+|\d{4,6})\b/;
const ODO_KKM_RE = /(\d{1,3})\s*(?:k|nghin|ngan)\s*km\b/;
const ODO_KW_K_RE = /\bodo\s*[:.]?\s*(\d{1,3})\s*k\b/;
// A year right after an expiry/validity cue is not the model year.
const EXPIRY_CUE_RE = /(?<![a-z])(?:dang kiem|dk|dang ky het|han|het han|bao hiem|bh)(?![a-z])/;
// "den"/"toi" also fold "đen" (black) and "tới": they only count as "until" between numbers ("03/2026 den 2027").
const UNTIL_RE = /\d\s*(?:den|toi)\s*$/;
const EXPIRY_WINDOW = 16;
const SEATS_RE = /\b(\d{1,2})\s*(?:cho|seats?)\b/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function digitsToInt(s: string): number {
  return Number(s.replace(/[.,]/g, ""));
}

function put(out: Attributes, def: AttributeDef | undefined, raw: AttributeValue, now: Date = new Date()): void {
  if (!def || def.key in out) return;
  const v = canonValue(def, raw, now);
  if (v !== undefined) out[def.key] = v;
}

function scanAliases(def: AttributeDef, text: string, out: Attributes, implied: Attributes[]): void {
  if (def.kind !== "enum" && def.kind !== "text") return;
  if (def.key in out) return;
  const entries: { m: string; a: { value: string; implies?: Attributes } }[] = [];
  const aliased = new Set((def.aliases ?? []).map((a) => a.value));
  if (def.kind === "enum" && def.aliases) {
    // Values without an explicit alias entry are matched by their own name (never the catch-all `other`).
    for (const v of def.values) if (v !== "other" && !aliased.has(v)) entries.push({ m: v.replace(/_/g, " "), a: { value: v } });
  }
  for (const a of def.aliases ?? []) for (const m of a.match) entries.push({ m: fold(m), a });
  let best: { pos: number; len: number; a: { value: string; implies?: Attributes } } | undefined;
  for (const e of entries) {
    if (e.m.length === 0) continue;
    const re = new RegExp(`(?<![a-z0-9])${escapeRe(e.m)}(?![a-z0-9])`);
    const hit = re.exec(text);
    if (!hit) continue;
    if (!best || hit.index < best.pos || (hit.index === best.pos && e.m.length > best.len)) {
      best = { pos: hit.index, len: e.m.length, a: e.a };
    }
  }
  if (!best) return;
  put(out, def, best.a.value);
  if (def.key in out && best.a.implies) implied.push(best.a.implies);
}

/** True when the year at `index` (folded text) follows an expiry cue within 16 chars. */
function inExpiryContext(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - EXPIRY_WINDOW), index);
  return EXPIRY_CUE_RE.test(before) || UNTIL_RE.test(before);
}

/** True when `year` occurs in `textNormalized` and every occurrence is an expiry date (so an LLM year is dropped). */
export function isExpiryYearOnly(textNormalized: string, year: number): boolean {
  const text = fold(textNormalized);
  const re = new RegExp(`(?<!\\d)${year}(?!\\d)`, "g");
  let seen = false;
  for (const m of text.matchAll(re)) {
    seen = true;
    if (!inExpiryContext(text, m.index ?? 0)) return false;
  }
  return seen;
}

function extractYear(text: string, def: AttributeDef, now: Date): AttributeValue | undefined {
  for (const kw of text.matchAll(YEAR_KW_RE)) {
    const yi = (kw.index ?? 0) + kw[0].length - 4;
    if (inExpiryContext(text, yi)) continue;
    if (canonValue(def, Number(kw[1]), now) !== undefined) return Number(kw[1]);
  }
  for (const m of text.matchAll(YEAR_BARE_RE)) {
    const i = m.index ?? 0;
    const end = i + 4;
    const before = text.slice(Math.max(0, i - 3), i);
    const after = text.slice(end, end + 2);
    // A number right before the year is a different figure ("12 2018"), unless it ends a model token ("vf3 2025").
    if (/\d$/.test(before) || (/\d[ .-]$/.test(before) && !/[a-z]\d[ .-]$/.test(before))) continue;
    if (/^\d/.test(after) || /^[ .-]\d/.test(after)) continue;
    if (/^\s*(?:tr|k\b|km|cc|m\b)/.test(text.slice(end, end + 6))) continue;
    if (inExpiryContext(text, i)) continue;
    if (canonValue(def, Number(m[0]), now) !== undefined) return Number(m[0]);
  }
  return undefined;
}

function extractOdo(text: string, def: AttributeDef): AttributeValue | undefined {
  const ok = (n: number): AttributeValue | undefined => canonValue(def, n);
  for (const m of text.matchAll(ODO_V_RE)) {
    const i = m.index ?? 0;
    const usesVan = m[3] !== undefined;
    const ctxBefore = text.slice(Math.max(0, i - 15), i);
    const kmAfter = /^\s*km\b/.test(text.slice(i + m[0].length, i + m[0].length + 5));
    if (!usesVan && !/(?<![a-z])(?:odo|di|chay)(?![a-z])/.test(ctxBefore) && !kmAfter) continue;
    const frac = m[2] !== undefined ? Number(m[2]) : m[4] !== undefined ? Number(m[4]) : 0;
    const n = Number(m[1]) * 10_000 + frac * 1_000;
    const v = ok(n);
    if (v !== undefined) return v;
  }
  const kw = ODO_KW_RE.exec(text);
  if (kw) {
    const v = ok(digitsToInt(kw[1] as string));
    if (v !== undefined) return v;
  }
  const km = ODO_KM_RE.exec(text);
  if (km) {
    const v = ok(digitsToInt(km[1] as string));
    if (v !== undefined) return v;
  }
  const kk = ODO_KKM_RE.exec(text) ?? ODO_KW_K_RE.exec(text);
  if (kk) return ok(Number(kk[1]) * 1_000);
  return undefined;
}

/** Regex fast path over folded text; only keys present in `schema` are produced. First valid match per key wins. */
export function extractAttributes(textNormalized: string, schema: AttributeSchema, now: Date = new Date()): Attributes {
  const text = fold(textNormalized);
  const by = new Map(schema.map((d) => [d.key, d]));
  const out: Attributes = {};
  const implied: Attributes[] = [];

  // alias scan first (enum/text), implied keys applied after all own scans
  for (const def of schema) scanAliases(def, text, out, implied);

  const chip = by.get("chip");
  if (chip) {
    const m = CHIP_RE.exec(text);
    if (m) put(out, chip, `m${m[1]}${m[2] ? `_${m[2]}` : ""}`);
    if (!("chip" in out)) {
      const c = CHIP_COMPACT_RE.exec(text);
      if (c) put(out, chip, `m${c[1]}_${c[2] === "p" ? "pro" : "max"}`);
    }
    if (!("chip" in out) && m) put(out, chip, `m${m[1]}`);
  }

  const ram = by.get("ram_gb");
  const ssd = by.get("ssd_gb");
  if (ram || ssd) {
    for (const m of text.matchAll(SLASH_RE)) {
      const r = Number(m[1]);
      const unit = m[3];
      const s = unit === "tb" ? Number(m[2]) * 1024 : Number(m[2]);
      if (unit !== "tb" && s < 64) continue;
      const rOk = ram ? canonValue(ram, r) !== undefined : true;
      const sOk = ssd ? canonValue(ssd, s) !== undefined : true;
      if (rOk && sOk) {
        put(out, ram, r);
        put(out, ssd, s);
        break;
      }
    }
    const r = RAM_RE.exec(text);
    if (r) put(out, ram, Number(r[1]));
    const s = SSD_RE.exec(text);
    if (s) put(out, ssd, s[2] === "tb" ? Number(s[1]) * 1024 : Number(s[1]));
  }

  const storage = by.get("storage_gb");
  if (storage) {
    const m = STORAGE_RE.exec(text) ?? STORAGE_BARE_RE.exec(text);
    if (m) put(out, storage, Number(m[1]));
    else if (STORAGE_TB_RE.test(text)) put(out, storage, 1024);
  }

  const battery = by.get("battery_pct");
  if (battery) {
    const m = BATTERY_RE.exec(text);
    if (m && Number(m[1]) >= 50 && Number(m[1]) <= 100) put(out, battery, Number(m[1]));
  }

  const market = by.get("market");
  if (market) {
    const m = MARKET_RE.exec(text);
    if (m) put(out, market, m[1] as string);
  }

  const screen = by.get("screen_in");
  if (screen) {
    const m = SCREEN_RE.exec(text);
    if (m) put(out, screen, Number(m[1]));
  }

  const year = by.get("year");
  if (year) {
    const y = extractYear(text, year, now);
    if (y !== undefined) put(out, year, y, now);
  }

  const odo = by.get("odo_km");
  if (odo) {
    const v = extractOdo(text, odo);
    if (v !== undefined) put(out, odo, v);
  }

  const seats = by.get("seats");
  if (seats) {
    const m = SEATS_RE.exec(text);
    if (m) put(out, seats, Number(m[1]));
  }

  for (const imp of implied) {
    for (const [k, v] of Object.entries(imp)) put(out, by.get(k), v);
  }
  return out;
}

/** True when `run` (digits) occurs in `hay` as a whole digit run, i.e. not inside a longer number. */
export function containsDigitRun(hay: string, run: string): boolean {
  return new RegExp(`(?<!\\d)${run}(?!\\d)`).test(hay);
}

/** `62.000` / `62,000` -> `62000` so a grouped number in the text can be matched as one digit run. */
export function ungroupDigits(text: string): string {
  return text.replace(/(?<=\d)[.,](?=\d{3}(?!\d))/g, "");
}
