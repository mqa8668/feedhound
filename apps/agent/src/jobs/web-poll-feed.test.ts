// A feed source as created by POST /api/sources (platformId feed:<url>, never visited) is polled by the next web_poll run.
import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { feedConnector } from "../web/connectors/feed";
import { connectorFor } from "../web/registry";
import type { WebHttp } from "../web/types";
import { runWebPoll } from "./web-poll";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL && !new URL(TEST_DATABASE_URL).pathname.replace(/^\//, "").endsWith("_test")) {
  throw new Error("TEST_DATABASE_URL must point at a database whose name ends in '_test'");
}

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>
<item><title>Alpha</title><link>https://deals.example.test/a</link><guid>a</guid></item>
<item><title>Beta</title><link>https://deals.example.test/b</link><guid>b</guid></item></channel></rss>`;

test("the feed connector is resolved from a feed: platformId", () => {
  const parsed = feedConnector.parseSourceUrl("https://deals.example.test/rss.xml");
  expect(parsed.ok && connectorFor(parsed.platformId)).toBe(feedConnector as never);
});

describe.skipIf(!TEST_DATABASE_URL)("web_poll picks up a new feed source", () => {
  let handle: DbHandle;
  let teamId: string;
  let sourceId: string;

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL!);
    await handle.sql`update source set status = 'paused' where kind = 'web' and status = 'active'`;
    const [team] = await handle.db.insert(schema.team).values({ name: `feedpoll-${crypto.randomUUID()}` }).returning({ id: schema.team.id });
    teamId = team!.id;
    const url = `https://deals.example.test/${crypto.randomUUID().slice(0, 8)}/rss.xml`;
    const parsed = feedConnector.parseSourceUrl(url);
    if (!parsed.ok) throw new Error("bad url");
    const [s] = await handle.db.insert(schema.source).values({ teamId, kind: "web", platformId: parsed.platformId, name: "Feed", url: parsed.url }).returning({ id: schema.source.id });
    sourceId = s!.id;
  });

  afterAll(async () => {
    await handle.db.delete(schema.post).where(eq(schema.post.sourceId, sourceId));
    await handle.db.delete(schema.visit).where(eq(schema.visit.sourceId, sourceId));
    await handle.db.delete(schema.source).where(eq(schema.source.id, sourceId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("a never-visited feed source is polled immediately and its items are ingested", async () => {
    const requested: string[] = [];
    const http: WebHttp = {
      async getJson() {
        throw new Error("unused");
      },
      async getText(url) {
        requested.push(url);
        return { status: 200, retryAfterSec: null, body: RSS, etag: null, lastModified: null, notModified: false };
      },
    };
    const boss = { createQueue: async () => undefined, send: async () => "job" } as unknown as PgBoss;
    const res = await runWebPoll({ handle, boss, http, configOverride: { enabled: true } });
    expect(res.sources).toBe(1);
    expect(requested).toHaveLength(1);
    expect((await handle.db.select().from(schema.post).where(eq(schema.post.sourceId, sourceId))).length).toBe(2);
    const [row] = await handle.db.select().from(schema.source).where(eq(schema.source.id, sourceId));
    expect(row?.lastOkVisitAt).not.toBeNull();
  });
});
