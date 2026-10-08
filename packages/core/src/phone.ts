// Vietnamese mobile number detection for listing cards. Pure, browser-safe.
import { PHONE_RE } from "./price";

const VALID_MOBILE_RE = /^0[35789]\d{8}$/;

/** First `PHONE_RE` match that normalises to a valid 10-digit mobile number ("84…" → "0…"), else null. */
export function detectPhone(text: string): string | null {
  for (const m of text.matchAll(new RegExp(PHONE_RE.source, "g"))) {
    let digits = m[0].replace(/\D/g, "");
    if (digits.startsWith("84")) digits = `0${digits.slice(2)}`;
    if (VALID_MOBILE_RE.test(digits)) return digits;
  }
  return null;
}

/** "0912345678" → "0912 ••• 78". */
export function maskPhone(p: string): string {
  if (p.length < 6) return p;
  return `${p.slice(0, 4)} ••• ${p.slice(-2)}`;
}
