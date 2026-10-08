import { createHash } from "node:crypto";
import type { ServerRawPost } from "@feedhound/core/sources";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { createWebFetcher } from "../fetcher";
import {
  WebFetchError,
  WebHttpError,
  WebParseError,
  type HttpValidators,
  type ListOptions,
  type ListPage,
  type MapCtx,
  type SiteConnector,
  type WebHttp,
} from "../types";

// Generic RSS 2.0 / RSS 1.0 / Atom 1.0 / JSON Feed 1.1 connector. One source = one feed url (a single request per poll).

export const MAX_FEED_ITEMS = 200;
const MAX_URL_LEN = 2048;
const MAX_ID_LEN = 300;
const MAX_TEXT_LEN = 20_000;
const MAX_MEDIA = 50;
const DEFAULT_USER_AGENT = "feedhound/0.1 (+https://github.com/mqa8668/feedhound)";

/** A feed entry normalised across formats; `link` may still be relative. */
export interface FeedItem {
  id: string | null;
  title: string;
  link: string | null;
  summaryHtml: string;
  publishedRaw: string | null;
  author: string | null;
  media: { type: string; url: string }[];
}

export interface ParsedFeed {
  title: string;
  items: FeedItem[];
  malformed: number;
}

// ---------- url ----------

function normalizeFeedUrl(url: string): { ok: true; url: string } | { ok: false; reason: string } {
  if (url.length > MAX_URL_LEN) return { ok: false, reason: `url longer than ${MAX_URL_LEN} characters` };
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return { ok: false, reason: "invalid url" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, reason: "url must start with http:// or https://" };
  if (u.username !== "" || u.password !== "") return { ok: false, reason: "url must not contain credentials" };
  if (u.hostname === "") return { ok: false, reason: "url has no host" };
  u.hash = "";
  const href = u.href;
  if (href.length > MAX_URL_LEN) return { ok: false, reason: `url longer than ${MAX_URL_LEN} characters` };
  return { ok: true, url: href };
}

function parseSourceUrl(url: string): { ok: true; platformId: string; url: string } | { ok: false; reason: string } {
  const n = normalizeFeedUrl(url);
  return n.ok ? { ok: true, platformId: `feed:${n.url}`, url: n.url } : n;
}

// ---------- text helpers ----------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", hellip: "...",
  lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', copy: "(c)", reg: "(r)", laquo: "<<", raquo: ">>",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isInteger(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return " ";
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

/** HTML fragment -> plain text: drops script/style, turns block tags into line breaks, decodes entities. */
export function stripHtml(html: string): string {
  const withBreaks = html
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|li|h[1-6]|tr|blockquote|ul|ol)\s*>/gi, "\n");
  const text = decodeEntities(withBreaks.replace(/<[^>]*>/g, " "));
  return text
    .split("\n")
    .map((l) => l.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter((l, i, all) => l !== "" || (i > 0 && all[i - 1] !== ""))
    .join("\n")
    .trim();
}

/** Titles may carry markup (Atom type="html", double-encoded RSS): strip only when markup is present. */
function cleanTitle(title: string): string {
  const t = /<[a-z/!]|&[#a-z0-9]+;/i.test(title) ? stripHtml(title) : title;
  return t.replace(/\s+/g, " ").trim();
}

function isHttpUrl(u: string): boolean {
  return /^https?:\/\//i.test(u) && u.length <= MAX_URL_LEN;
}

function resolveUrl(raw: string | null | undefined, base: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim(), base);
    return (u.protocol === "http:" || u.protocol === "https:") && u.href.length <= MAX_URL_LEN ? u.href : null;
  } catch {
    return null;
  }
}

function parseDate(raw: string | null): string | undefined {
  if (!raw) return undefined;
  const d = new Date(raw.trim());
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

// ---------- XML ----------

type Node = Record<string, unknown>;

const asArray = (v: unknown): unknown[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const isNode = (v: unknown): v is Node => typeof v === "object" && v !== null && !Array.isArray(v);

/** Text of a node: plain string/number, or the `#text` of an element with attributes. */
function txt(v: unknown): string | null {
  if (typeof v === "string") return v.trim() === "" ? null : v.trim();
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return txt(v[0]);
  if (isNode(v)) return txt(v["#text"]);
  return null;
}

function attr(v: unknown, name: string): string | null {
  return isNode(v) && typeof v[`@_${name}`] === "string" ? (v[`@_${name}`] as string) : null;
}

function mediaType(mime: string | null, medium: string | null, fallback: string): string {
  const m = (medium ?? mime ?? "").toLowerCase();
  if (m.startsWith("image")) return "image";
  if (m.startsWith("video")) return "video";
  if (m.startsWith("audio")) return "audio";
  return fallback;
}

function cleanAuthor(raw: string | null): string | null {
  if (!raw) return null;
  const paren = /\(([^)]+)\)/.exec(raw);
  if (paren && raw.includes("@")) return paren[1]!.trim() || null;
  const a = raw.replace(/<[^>]*>/g, "").trim();
  return a.includes("@") && !a.includes(" ") ? null : a || null;
}

function collectXmlMedia(item: Node): { type: string; url: string }[] {
  const out: { type: string; url: string }[] = [];
  for (const e of asArray(item["enclosure"])) {
    const url = attr(e, "url");
    if (url) out.push({ type: mediaType(attr(e, "type"), null, "file"), url });
  }
  for (const key of ["media:thumbnail", "media:content"]) {
    for (const e of asArray(item[key])) {
      const url = attr(e, "url");
      if (url) out.push({ type: key === "media:thumbnail" ? "image" : mediaType(attr(e, "type"), attr(e, "medium"), "file"), url });
    }
  }
  return out;
}

function xmlItem(item: Node, atom: boolean): FeedItem | null {
  const title = txt(item["title"]) ?? "";
  let link: string | null;
  let id: string | null;
  let summary: string | null;
  let published: string | null;
  let author: string | null;
  if (atom) {
    const links = asArray(item["link"]);
    const alt = links.find((l) => (attr(l, "rel") ?? "alternate") === "alternate") ?? links[0];
    link = attr(alt, "href") ?? txt(alt);
    id = txt(item["id"]);
    summary = txt(item["summary"]) ?? txt(item["content"]);
    published = txt(item["updated"]) ?? txt(item["published"]);
    const a = asArray(item["author"])[0];
    author = txt(isNode(a) ? a["name"] : a);
    const src = asArray(item["source"])[0];
    if (!author && isNode(src)) author = txt(asArray(src["author"])[0] && (asArray(src["author"])[0] as Node)["name"]);
  } else {
    link = txt(item["link"]);
    id = txt(item["guid"]) ?? txt(item["dc:identifier"]);
    summary = txt(item["description"]) ?? txt(item["content:encoded"]);
    published = txt(item["pubDate"]) ?? txt(item["dc:date"]) ?? txt(item["published"]) ?? txt(item["updated"]);
    author = cleanAuthor(txt(item["dc:creator"]) ?? txt(item["author"]));
  }
  if (!title && !link && !id && !summary) return null;
  return { id, title, link, summaryHtml: summary ?? "", publishedRaw: published, author, media: collectXmlMedia(item) };
}

function parseXmlFeed(body: string): ParsedFeed {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    textNodeName: "#text",
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    processEntities: true,
    htmlEntities: true,
    ignoreDeclaration: true,
    ignorePiTags: true,
  });
  if (/^(<!doctype\s+html|<html[\s>])/i.test(body) || /<html[\s>]/i.test(body.slice(0, 2000))) {
    throw new WebParseError(`this url returned an HTML page, not a feed${htmlTitleHint(body)}; use the feed address (RSS, Atom or JSON Feed)`);
  }
  const valid = XMLValidator.validate(body);
  if (valid !== true) throw new WebParseError(`feed is not well-formed XML: ${valid.err.msg}`);
  let doc: Node;
  try {
    doc = parser.parse(body) as Node;
  } catch (err) {
    throw new WebParseError(`feed is not well-formed XML: ${err instanceof Error ? err.message : "parse error"}`);
  }
  let title: string;
  let rawItems: unknown[];
  let atom = false;
  const rss = doc["rss"];
  const rdf = doc["rdf:RDF"];
  const feed = doc["feed"];
  if (isNode(rss)) {
    const channel = isNode(rss["channel"]) ? rss["channel"] : {};
    title = txt(channel["title"]) ?? "";
    rawItems = asArray(channel["item"]);
  } else if (isNode(rdf)) {
    title = txt(isNode(rdf["channel"]) ? rdf["channel"]["title"] : null) ?? "";
    rawItems = asArray(rdf["item"]);
  } else if (isNode(feed)) {
    atom = true;
    title = txt(feed["title"]) ?? "";
    rawItems = asArray(feed["entry"]);
  } else if ("html" in doc || "HTML" in doc) {
    throw new WebParseError(`this url returned an HTML page, not a feed${htmlTitleHint(body)}; use the feed address (RSS, Atom or JSON Feed)`);
  } else {
    throw new WebParseError(`unrecognised XML document (root <${Object.keys(doc)[0] ?? "empty"}>), expected rss, feed or rdf:RDF`);
  }
  const items: FeedItem[] = [];
  let malformed = 0;
  for (const raw of rawItems.slice(0, MAX_FEED_ITEMS)) {
    const item = isNode(raw) ? xmlItem(raw, atom) : null;
    if (item) items.push(item);
    else malformed++;
  }
  return { title, items, malformed };
}

function htmlTitleHint(body: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body);
  const t = m?.[1] ? stripHtml(m[1]).slice(0, 80) : "";
  return t ? ` ("${t}")` : "";
}

// ---------- JSON Feed ----------

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function jsonItem(raw: unknown): FeedItem | null {
  if (!isNode(raw)) return null;
  const idRaw = raw["id"];
  const id = typeof idRaw === "number" ? String(idRaw) : str(idRaw);
  const title = str(raw["title"]) ?? "";
  const link = str(raw["url"]) ?? str(raw["external_url"]);
  const summary = str(raw["summary"]) ?? str(raw["content_text"]) ?? str(raw["content_html"]);
  if (!title && !link && !id && !summary) return null;
  const media: { type: string; url: string }[] = [];
  for (const key of ["image", "banner_image"]) {
    const u = str(raw[key]);
    if (u) media.push({ type: "image", url: u });
  }
  for (const a of asArray(raw["attachments"])) {
    if (!isNode(a)) continue;
    const u = str(a["url"]);
    if (u) media.push({ type: mediaType(str(a["mime_type"]), null, "file"), url: u });
  }
  const authors = [...asArray(raw["authors"]), raw["author"]].filter(isNode);
  return {
    id,
    title,
    link,
    summaryHtml: summary ?? "",
    publishedRaw: str(raw["date_published"]) ?? str(raw["date_modified"]),
    author: authors.length > 0 ? str(authors[0]!["name"]) : null,
    media,
  };
}

function parseJsonFeed(body: string): ParsedFeed {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    throw new WebParseError("feed is not valid JSON");
  }
  if (!isNode(doc) || !Array.isArray(doc["items"])) throw new WebParseError("JSON document is not a JSON Feed (missing items array)");
  const items: FeedItem[] = [];
  let malformed = 0;
  for (const raw of (doc["items"] as unknown[]).slice(0, MAX_FEED_ITEMS)) {
    const item = jsonItem(raw);
    if (item) items.push(item);
    else malformed++;
  }
  return { title: str(doc["title"]) ?? "", items, malformed };
}

/** Pure parser (no network): sniffs JSON Feed vs XML by content, not by content type. */
export function parseFeed(body: string): ParsedFeed {
  const text = body.replace(/^\uFEFF/, "").trim();
  if (text === "") throw new WebParseError("the feed response is empty");
  if (text.startsWith("{")) return parseJsonFeed(text);
  if (text.startsWith("<")) return parseXmlFeed(text);
  throw new WebParseError("response is neither XML nor JSON, so it is not a feed");
}

// ---------- connector ----------

async function list(http: WebHttp, sourceUrl: string, _cursor: string | null, _pageSize: number, opts?: ListOptions): Promise<ListPage<FeedItem>> {
  const checked = parseSourceUrl(sourceUrl);
  if (!checked.ok || checked.url !== sourceUrl) throw new WebParseError("source url is not a valid feed url");
  const prev = opts?.validators ?? null;
  const res = await http.getText(sourceUrl, { etag: prev?.etag ?? null, lastModified: prev?.lastModified ?? null });
  if (res.notModified || res.status === 304) return { items: [], next: null, malformed: 0, notModified: true, validators: prev };
  if (res.status < 200 || res.status >= 300) throw new WebHttpError(res.status, res.retryAfterSec);
  const parsed = parseFeed(res.body);
  const validators: HttpValidators | null = res.etag || res.lastModified ? { etag: res.etag, lastModified: res.lastModified } : null;
  return { items: parsed.items, next: null, malformed: parsed.malformed, validators };
}

function platformPostId(item: FeedItem): string {
  const base = item.id ?? item.link;
  if (base && base.length <= MAX_ID_LEN) return base;
  return createHash("sha1").update(base ?? `${item.title}\n${item.link ?? ""}`).digest("hex");
}

function map(item: FeedItem, ctx: MapCtx): ServerRawPost | null {
  const url = resolveUrl(item.link, ctx.sourceUrl) ?? (ctx.sourceUrl && isHttpUrl(ctx.sourceUrl) ? ctx.sourceUrl : null);
  if (!url) return null;
  const body = stripHtml(item.summaryHtml);
  const text = [cleanTitle(item.title), body].filter((p) => p !== "").join("\n").slice(0, MAX_TEXT_LEN);
  const media: { type: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const m of item.media) {
    const u = resolveUrl(m.url, ctx.sourceUrl);
    if (u && !seen.has(u) && media.length < MAX_MEDIA) {
      seen.add(u);
      media.push({ type: m.type, url: u });
    }
  }
  const post: ServerRawPost = {
    platformPostId: platformPostId(item),
    url,
    text,
    media,
    capturedAt: ctx.capturedAt.toISOString(),
    capture: "api",
  };
  const postedAt = parseDate(item.publishedRaw);
  if (postedAt) post.postedAt = postedAt;
  if (item.author) post.authorName = item.author.slice(0, 300);
  return post;
}

export const feedConnector: SiteConnector<FeedItem> = {
  id: "feed",
  version: 1,
  hosts: [],
  parseSourceUrl,
  list,
  map,
};

// ---------- preview (add-source route) ----------

export type FeedPreview =
  | { ok: true; title: string; items: { title: string; url: string; postedAt: string | null }[] }
  | { ok: false; reason: string };

/**
 * Parse + fetch + preview a feed url without storing anything. `http` defaults to a fresh polite fetcher
 * that may only reach the url's own host (robots.txt, SSRF guard and size/time limits apply).
 */
export async function previewFeed(url: string, http?: WebHttp, opts?: { allowPrivateHosts?: boolean }): Promise<FeedPreview> {
  const parsed = parseSourceUrl(url);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const client =
    http ??
    createWebFetcher({
      hosts: [new URL(parsed.url).hostname],
      userAgent: DEFAULT_USER_AGENT,
      minRequestGapMs: 1000,
      allowPrivateHosts: opts?.allowPrivateHosts ?? false,
    });
  try {
    const res = await client.getText(parsed.url);
    if (res.status < 200 || res.status >= 300) return { ok: false, reason: `the server answered HTTP ${res.status}` };
    const feed = parseFeed(res.body);
    const ctx: MapCtx = { capturedAt: new Date(), sourceUrl: parsed.url };
    const items = feed.items.flatMap((it) => {
      const post = map(it, ctx);
      return post ? [{ title: cleanTitle(it.title) || post.text.split("\n")[0] || post.url, url: post.url, postedAt: post.postedAt ?? null }] : [];
    });
    return { ok: true, title: feed.title, items: items.slice(0, 10) };
  } catch (err) {
    if (err instanceof WebParseError) return { ok: false, reason: err.message };
    if (err instanceof WebFetchError) return { ok: false, reason: err.kind === "robots" ? "robots.txt does not allow fetching this feed" : `${err.kind}: ${err.message}` };
    if (err instanceof WebHttpError) return { ok: false, reason: `the server answered HTTP ${err.status}` };
    return { ok: false, reason: err instanceof Error ? err.message : "unexpected error" };
  }
}
