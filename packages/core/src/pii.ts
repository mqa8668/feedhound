// PII masking and author pseudonyms. Pure and browser-safe.
import { sha256Hex } from "./listing";

export const PHONE_MASK = "[SĐT ẩn]";
export const EMAIL_MASK = "[email ẩn]";
export const LINK_MASK = "[link ẩn]";

export const AUTHOR_REF_RE = /^[0-9a-f]{8}$/;

/** `authorKey` (normalize.ts) → stable 8-hex pseudonym under a deployment salt; "" → null. */
export function authorRef(salt: string, authorKey: string): string | null {
  if (authorKey === "") return null;
  return sha256Hex(`${salt}\u001f${authorKey}`).slice(0, 8);
}

export function authorLabel(ref: string | null): string | null {
  return ref === null ? null : `Member #${ref}`;
}

// ---- links and emails ----

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const SHORT_LINK_RE = /(?<![\w@.-])(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:zalo\.me)(?:\/[^\s<]*)?/gi;

function maskLinks(text: string): string {
  return text.replace(SHORT_LINK_RE, LINK_MASK);
}

// ---- phones ----

// Same contact-keyword rule as price.ts (kept local: that regex is not exported).
const KEYWORD_PHONE_RE =
  /(lh|liên hệ|lien he|sđt|sdt|zalo|call|hotline)(\W{0,6})((?<![\d.,])[35789](?:[ .-]?\d){8}(?!\d))(?!\s*(?:đ|₫|vnd|k\b|tr|triệu|trieu|củ|m\b))/gi;

const DIGIT_WORDS: Record<string, string> = {
  khong: "0", mot: "1", hai: "2", ba: "3", bon: "4", tu: "4", nam: "5", lam: "5", sau: "6", bay: "7", tam: "8", chin: "9",
};
const ZERO_WIDTH_RE = /^[\u200B-\u200D\u2060\uFEFF]$/;
const GAP_RE = /^[\s.\-_*/\\|,()+]$/;
const MOBILE_RE = /^0[35789]\d{8}$/;
const LANDLINE_RE = /^02\d{9}$/;
const MARK_TAGS = ["<mark>", "</mark>"];

interface Elem {
  ch: string;
  start: number;
  end: number;
}
interface Tok {
  d: string;
  s: number; // element index range [s, e]
  e: number;
}

function fold(ch: string): string {
  if (ch === "đ" || ch === "Đ") return "d";
  return ch.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Scan copy: zero-width chars, combining marks and (html) `<mark>` tags dropped; each element maps back into the original. */
function elements(text: string, html: boolean): Elem[] {
  const out: Elem[] = [];
  for (let i = 0; i < text.length; ) {
    if (html && text[i] === "<") {
      const tag = MARK_TAGS.find((t) => text.startsWith(t, i));
      if (tag) {
        i += tag.length;
        continue;
      }
    }
    const ch = String.fromCodePoint(text.codePointAt(i) as number);
    const start = i;
    i += ch.length;
    if (ZERO_WIDTH_RE.test(ch) || /^\p{M}$/u.test(ch)) continue;
    out.push({ ch, start, end: i });
  }
  return out;
}

function digitOf(ch: string): string | null {
  if (!/^\p{Nd}$/u.test(ch)) return null;
  const n = ch.normalize("NFKC");
  return /^\d$/.test(n) ? n : null;
}

function tokenize(e: Elem[]): Tok[] {
  const toks: Tok[] = [];
  for (let p = 0; p < e.length; p++) {
    const el = e[p]!;
    const d = digitOf(el.ch);
    if (d !== null) {
      toks.push({ d, s: p, e: p });
      continue;
    }
    const f = fold(el.ch);
    if (f === "o" && p > 0 && p + 1 < e.length && digitOf(e[p - 1]!.ch) !== null && digitOf(e[p + 1]!.ch) !== null) {
      toks.push({ d: "0", s: p, e: p });
      continue;
    }
    if (/^[a-z]$/.test(f) && (p === 0 || !/^[a-z]$/.test(fold(e[p - 1]!.ch)))) {
      let q = p;
      let word = "";
      while (q < e.length && /^[a-z]$/.test(fold(e[q]!.ch))) word += fold(e[q++]!.ch);
      const v = DIGIT_WORDS[word];
      if (v !== undefined) toks.push({ d: v, s: p, e: q - 1 });
      p = q - 1;
    }
  }
  return toks;
}

function splitRuns(e: Elem[], toks: Tok[]): Tok[][] {
  const runs: Tok[][] = [];
  let cur: Tok[] = [];
  for (const t of toks) {
    const prev = cur[cur.length - 1];
    if (prev) {
      let ok = t.s - prev.e - 1 <= 3;
      for (let i = prev.e + 1; ok && i < t.s; i++) if (!GAP_RE.test(e[i]!.ch)) ok = false;
      if (!ok) {
        runs.push(cur);
        cur = [];
      }
    }
    cur.push(t);
  }
  if (cur.length) runs.push(cur);
  return runs;
}

function maskPhones(text: string, html: boolean): string {
  const e = elements(text, html);
  const spans: { s: number; e: number }[] = [];
  for (const run of splitRuns(e, tokenize(e))) {
    const digits = run.map((t) => t.d).join("");
    for (let k = 0; k < run.length; ) {
      let take = 0;
      const w10 = digits.slice(k, k + 10);
      const w11 = digits.slice(k, k + 11);
      if (w10.length === 10 && MOBILE_RE.test(w10)) take = 10;
      else if (w11.length === 11 && LANDLINE_RE.test(w11)) take = 11;
      else if (digits.startsWith("84", k)) {
        if (MOBILE_RE.test(`0${digits.slice(k + 2, k + 11)}`)) take = 11;
        else if (LANDLINE_RE.test(`0${digits.slice(k + 2, k + 12)}`)) take = 12;
      }
      if (take === 0) {
        k++;
        continue;
      }
      let start = e[run[k]!.s]!.start;
      if (text[start - 1] === "+") start--;
      spans.push({ s: start, e: e[run[k + take - 1]!.e]!.end });
      k += take;
    }
  }
  let out = text;
  for (const sp of spans.reverse()) {
    let repl = PHONE_MASK;
    if (html) {
      const inner = out.slice(sp.s, sp.e);
      const opens = inner.split("<mark>").length - 1;
      const closes = inner.split("</mark>").length - 1;
      if (opens > closes) repl = `<mark>${PHONE_MASK}`;
      else if (closes > opens) repl = `${PHONE_MASK}</mark>`;
    }
    out = out.slice(0, sp.s) + repl + out.slice(sp.e);
  }
  return out;
}

// A phone cut by a snippet truncation: trailing 0…/84… digit run (>= 6 digits, separators allowed) at "…" or end of string.
const TRAILING_DIGITS_RE = /(?<!\d[ .-]?)(?<!\+)\+?(?:0|84)(?:[ .-]?\d){5,}(?=…|$)/g;

/** Masks phones, emails and personal profile links. Idempotent. `html`: `<mark>` tags may sit inside a number. */
export function maskPii(text: string, opts: { html?: boolean } = {}): string {
  if (text === "") return text;
  let out = maskLinks(text);
  out = out.replace(EMAIL_RE, EMAIL_MASK);
  out = maskPhones(out, opts.html === true);
  out = out.replace(KEYWORD_PHONE_RE, (_m, kw: string, gap: string) => `${kw}${gap}${PHONE_MASK}`);
  return out.replace(TRAILING_DIGITS_RE, PHONE_MASK);
}
