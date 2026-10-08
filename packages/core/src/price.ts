// Pure VND price parser for Vietnamese marketplace text. No I/O.

/** What the seller actually wrote about the amount. */
export type PriceQualifier = "exact" | "floor" | "ceiling" | "approx" | "range";

/** A masked-digit price is a floor; its confidence never outranks an exact read. */
export const MASKED_PRICE_CONFIDENCE_CAP = 0.5;
/** Only exact/approx prices with at least this confidence are compared (deal, 042, 043, 046). */
export const PRICE_COMPARABLE_MIN_CONF = 0.6;

export function isComparablePrice(q: PriceQualifier | null, conf: number | null): boolean {
  return (q === "exact" || q === "approx") && conf !== null && conf >= PRICE_COMPARABLE_MIN_CONF;
}

export interface PriceCandidate {
  valueVnd: number;
  maxVnd: number | null;
  raw: string;
  index: number;
  qualifier: PriceQualifier;
  role: "asking" | "neutral" | "excluded";
}

export interface ParsedPrice {
  priceVnd: number | null;
  priceRaw: string | null;
  /** Null when no price; `confidence` is 0 then. */
  qualifier: PriceQualifier | null;
  maxVnd: number | null;
  confidence: number;
  range?: { min: number; max: number };
  /**
   * True when `priceVnd` is the lower bound of a digit-masked price (Vietnamese
   * marketplace convention: sellers write `5x.000.000`, `1x.xxx.xxx`, `5xtr`,
   * `2x triệu`, etc. to mean "some digit 1-9 here, exact value withheld"). The
   * true price is `priceVnd` .. `priceVnd + one decade of the masked digit`, so
   * this is a floor, not an exact amount -- callers filtering by price should
   * still treat the post as a candidate, but confidence should be lowered.
   */
  masked?: boolean;
}

const MILLION = 1_000_000;
const THOUSAND = 1_000;
const BILLION = 1_000_000_000;

/** `15` + optional `5` (as first decimal digit) of "k"/"nghìn" -> VND, e.g. 1k5 -> 1_500; 15000k -> 15_000_000. */
function kToVnd(intPart: string, decimalDigit: string | undefined): number {
  const base = Number(intPart) * THOUSAND;
  if (!decimalDigit) return base;
  return base + Number(decimalDigit) * (THOUSAND / 10);
}

/** Strips thousand separators (`.` or `,`) from a grouped number like "15.500.000" or "15,000,000". */
function groupedToNumber(text: string): number {
  return Number(text.replace(/[.,]/g, ""));
}

/** Replaces every masked digit with `0` to get the range's lower bound. */
function maskedToZero(s: string): string {
  return s.replace(/x/g, "0");
}

interface MaskedPrice {
  priceVnd: number;
  priceRaw: string;
  masked: true;
}

const MASKED_GROUPED_RE = /\b([\dx]{1,3}(?:[.,][\dx]{3})+)\b/;
const MASKED_TR_RE = /\b([\dx]{1,3})\s*(?:tr|triệu|trieu)\b/;
const MASKED_K_RE = /\b([\dx]{1,3})\s*(?:nghìn|nghin|k)\b/;
/** `1 tỷ 1xx triệu` / `1ty1xx` / `1 tỷ 2x` (text folded to `ty`): the billions prefix must never be dropped. */
const MASKED_TY_RE = /\b(\d+)\s*ty\s*([\dx]{1,3})(?![a-zà-ỹ])(\s*(?:tr|triệu|trieu|củ)\b)?/;
const MASKED_BARE_MIN_LEN = 6;

/** Lower/upper VND bounds of a masked `N tỷ XX[ triệu]` match, or null when the tail has no masked digit. */
function maskedTyBounds(m: RegExpExecArray): { min: number; max: number } | null {
  const tail = m[2] as string;
  if (!tail.includes("x")) return null;
  const padded = m[3] ? tail : tail.padEnd(3, "x");
  const base = Number(m[1]) * BILLION;
  return {
    min: base + Number(padded.replace(/x/g, "0")) * MILLION,
    max: base + Number(padded.replace(/x/g, "9")) * MILLION + (MILLION - 1),
  };
}
const MASKED_BARE_RE = /\b(\d*x[\dx]*)\b/;

/**
 * Detects the Vietnamese marketplace "masked digit" price convention --
 * sellers write `5x.000.000`, `1x.xxx.xxx`, `5xtr`, `2x triệu` etc. to mean
 * "exact price withheld, this digit is 1-9". Deterministic regex, runs before
 * any exact-number parsing so a masked price can never be reported as a
 * fabricated exact amount (by the LLM or otherwise). Returns the lower bound
 * (masked digits -> `0`) with `masked: true`, or null if `text` has no `x`/`X`.
 */
export function detectMaskedPrice(text: string): MaskedPrice | null {
  const lower = text.toLowerCase();
  if (!lower.includes("x")) return null;

  const ty = MASKED_TY_RE.exec(lower);
  const tyBounds = ty ? maskedTyBounds(ty) : null;
  if (ty && tyBounds) return { priceVnd: tyBounds.min, priceRaw: ty[0], masked: true };

  let m = MASKED_GROUPED_RE.exec(lower);
  if (m && (m[1] as string).includes("x")) {
    const digits = maskedToZero((m[1] as string).replace(/[.,]/g, ""));
    return { priceVnd: Number(digits), priceRaw: m[1] as string, masked: true };
  }

  m = MASKED_TR_RE.exec(lower);
  if (m && (m[1] as string).includes("x")) {
    return { priceVnd: Number(maskedToZero(m[1] as string)) * MILLION, priceRaw: m[0], masked: true };
  }

  m = MASKED_K_RE.exec(lower);
  if (m && (m[1] as string).includes("x")) {
    return { priceVnd: Number(maskedToZero(m[1] as string)) * THOUSAND, priceRaw: m[0], masked: true };
  }

  m = MASKED_BARE_RE.exec(lower);
  if (m) {
    const candidate = m[1] as string;
    if (candidate.length >= MASKED_BARE_MIN_LEN && /\d/.test(candidate)) {
      const value = Number(maskedToZero(candidate));
      if (Number.isFinite(value) && value > 0) {
        return { priceVnd: value, priceRaw: candidate, masked: true };
      }
    }
  }

  return null;
}

interface MaskedHit {
  value: number;
  raw: string;
  index: number;
  max?: number;
}

/** Every masked-digit hit with its position; non-overlapping, priority grouped > tr > k > bare. */
function maskedHits(lower: string): MaskedHit[] {
  if (!lower.includes("x")) return [];
  const hits: MaskedHit[] = [];
  const free = (index: number, len: number): boolean => hits.every((h) => index >= h.index + h.raw.length || index + len <= h.index);
  const collect = (re: RegExp, value: (m: RegExpExecArray) => number | null, raw: (m: RegExpExecArray) => string): void => {
    for (const m of lower.matchAll(new RegExp(re.source, "g"))) {
      const v = value(m);
      const r = raw(m);
      if (v !== null && Number.isFinite(v) && v > 0 && free(m.index, r.length)) hits.push({ value: v, raw: r, index: m.index });
    }
  };
  for (const m of lower.matchAll(new RegExp(MASKED_TY_RE.source, "g"))) {
    const b = maskedTyBounds(m);
    if (b && free(m.index, m[0].length)) hits.push({ value: b.min, max: b.max, raw: m[0], index: m.index });
  }
  collect(
    MASKED_GROUPED_RE,
    (m) => ((m[1] as string).includes("x") ? Number(maskedToZero((m[1] as string).replace(/[.,]/g, ""))) : null),
    (m) => m[1] as string,
  );
  collect(MASKED_TR_RE, (m) => ((m[1] as string).includes("x") ? Number(maskedToZero(m[1] as string)) * MILLION : null), (m) => m[0]);
  collect(MASKED_K_RE, (m) => ((m[1] as string).includes("x") ? Number(maskedToZero(m[1] as string)) * THOUSAND : null), (m) => m[0]);
  collect(
    MASKED_BARE_RE,
    (m) => ((m[1] as string).length >= MASKED_BARE_MIN_LEN && /\d/.test(m[1] as string) ? Number(maskedToZero(m[1] as string)) : null),
    (m) => m[1] as string,
  );
  return hits;
}

const TR_UNIT = /(tr|triệu|trieu|củ)/;
const K_UNIT = /(nghìn|nghin|k)/;

/** `19tr500` / `19tr5` / `19 triệu 500`: 1-3 trailing digits are the decimal fraction of the million. */
function trToVndFraction(intPart: string, frac: string | undefined): number {
  if (!frac) return Number(intPart) * MILLION;
  return Math.round((Number(intPart) + Number(frac) / 10 ** frac.length) * MILLION);
}

/** Parses one scalar amount + optional unit at the start of `segment`. Returns VND and consumed length, or null. */
function parseScalar(segment: string): { value: number; len: number } | null {
  const s = segment.trim();
  const hit = (value: number, m: RegExpExecArray): { value: number; len: number } => ({ value, len: m[0].trimEnd().length });

  // Dotted/comma decimal before the unit, e.g. "9.5tr" -> 9.5 triệu.
  let m = /^(\d+)[.,](\d+)\s*(?:tr|triệu|trieu)\b/.exec(s);
  if (m) return hit(Number(`${m[1]}.${m[2]}`) * MILLION, m);
  m = /^(\d+)[.,](\d+)\s*(?:nghìn|nghin|k)\b/.exec(s);
  if (m) return hit(Number(`${m[1]}.${m[2]}`) * THOUSAND, m);

  // "củ" is slang for triệu: "185 củ" -> 185 triệu, "9,5 củ" -> 9.5 triệu.
  m = /^(\d+)(?:[.,](\d+))?\s*củ(?![a-zà-ỹ])/.exec(s);
  if (m) return hit(Number(m[2] ? `${m[1]}.${m[2]}` : (m[1] as string)) * MILLION, m);

  // "19tr500", "19tr5", "19 triệu 500" -> 19.5 triệu.
  m =
    /^(\d+)\s*(?:tr|triệu|trieu)\s*(\d{1,3})(?!\d|\s*(?:km|cho|tr\b|k\b|nghìn|nghin|%|ch[uủ]|đ[oờ]i|m[aá]y|c[aá]i|chi[eế]c|xe|n[aă]m))\b/.exec(s);
  if (m) return hit(trToVndFraction(m[1] as string, m[2] as string), m);

  m = /^(\d+)\s*tr(?![a-zà-ỹ])/.exec(s) ?? /^(\d+)\s*(?:triệu|trieu)(?![a-zà-ỹ])/.exec(s);
  if (m) return hit(Number(m[1]) * MILLION, m);

  m = /^(\d+)\s*(?:nghìn|nghin)\s*(\d)?\b/.exec(s) ?? /^(\d+)\s*k\s*(\d)?\b/.exec(s);
  if (m) return hit(kToVnd(m[1] as string, m[2]), m);

  m = /^(\d{1,3}(?:[.,]\d{3})+)\s*(?:đ|d|vnd)?\b/.exec(s);
  if (m) return hit(groupedToNumber(m[1] as string), m);

  m = /^(\d+)\s*(?:đ|vnd)\b/.exec(s);
  if (m) return hit(Number(m[1]), m);

  // Last resort: a bare 4+ digit number with no unit/currency marker at all
  // (e.g. "7000000") is still treated as a literal VND amount.
  m = /^(\d{4,})\b/.exec(s);
  if (m) return hit(Number(m[1]), m);

  return null;
}

/** `1 tỷ 2` / `1,2 tỷ` / `1ty250` at the start of `segment` (text already has `tỷ` folded to `ty`). */
function parseTy(segment: string): { value: number; raw: string } | null {
  const s = segment.trim();
  // "1 tỷ 200 triệu" / "1 tỷ 200tr" / "1ty 200 củ": the tail is millions, not a decimal fraction.
  const big = /^(\d+)\s*ty\s*(\d{1,3})\s*(?:tr|triệu|trieu|củ)(?![a-zà-ỹ])/.exec(s);
  if (big) return { value: Number(big[1]) * BILLION + Number(big[2]) * MILLION, raw: big[0] };
  let m = /^(\d+)[.,](\d+)\s*ty(?![a-z])/.exec(s);
  if (m) return { value: Math.round(Number(`${m[1]}.${m[2]}`) * BILLION), raw: m[0] };
  m = /^(\d+)\s*ty(?![a-z])(?:\s*(\d{1,3})(?!\d|\s*(?:cho|tr|k\b)))?/.exec(s);
  if (!m) return null;
  const frac = m[2] ? Number(`0.${m[2]}`) : 0;
  return { value: Math.round((Number(m[1]) + frac) * BILLION), raw: m[0] };
}

const RANGE_RE =
  /(?<!\d)(\d+(?:[.,]\d+)?)\s*(tr|triệu|trieu|củ|nghìn|nghin|k|ty)?\s*(?:-|đến|toi|tới)\s*(\d+(?:[.,]\d+)?)\s*(tr|triệu|trieu|củ|nghìn|nghin|k|ty)?/;

function unitMultiplier(unit: string | undefined): number | null {
  if (!unit) return null;
  if (unit === "ty") return BILLION;
  if (TR_UNIT.test(unit)) return MILLION;
  if (K_UNIT.test(unit)) return THOUSAND;
  return null;
}

/** Converts a range side's numeric text (may itself have a `.`/`,` decimal point) plus unit into VND. */
function rangeSideToVnd(numText: string, unit: string): number {
  const mult = unitMultiplier(unit);
  const num = Number(numText.replace(",", "."));
  return mult ? num * mult : num;
}

/** Global sanity bounds: anything outside is a phone fragment, year, id, etc. -- not a price. */
const MIN_PRICE_VND = 10_000;
/** Largest price any category accepts (cars); per-category bounds narrow it. */
export const MAX_PRICE_VND = 5_000_000_000;
/** Upper bound for categories without their own bounds. */
export const DEFAULT_PRICE_MAX_VND = 2_000_000_000;

/** `explicitUnit`: the text carried a k/tr marker, so small values ("1k5" = 1.500) are legitimate. */
function inBounds(v: number, explicitUnit = false): boolean {
  return Number.isFinite(v) && v > 0 && (explicitUnit || v >= MIN_PRICE_VND) && v <= MAX_PRICE_VND;
}

// Vietnamese phone: starts with 0 / 84 / +84, 9-11 digits (separators `.`, space, `-` ignored).
export const PHONE_RE = /(?<![\d.,])(?:\+?84|0)(?:[ .-]?\d){8,10}(?!\d)/g;
// 9-digit run (leading 0 dropped) right after a contact keyword and with no currency/unit marker after.
const KEYWORD_PHONE_RE =
  /(lh|liên hệ|lien he|sđt|sdt|zalo|call|hotline)(\W{0,6})((?<![\d.,])[35789](?:[ .-]?\d){8}(?!\d))(?!\s*(?:đ|₫|vnd|k\b|tr|triệu|trieu|củ|m\b))/g;

/** Blanks out phone numbers so their digits are never read as a price. Same length preserved. */
function stripPhones(lower: string): string {
  const blank = (s: string): string => " ".repeat(s.length);
  return lower
    .replace(PHONE_RE, blank)
    .replace(KEYWORD_PHONE_RE, (_m, kw: string, gap: string, num: string) => kw + gap + blank(num));
}

const MARKER_RE = /(đ|₫|vnd|k|tr|triệu|trieu|củ|tỷ|ty|m)\b|đ|₫/;

/** Unmarked 9-digit-ish value (>= 100M) not ending in 000: a phone written without its leading 0, not a price. */
function isBareNinePhone(value: number, raw: string): boolean {
  return value >= 100_000_000 && value % 1000 !== 0 && !MARKER_RE.test(raw.toLowerCase());
}

/**
 * A no-unit price whose digits (after removing `.`, `,`, spaces) are exactly 9 and do not end in
 * `000` is a phone number written without its leading 0, not a price.
 */
export function isPhoneShapedPrice(priceRaw: string | null): boolean {
  if (priceRaw === null) return false;
  const lower = priceRaw.toLowerCase();
  if (/(?:k|tr|triệu|trieu|củ|tỷ|ty|đ|₫|vnd)(?![a-z])|[đ₫]/.test(lower)) return false;
  const digits = lower.replace(/[.,\s]/g, "");
  return /^\d{9}$/.test(digits) && !digits.endsWith("000");
}

/** The text carried a k/tr marker, so small values are legitimate. */
const EXPLICIT_UNIT_RE = /^\d[\d.,]*\s*(?:tr|triệu|trieu|củ|nghìn|nghin|k)(?![a-zà-ỹ])/;
const ROLE_WINDOW = 20;
const QUALIFIER_WINDOW = 12;

const EXCLUDED_CUES = [
  "coc", "dat coc", "tra truoc", "tra gop", "gop", "lai suat", "giam", "bot", "phi", "thue", "bao hiem", "(?<!dung |chat |so |trong |khoi )luong",
  "thu nhap", "do them", "do choi", "mua moi", "gia moi", "niem yet", "gia hang",
];
const ASKING_CUES = ["gia", "ban", "ra di", "chot", "con", "fix", "thanh ly", "pass", "sale", "price"];
const cueRe = (cues: string[]): RegExp => new RegExp(`(?<![a-z0-9])(?:${cues.join("|")})(?![a-z0-9])`, "g");
const EXCLUDED_RE = cueRe(EXCLUDED_CUES);
const ASKING_RE = cueRe(ASKING_CUES);
const FLOOR_BEFORE_RE = /(?<![a-z0-9])(?:hon|tren|ngoai)(?![a-z0-9])|>/;
const FLOOR_AFTER_RE = /^\s*(?:tro len(?![a-z0-9])|\+)/;
const CEILING_BEFORE_RE = /(?<![a-z0-9])(?:duoi|toi da|khong qua|(?<!pro )max)(?![a-z0-9])|</g;
const CEILING_AFTER_RE = /^\s*(?:do lai|tro xuong|tro lai)(?![a-z0-9])/;
const APPROX_RE = /(?<![a-z0-9])(?:khoang|tam|xap xi)(?![a-z0-9])|~/;

/** Same-length diacritic fold (đ -> d) so indexes line up with the lowercased text. */
function foldSameLength(lower: string): string {
  let out = "";
  for (const ch of lower) {
    if (ch === "đ") out += "d";
    else if (ch.length === 1) out += ch.normalize("NFD")[0] ?? ch;
    else out += ch;
  }
  return out;
}

/** End index of the last cue match in `window`, or -1. */
function lastCueEnd(re: RegExp, window: string): number {
  let end = -1;
  for (const m of window.matchAll(re)) end = m.index + m[0].length;
  return end;
}

function roleOf(folded: string, index: number): PriceCandidate["role"] {
  const window = folded.slice(Math.max(0, index - ROLE_WINDOW), index);
  const ex = lastCueEnd(EXCLUDED_RE, window);
  const as = lastCueEnd(ASKING_RE, window);
  if (ex < 0 && as < 0) return "neutral";
  // The cue nearest the number wins ("bán 390tr" after "trả trước 50tr").
  return ex >= as ? "excluded" : "asking";
}

/** Ceiling cue within QUALIFIER_WINDOW before `index`, evaluated with extra left context so "pro max" is never cut. */
function ceilingBefore(folded: string, index: number): boolean {
  const start = Math.max(0, index - QUALIFIER_WINDOW - 8);
  const ctx = folded.slice(start, index);
  for (const m of ctx.matchAll(CEILING_BEFORE_RE)) if (start + m.index >= index - QUALIFIER_WINDOW) return true;
  return false;
}

function qualifierOf(folded: string, index: number, end: number): PriceQualifier {
  const before = folded.slice(Math.max(0, index - QUALIFIER_WINDOW), index);
  const after = folded.slice(end, end + QUALIFIER_WINDOW);
  if (FLOOR_BEFORE_RE.test(before) || FLOOR_AFTER_RE.test(after)) return "floor";
  if (ceilingBefore(folded, index) || CEILING_AFTER_RE.test(after)) return "ceiling";
  if (APPROX_RE.test(before)) return "approx";
  return "exact";
}

interface Prepared {
  lower: string;
  folded: string;
}

/** ReDoS guard: only the first 4000 chars (after tỷ folding) are parsed; real posts' prices sit far earlier. */
const MAX_PARSE_CHARS = 4000;

function prepare(text: string): Prepared {
  const lower = stripPhones(text.normalize("NFC").toLowerCase().replaceAll("tỷ", "ty").replaceAll("tỉ", "ty").slice(0, MAX_PARSE_CHARS));
  return { lower, folded: foldSameLength(lower) };
}

interface RawHit {
  value: number;
  max: number | null;
  raw: string;
  index: number;
  kind: "masked" | "range" | "scalar";
}

function collectHits(lower: string): { hits: RawHit[]; phoneRaw: string | null } {
  const hits: RawHit[] = [];
  const taken = (index: number, len: number): boolean => hits.some((h) => index < h.index + h.raw.length && index + len > h.index);

  for (const h of maskedHits(lower)) hits.push({ value: h.value, max: h.max ?? null, raw: h.raw, index: h.index, kind: "masked" });

  for (const rangeMatch of lower.matchAll(new RegExp(RANGE_RE.source, "g"))) {
    const [, minText, minUnitRaw, maxText, maxUnitRaw] = rangeMatch;
    const sharedUnit = maxUnitRaw ?? minUnitRaw;
    const minUnit = minUnitRaw ?? sharedUnit;
    const maxUnit = maxUnitRaw ?? sharedUnit;
    if (!minUnit || !maxUnit || taken(rangeMatch.index, rangeMatch[0].length)) continue;
    // A unit-less start that merely inherits the end's unit must be the same order of magnitude ("Mazda 3 - 550tr" is no range).
    // Only a 1-2 digit start against a 100+ end at least 20x larger is a model/count prefix ("90-950k" stays a range).
    if (!minUnitRaw && /^\d{1,2}$/.test(minText!)) {
      const maxNum = Number(maxText!.replace(",", "."));
      if (maxNum >= 100 && Number(minText) * 20 < maxNum) continue;
    }
    const min = rangeSideToVnd(minText as string, minUnit);
    const max = rangeSideToVnd(maxText as string, maxUnit);
    if (inBounds(min, true) && inBounds(max, true) && max >= min) {
      hits.push({ value: min, max, raw: rangeMatch[0], index: rangeMatch.index, kind: "range" });
    }
  }

  // Scan for scalar matches anywhere in the text (not just at the start).
  const scalarScan = /(\d[\d.,]*)\s*(tr\d?|triệu\d?|trieu\d?|củ|nghìn\d?|nghin\d?|k\d?|ty\d*|đ|d\b|vnd)?/g;
  let match: RegExpExecArray | null;
  let phoneRaw: string | null = null;
  while ((match = scalarScan.exec(lower))) {
    const candidate = lower.slice(match.index);
    const ty = parseTy(candidate);
    if (ty) {
      const raw = ty.raw.trim();
      scalarScan.lastIndex = Math.max(scalarScan.lastIndex, match.index + raw.length);
      if (inBounds(ty.value, true) && !taken(match.index, raw.length)) {
        hits.push({ value: ty.value, max: null, raw, index: match.index, kind: "scalar" });
      }
      continue;
    }
    const parsed = parseScalar(candidate);
    const rawMatch = match[0].trim();
    const raw = parsed ? candidate.slice(0, parsed.len).trim() : rawMatch;
    if (parsed) scalarScan.lastIndex = Math.max(scalarScan.lastIndex, match.index + raw.length);
    if (taken(match.index, raw.length)) continue;
    if (parsed !== null && isBareNinePhone(parsed.value, match[0])) {
      phoneRaw ??= rawMatch.replace(/[.,]+$/, "");
      continue;
    }
    if (parsed !== null && inBounds(parsed.value, EXPLICIT_UNIT_RE.test(raw))) {
      hits.push({ value: parsed.value, max: null, raw, index: match.index, kind: "scalar" });
    }
  }
  hits.sort((a, b) => a.index - b.index);
  return { hits, phoneRaw };
}

function toCandidates(prep: Prepared, hits: RawHit[]): PriceCandidate[] {
  return hits.map((h) => {
    const end = h.index + h.raw.length;
    let qualifier: PriceQualifier = qualifierOf(prep.folded, h.index, end);
    if (h.kind === "range") qualifier = "range";
    else if (h.kind === "masked") qualifier = h.max !== null ? "range" : "floor";
    return {
      valueVnd: h.value,
      maxVnd: h.max,
      raw: h.raw.trim(),
      index: h.index,
      qualifier,
      role: roleOf(prep.folded, h.index),
    };
  });
}

/** Every price-like hit (masked, range, tỷ, scalar) with its role and qualifier, in text order. */
export function priceCandidates(text: string): PriceCandidate[] {
  const prep = prepare(text);
  return toCandidates(prep, collectHits(prep.lower).hits);
}

function confidenceOf(c: PriceCandidate, masked: boolean): number {
  if (masked) return MASKED_PRICE_CONFIDENCE_CAP;
  if (c.qualifier === "approx" || c.qualifier === "range") return 0.6;
  if (c.qualifier === "floor" || c.qualifier === "ceiling") return 0.5;
  return c.role === "asking" ? 0.9 : 0.7;
}

export function parsePrice(text: string): ParsedPrice {
  const prep = prepare(text);
  const { hits, phoneRaw } = collectHits(prep.lower);
  const candidates = toCandidates(prep, hits);
  const picked = candidates.find((c) => c.role === "asking") ?? candidates.find((c) => c.role === "neutral");
  if (!picked) {
    // A phone-shaped number is not a price, but its raw text is kept so callers can flag the post.
    const excluded = candidates.find((c) => c.role === "excluded");
    return { priceVnd: null, priceRaw: excluded?.raw ?? phoneRaw, qualifier: null, maxVnd: null, confidence: 0 };
  }
  const isMasked = hits.find((h) => h.index === picked.index)?.kind === "masked";
  const out: ParsedPrice = {
    priceVnd: picked.valueVnd,
    priceRaw: picked.raw,
    qualifier: picked.qualifier,
    maxVnd: picked.maxVnd,
    confidence: confidenceOf(picked, isMasked),
  };
  if (picked.qualifier === "range" && picked.maxVnd !== null) out.range = { min: picked.valueVnd, max: picked.maxVnd };
  if (isMasked) out.masked = true;
  return out;
}

/**
 * An LLM price is believable only when its digits appear in the text as a whole digit run: the full
 * amount ("19500000"), or the shown part in millions / thousands ("230" for 230tr, "19" for 19tr5).
 */
export function isPriceGrounded(text: string, vnd: number): boolean {
  const folded = text.toLowerCase();
  const ungrouped = folded.replace(/(?<=\d)[.,](?=\d{3}(?!\d))/g, "");
  const noDecimals = folded.replace(/(?<=\d)[.,](?=\d)/g, "");
  const runs = new Set<string>([String(vnd)]);
  if (vnd >= MILLION) runs.add(String(Math.trunc(vnd / MILLION)));
  if (vnd >= THOUSAND && vnd % THOUSAND === 0) runs.add(String(vnd / THOUSAND));
  for (const run of runs) {
    const re = new RegExp(`(?<!\\d)${run}(?!\\d)`);
    if (re.test(ungrouped) || re.test(noDecimals)) return true;
  }
  return false;
}
