import type { Button } from "@feedhound/core/notifiers";

const MAX_MESSAGE_CHARS = 4096;

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** "12.500.000 VND" | "—". */
export function formatPriceVnd(priceVnd: number | null | undefined): string {
  if (priceVnd === null || priceVnd === undefined) return "—";
  return `${Math.round(priceVnd).toLocaleString("vi-VN")} VND`;
}

const INTENT_LABEL: Record<string, string> = { sell: "Sell", buy: "Buy", other: "Other" };
export function formatIntent(intent: string | null | undefined): string {
  return INTENT_LABEL[intent ?? "other"] ?? "Other";
}

/** "3 min ago" style relative time, English, coarse buckets. */
export function formatRelativeTime(date: Date, now: Date): string {
  const diffSec = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000));
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}d ago`;
}

/** Cuts `text` to <= `maxChars`, breaking at a word boundary, suffixed "…" if cut. */
export function cutExcerpt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return `${cut}…`;
}

export interface AlertData {
  watchNames: string[];
  intent: string | null;
  priceVnd: number | null;
  title: string | null;
  excerpt: string;
  sourceName: string;
  authorName: string | null;
  postedAt: Date | null;
  reactions: number;
  comments: number;
  url: string;
  notificationId: string;
  excerptChars: number;
  now: Date;
}

export interface FormattedMessage {
  html: string;
  buttons: Button[][];
}

/** Alert template. Whole message kept <= 4096 chars. */
export function formatAlert(d: AlertData): FormattedMessage {
  const header = `<b>${escapeHtml(d.watchNames.join(" · "))}</b> · ${formatIntent(d.intent)} · ${formatPriceVnd(d.priceVnd)}`;
  const meta = `<i>${escapeHtml(d.sourceName)} · ${escapeHtml(d.authorName ?? "?")} · ${d.postedAt ? formatRelativeTime(d.postedAt, d.now) : "?"} · ${d.reactions} reactions · ${d.comments} comments</i>`;

  // Truncate the *plain* title/excerpt text (word boundary, `cutExcerpt`)
  // before escaping and tag-wrapping, and shrink those budgets — never the
  // assembled HTML string — so a cut can never land inside an `&amp;`-style
  // entity or a `<b>`/`<i>` tag (which Telegram's HTML parser rejects with a
  // non-retryable 400).
  let excerptMax = d.excerptChars;
  let titleMax = (d.title ?? "").length;

  const build = (): string => {
    const title = `<b>${escapeHtml(cutExcerpt(d.title ?? "", titleMax))}</b>`;
    const excerpt = escapeHtml(cutExcerpt(d.excerpt, excerptMax));
    return [header, title, excerpt, meta].join("\n");
  };

  let html = build();
  while (html.length > MAX_MESSAGE_CHARS && excerptMax > 0) {
    excerptMax = Math.floor(excerptMax / 2);
    html = build();
  }
  while (html.length > MAX_MESSAGE_CHARS && titleMax > 0) {
    titleMax = Math.floor(titleMax / 2);
    html = build();
  }

  const buttons: Button[][] = [
    [{ text: "Open post", url: d.url }],
    [
      { text: "Mute 1h", callback: `m1:${d.notificationId}` },
      { text: "Mute watch", callback: `mw:${d.notificationId}` },
    ],
  ];
  return { html, buttons };
}

export interface DigestEntry {
  /** notification row id this entry was built from — lets callers map a rendered
   * message back to the rows it actually delivered. */
  id: string;
  url: string;
  title: string | null;
  priceVnd: number | null;
  sourceName: string;
}

export interface DigestData {
  watchName: string;
  entries: DigestEntry[];
  maxEntries: number;
  notificationId: string; // first entry's notification id
}

export interface FormattedDigestMessage extends FormattedMessage {
  /** ids (`DigestEntry.id`) of every entry included in this message, in order. */
  entryIds: string[];
}

const renderDigestLines = (list: DigestEntry[]): string[] =>
  list.map(
    (e, i) => `${i + 1}. <a href="${escapeHtml(e.url)}">${escapeHtml(e.title ?? "")}</a> · ${formatPriceVnd(e.priceVnd)} · ${escapeHtml(e.sourceName)}`,
  );

/** Shrinks a single entry's title (word boundary, never mid-tag/entity) until `[header, ...render([entry])]` fits `budgetChars`. Used only for the pathological case where one entry alone overflows the limit — never drops the entry. */
function shrinkEntryToFit(header: string, entry: DigestEntry, budgetChars: number): DigestEntry {
  let titleMax = (entry.title ?? "").length;
  for (;;) {
    const candidate = { ...entry, title: cutExcerpt(entry.title ?? "", titleMax) };
    const html = [header, ...renderDigestLines([candidate])].join("\n");
    if (html.length <= budgetChars || titleMax === 0) return candidate;
    titleMax = Math.floor(titleMax / 2);
  }
}

/**
 * Packs `items` into as many messages as needed so `[header, ...lines]` never exceeds
 * `MAX_MESSAGE_CHARS` — every entry is included in exactly one output chunk (a
 * chunk that would overflow is split into additional messages, entries are never dropped).
 */
function splitByLength(header: string, items: DigestEntry[]): DigestEntry[][] {
  const chunks: DigestEntry[][] = [];
  let current: DigestEntry[] = [];
  for (const raw of items) {
    const aloneFits = [header, ...renderDigestLines([raw])].join("\n").length <= MAX_MESSAGE_CHARS;
    const item = aloneFits ? raw : shrinkEntryToFit(header, raw, MAX_MESSAGE_CHARS);
    const candidate = [...current, item];
    const html = [header, ...renderDigestLines(candidate)].join("\n");
    if (html.length > MAX_MESSAGE_CHARS && current.length > 0) {
      chunks.push(current);
      current = [item];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(current);
  if (chunks.length === 0) chunks.push([]);
  return chunks;
}

/** Digest template; overflow -> extra messages "(2/3)". Every entry in `d.entries` is guaranteed to appear in exactly one returned message. */
export function formatDigest(d: DigestData): FormattedDigestMessage[] {
  // defense-in-depth: callers validate `notify.digest.maxEntries` with Zod before
  // reaching here, but a non-positive/non-finite step would otherwise spin this loop forever.
  const step = Number.isFinite(d.maxEntries) && d.maxEntries > 0 ? Math.floor(d.maxEntries) : 20;
  const countChunks: DigestEntry[][] = [];
  for (let i = 0; i < d.entries.length; i += step) {
    countChunks.push(d.entries.slice(i, i + step));
  }
  if (countChunks.length === 0) countChunks.push([]);

  const buttons: Button[][] = [
    [
      { text: "Mute 1h", callback: `m1:${d.notificationId}` },
      { text: "Mute watch", callback: `mw:${d.notificationId}` },
    ],
  ];

  // Size-split each count chunk using a header padded with the widest plausible suffix
  // ("(999/999)") — the real header (shorter, once the final chunk count is known) is
  // guaranteed to fit at least as well, so re-adding the real suffix below can never push
  // an already-packed chunk back over the limit.
  const placeholderHeader = `<b>Digest · ${escapeHtml(d.watchName)} · ${d.entries.length} posts (999/999)</b>`;
  const sizeChunks: DigestEntry[][] = countChunks.flatMap((cc) => splitByLength(placeholderHeader, cc));
  if (sizeChunks.length === 0) sizeChunks.push([]);

  return sizeChunks.map((chunk, idx) => {
    const suffix = sizeChunks.length > 1 ? ` (${idx + 1}/${sizeChunks.length})` : "";
    const header = `<b>Digest · ${escapeHtml(d.watchName)} · ${d.entries.length} posts${suffix}</b>`;
    const html = [header, ...renderDigestLines(chunk)].join("\n");
    return { html, buttons, entryIds: chunk.map((e) => e.id) };
  });
}

export interface OpsData {
  kind: string;
  text: string;
  ts: Date;
}

/** Ops template. No keyboard. */
export function formatOps(d: OpsData): string {
  return `<b>[ops] ${escapeHtml(d.kind)}</b>\n${escapeHtml(d.text)}\n<i>${d.ts.toISOString()}</i>`;
}
