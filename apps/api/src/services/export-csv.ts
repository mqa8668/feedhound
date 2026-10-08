import { authorKey } from "@feedhound/core/normalize";
import { authorLabel, authorRef, maskPii } from "@feedhound/core/pii";
import type { SearchHit } from "@feedhound/db";

// RFC 4180 CSV, UTF-8 BOM, CRLF, spreadsheet-formula guard.

export const CSV_BOM = "﻿";

export const CSV_COLUMNS = [
  "id",
  "url",
  "source",
  "author",
  "postedAt",
  "firstSeenAt",
  "capture",
  "intent",
  "priceVnd",
  "category",
  "item",
  "confidence",
  "editCount",
  "matchCount",
  "title",
  "text",
] as const;

/** One cell: cells starting with `= + - @` get a `'` prefix; quoted when containing `"`, `,`, CR or LF. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(cells: (string | number | null | undefined)[]): string {
  return `${cells.map(csvCell).join(",")}\r\n`;
}

export function csvHeader(): string {
  return csvLine([...CSV_COLUMNS]);
}

/** Author cell is the pseudonym label; title/text are PII-masked. */
export function csvRow(h: SearchHit, salt: string): string {
  return csvLine([
    h.id,
    h.url,
    h.sourceName,
    authorLabel(authorRef(salt, authorKey(h))),
    h.postedAt,
    h.firstSeenAt,
    h.capture,
    h.enrichment?.intent,
    h.enrichment?.priceVnd,
    h.categoryName,
    h.itemName,
    h.enrichment?.confidence,
    h.editCount,
    h.matchCount,
    h.title === null ? null : maskPii(h.title),
    h.text === undefined || h.text === null ? null : maskPii(h.text),
  ]);
}

/** `corpus-YYYYMMDD-HHmm.csv` (UTC). */
export function exportFilename(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `corpus-${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}.csv`;
}
