export interface NormalizedText {
  /** NFC form, lowercased, whitespace collapsed, diacritics kept. */
  nfc: string;
  /** Same as `nfc` but with diacritics stripped (accent-folded). */
  folded: string;
}

/** NFC + lowercase + whitespace collapse, plus a diacritic-folded copy for loose matching. */
export function normalizeText(input: string): NormalizedText {
  const collapsed = input.trim().replace(/\s+/g, " ");
  const nfc = collapsed.normalize("NFC").toLowerCase();
  const folded = nfc
    .replaceAll("đ", "d")
    .replaceAll("Đ", "D")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .normalize("NFC");
  return { nfc, folded };
}

export const FINGERPRINT_TEXT_CHARS = 500;

// Alternation (not one character class) so combining/joiner code points stay separate atoms.
const FINGERPRINT_STRIP_RE =
  /\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}]|[\u{1F1E6}-\u{1F1FF}]|\u{200B}|\u{200C}|\u{200D}|\u{2060}|\u{FEFF}|\u{FE0E}|\u{FE0F}/gu;

/** Normalised full text used for identity: NFC/lowercase, emoji and zero-width chars removed, whitespace collapsed. Not truncated. */
export function comparableText(input: string): string {
  return normalizeText(input).nfc.replace(FINGERPRINT_STRIP_RE, "").replace(/\s+/g, " ").trim();
}

/** `comparableText` cut to the first 500 code points. */
export function fingerprintText(input: string): string {
  return Array.from(comparableText(input)).slice(0, FINGERPRINT_TEXT_CHARS).join("");
}

export function authorKey(a: { authorId?: string | null; authorName?: string | null }): string {
  if (a.authorId) return `id:${a.authorId}`;
  const name = normalizeText(a.authorName ?? "").nfc;
  return name ? `name:${name}` : "";
}
