import { maskPii } from "./pii";
import { STOPWORDS } from "./stopwords";

// Entity-style trend terms (product models, brands, product types, events) instead of unigrams.

/** Bump when term extraction changes; hist rows carry it as `extractor` so old rows are rebuilt. */
export const TREND_EXTRACTOR_VERSION = 2;

const TOKEN_RE = /[\p{L}\p{N}]+/gu;
const URL_RE = /(?:https?:\/\/|www\.)\S+/gu;
const MAX_TOKENS = 300;
const MAX_NGRAM = 4;
const MAX_RULE_TERMS = 30;
const MAX_DISPLAY_LEN = 48;
const PII_DIGITS_RE = /\d{7,}/;

/** Words that carry no product meaning on a marketplace feed (both edge tokens of a rule n-gram must avoid them). */
const GENERIC_TOKENS: ReadonlySet<string> = new Set([
  "xe", "máy", "may", "xem", "chỉ", "chi", "đẹp", "dep", "bán", "mua", "cần", "can", "giá", "gia", "còn", "con", "mới", "moi", "cũ", "cu",
  "ib", "inbox", "zalo", "ship", "lh", "liên", "hệ", "sdt", "đt", "call", "gọi", "goi", "chính", "chủ", "chu", "full", "fullbox", "bao",
  "rẻ", "re", "tốt", "tot", "ok", "oke", "nhiều", "nhieu", "ít", "đủ", "du", "hàng", "hang", "sản", "phẩm", "pham", "cái", "cai", "chiếc",
  "đồ", "do", "dùng", "dung", "sử", "dụng", "tặng", "tang", "thanh", "lý", "ly", "pass", "send", "tìm", "tim", "thích", "thich", "hỏi",
  "hoi", "quan", "tâm", "tam", "nhận", "nhan", "trao", "đổi", "doi", "gấp", "gap", "ngay", "hôm", "nay", "mai", "tại", "chỗ", "cho",
  "xin", "cảm", "ơn", "on", "thanks", "hot", "sale", "like", "good", "best", "price", "contact", "call", "free", "đang", "dang", "vẫn",
  "van", "rất", "rat", "lắm", "lam", "luôn", "luon", "nữa", "nua", "thêm", "them", "hơn", "hon", "nhất", "nhat", "việc", "viec",
]);

const HONORIFICS: ReadonlySet<string> = new Set(["anh", "chị", "em", "a", "c", "e", "bác", "cô", "chú", "mr", "ms"]);

/** Common Vietnamese surnames (lower-case, with diacritics). */
const SURNAMES: ReadonlySet<string> = new Set([
  "nguyễn", "trần", "lê", "phạm", "hoàng", "huỳnh", "phan", "vũ", "võ", "đặng", "bùi", "đỗ", "hồ", "ngô", "dương", "lý", "đinh", "đoàn",
  "trịnh", "lâm", "lương", "quách", "diệp", "phùng",
]);

/** Deterministic person-name heuristic: 2-4 capitalised letter-only tokens led by a common surname. */
export function looksLikePersonName(display: string): boolean {
  const raw = display.normalize("NFC").trim().split(/\s+/);
  if (raw.length < 2 || raw.length > 4) return false;
  if (!raw.every((t) => /^\p{Lu}\p{L}*$/u.test(t))) return false;
  return SURNAMES.has(raw[0]!.toLowerCase());
}

/** NFC, lower-case, đ→d, diacritics stripped, every non-[a-z0-9] dropped. */
export function trendKey(display: string): string {
  return display
    .normalize("NFC")
    .toLowerCase()
    .replace(/đ/g, "d")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function tokensOf(term: string): string[] {
  return term.normalize("NFC").toLowerCase().match(TOKEN_RE) ?? [];
}

function capitalise(tok: string): string {
  if (/\d/.test(tok) || tok.length === 0) return tok;
  return tok.charAt(0).toUpperCase() + tok.slice(1);
}

/** "mercedes_benz" -> "Mercedes Benz"; tokens with a digit keep their case. */
function titleCase(raw: string): string {
  return raw
    .normalize("NFC")
    .split(/[\s_]+/)
    .filter((t) => t.length > 0)
    .map(capitalise)
    .join(" ");
}

function attrString(v: unknown): string | null {
  if (typeof v === "string") return v.trim() === "" ? null : v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/** Catalogue item name, then "Make Model Year", "Make Model", "Make". */
function attributeTerms(i: { attributes: Record<string, unknown> | null; itemName: string | null }): string[] {
  const out: string[] = [];
  if (i.itemName && i.itemName.trim() !== "") out.push(i.itemName.trim());
  const a = i.attributes;
  if (a) {
    const makeRaw = attrString(a.make);
    const modelRaw = attrString(a.model);
    const yearRaw = attrString(a.year);
    if (makeRaw) {
      const make = titleCase(makeRaw);
      const model = modelRaw ? titleCase(modelRaw) : null;
      const year = yearRaw && /^\d{4}$/.test(yearRaw) ? yearRaw : null;
      if (model && year) out.push(`${make} ${model} ${year}`);
      if (model) out.push(`${make} ${model}`);
      out.push(make);
    }
  }
  return out;
}

function hasLetter(tok: string): boolean {
  return /\p{L}/u.test(tok);
}

/** Tokens that survive (the `trending.ts` rules): no 1-letter words, no long digit runs, no URLs, no stopwords. */
function keepToken(tok: string): boolean {
  if (tok.length < 2 && !/^\p{N}$/u.test(tok)) return false;
  if (/^\p{N}{8,}$/u.test(tok)) return false;
  if (tok.startsWith("http") || tok.startsWith("www")) return false;
  return !STOPWORDS.has(tok);
}

/** 2-4-grams whose edge tokens are meaningful. Never spans a dropped token or a line break. */
function ngramTerms(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let budget = MAX_TOKENS;
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    if (budget <= 0 || out.length >= MAX_RULE_TERMS) break;
    const toks = (rawLine.normalize("NFC").toLowerCase().replace(URL_RE, " http ").match(TOKEN_RE) ?? []).slice(0, budget);
    budget -= toks.length;
    let run: string[] = [];
    let afterHonorific = false; // the dropped token before this run was "anh", "chị", "cô"...: the run starts with a person name
    const flush = (): void => {
      // Tokens of a probable person name (surname + up to 2 more, or up to 3 after an honorific) never join an n-gram.
      const nameTok = new Set<number>();
      const mark = (from: number): void => {
        for (let k = from; k < Math.min(run.length, from + 3); k++) nameTok.add(k);
      };
      if (afterHonorific) mark(0);
      run.forEach((t, k) => {
        if (HONORIFICS.has(t)) mark(k + 1);
        else if (SURNAMES.has(t) && k + 1 < run.length) mark(k);
      });
      for (let s = 0; s < run.length; s++) {
        const first = run[s]!;
        if (nameTok.has(s)) continue;
        if (GENERIC_TOKENS.has(first) || HONORIFICS.has(first)) continue;
        for (let n = 2; n <= MAX_NGRAM && s + n <= run.length; n++) {
          const gram = run.slice(s, s + n);
          if (gram.some((_, k) => nameTok.has(s + k))) break;
          const last = gram[gram.length - 1]!;
          if (GENERIC_TOKENS.has(last)) continue;
          if (!gram.some(hasLetter)) continue;
          const display = gram.map(capitalise).join(" ");
          const key = trendKey(display);
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(display);
          if (out.length >= MAX_RULE_TERMS) return;
        }
      }
    };
    for (const tok of toks) {
      if (keepToken(tok)) run.push(tok);
      else {
        flush();
        run = [];
        afterHonorific = HONORIFICS.has(tok);
      }
      if (out.length >= MAX_RULE_TERMS) break;
    }
    flush();
  }
  return out;
}

/** Rule-derived candidates (attribute / item terms, then n-grams), before sanitising. */
export function ruleTrendTerms(i: { text: string; attributes: Record<string, unknown> | null; itemName: string | null }): string[] {
  return [...attributeTerms(i), ...ngramTerms(i.text)];
}

export function postTrendTerms(i: {
  text: string;
  attributes: Record<string, unknown> | null;
  itemName: string | null;
  llmTerms: string[] | null;
  authorNames: string[];
  max: number;
}): string[] {
  const llm = i.llmTerms ?? [];
  const makeRaw = i.attributes ? attrString(i.attributes.make) : null;
  const makeKey = makeRaw ? trendKey(titleCase(makeRaw)) : null;
  const llmKeys = new Set(llm.map((t) => trendKey(t)));
  const rest = llm.length > 0 ? attributeTerms(i) : ruleTrendTerms(i);
  const authorKeys = i.authorNames.map(trendKey).filter((k) => k.length > 0);

  const out: string[] = [];
  const seen = new Set<string>();
  const consider = (raw: string, fromLlm: boolean): void => {
    const display = raw.normalize("NFC").replace(/\s+/g, " ").trim();
    if (display === "" || display.length > MAX_DISPLAY_LEN) return;
    const key = trendKey(display);
    if (key === "" || seen.has(key)) return;
    const toks = tokensOf(display);
    if (toks.length === 0) return;
    if (looksLikePersonName(display)) return;
    if (toks.length === 1 && !fromLlm && key !== makeKey) return;
    if (toks.every((t) => GENERIC_TOKENS.has(t) || STOPWORDS.has(t))) return;
    if (maskPii(display) !== display || PII_DIGITS_RE.test(display)) return;
    if (key.length >= 4 && authorKeys.some((a) => a.includes(key))) return;
    seen.add(key);
    out.push(display);
  };
  for (const t of llm) {
    consider(t, true);
    if (out.length >= i.max) return out;
  }
  for (const t of rest) {
    consider(t, llmKeys.has(trendKey(t)));
    if (out.length >= i.max) break;
  }
  return out.slice(0, i.max);
}

/** Lift = (count+1)/(baseline+1); a term is "new" when its 24 h baseline is below half a mention. */
export function trendLift(count: number, baseline: number): { lift: number; isNew: boolean; deltaPct: number | null } {
  const isNew = baseline < 0.5;
  return {
    lift: (count + 1) / (baseline + 1),
    isNew,
    deltaPct: isNew ? null : Math.round((count / baseline - 1) * 100),
  };
}
