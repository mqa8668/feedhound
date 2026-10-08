const MAX_CODE_POINTS = 120;

/**
 * First non-blank line of the normalized text, inner
 * whitespace collapsed; > 120 code points → first 119 + "…". No text → null.
 */
export function deriveSnippet(text: string | null, mask?: (s: string) => string): string | null {
  if (text === null) return null;
  const line = text.split(/\r?\n/).find((l) => l.trim() !== "");
  if (line === undefined) return null;
  const raw = line.trim().replace(/\s+/g, " ");
  // Mask the full line BEFORE cutting so a phone crossing the cut cannot leak its prefix.
  const collapsed = mask ? mask(raw) : raw;
  const points = Array.from(collapsed);
  return points.length > MAX_CODE_POINTS ? `${points.slice(0, MAX_CODE_POINTS - 1).join("")}…` : collapsed;
}
