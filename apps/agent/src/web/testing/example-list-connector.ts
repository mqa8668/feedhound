import type { ServerRawPost } from "@feedhound/core/sources";
import { z } from "zod";
import { WebHttpError, WebParseError, type ListPage, type MapCtx, type SiteConnector, type WebHttp } from "../types";

// Test-only connector: a fictional offset-paginated JSON listing at https://feeds.example.test/api/items?topic=<slug>.
// It exercises the SiteConnector contract (parse url, list pages, map items) without any third-party site.

const HOST = "feeds.example.test";
const PATH = "/api/items";

const itemSchema = z.looseObject({
  id: z.number().int().positive(),
  title: z.string().default(""),
  body: z.string().default(""),
  price: z.number().optional(),
  author_id: z.string().optional(),
  author_name: z.string().optional(),
  posted_at: z.number().optional(),
  images: z.array(z.string()).optional(),
});
export type ExampleItem = z.infer<typeof itemSchema>;

const listSchema = z.looseObject({ items: z.array(z.unknown()) });

function parseSourceUrl(url: string): { ok: true; platformId: string; url: string } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: "invalid url" };
  }
  if (u.protocol !== "https:" || u.hostname !== HOST) return { ok: false, reason: `host must be ${HOST}` };
  if (u.pathname !== PATH) return { ok: false, reason: `path must be ${PATH}` };
  const topic = u.searchParams.get("topic");
  if (!topic || !/^[\w-]+$/.test(topic)) return { ok: false, reason: "topic required" };
  return { ok: true, platformId: `example-list:topic=${topic}`, url: `https://${HOST}${PATH}?topic=${topic}` };
}

async function list(http: WebHttp, sourceUrl: string, cursor: string | null, pageSize: number): Promise<ListPage<ExampleItem>> {
  const checked = parseSourceUrl(sourceUrl);
  if (!checked.ok || checked.url !== sourceUrl) throw new WebParseError("source url is not a valid example-list url");
  const offset = cursor === null ? 0 : Number.parseInt(cursor, 10);
  if (!Number.isInteger(offset) || offset < 0) throw new WebParseError(`bad cursor ${cursor}`);
  const res = await http.getJson(`${sourceUrl}&o=${offset}&limit=${pageSize}`);
  if (res.status < 200 || res.status >= 300) throw new WebHttpError(res.status, res.retryAfterSec);
  const body = listSchema.safeParse(res.body);
  if (!body.success) throw new WebParseError("unexpected list body");
  const items: ExampleItem[] = [];
  let malformed = 0;
  for (const raw of body.data.items) {
    const item = itemSchema.safeParse(raw);
    if (item.success) items.push(item.data);
    else malformed++;
  }
  const next = body.data.items.length === pageSize ? String(offset + pageSize) : null;
  return { items, next, malformed };
}

function map(item: ExampleItem, ctx: MapCtx): ServerRawPost | null {
  if (!Number.isFinite(item.posted_at ?? Number.NaN)) return null;
  const post: ServerRawPost = {
    platformPostId: String(item.id),
    url: `https://${HOST}/items/${item.id}`,
    text: `${item.title}\n${item.body}`,
    media: (item.images ?? []).map((url) => ({ type: "image", url })),
    postedAt: new Date(item.posted_at as number).toISOString(),
    capturedAt: ctx.capturedAt.toISOString(),
    capture: "api",
  };
  if (item.author_id !== undefined) post.authorId = `ex:${item.author_id}`;
  if (item.author_name) post.authorName = item.author_name;
  return post;
}

export const exampleList: SiteConnector<ExampleItem> = {
  id: "example-list",
  version: 1,
  hosts: [HOST],
  parseSourceUrl,
  list,
  map,
};
