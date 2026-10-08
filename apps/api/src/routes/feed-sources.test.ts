import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../index";
import { WebFetchError, type WebHttp } from "../../../agent/src/web/types";
import { fakeFeedHttp, RSS_BODY } from "./test-feed-http";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL && !new URL(TEST_DATABASE_URL).pathname.endsWith("_test")) {
  throw new Error("TEST_DATABASE_URL must point at a database whose name ends in '_test'");
}

const ATOM_BODY = `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Deals</title>
<entry><title>Monitor</title><link href="https://deals.example.test/item/77"/><id>77</id><updated>2026-10-05T04:45:00Z</updated></entry></feed>`;
const JSON_BODY = JSON.stringify({
  version: "https://jsonfeed.org/version/1.1",
  title: "JSON Deals",
  items: [{ id: "1", url: "https://deals.example.test/item/1", title: "Keyboard", date_published: "2026-10-05T04:45:00Z" }],
});
const HTML_BODY = "<!doctype html><html><head><title>Home</title></head><body><p>hello</p></body></html>";

describe.skipIf(!TEST_DATABASE_URL)("POST /api/sources by feed url", () => {
  let handle: DbHandle;
  let teamId: string;
  let email: string;
  const prev = { env: process.env.NODE_ENV, bypass: process.env.DEV_AUTH_BYPASS };
  const uniq = (): string => crypto.randomUUID().slice(0, 8);
  const call = (http: WebHttp | undefined, path: string, body: unknown) =>
    createApp(handle, undefined, http ? { webHttp: http } : {}).request(path, {
      method: "POST",
      headers: { "X-Dev-User": email, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const count = async (): Promise<number> => (await handle.db.select().from(schema.source).where(eq(schema.source.teamId, teamId))).length;

  beforeAll(async () => {
    process.env.NODE_ENV = "development";
    process.env.DEV_AUTH_BYPASS = "1";
    handle = createDb(TEST_DATABASE_URL!);
    const [team] = await handle.db.insert(schema.team).values({ name: `fs-${crypto.randomUUID()}` }).returning({ id: schema.team.id });
    teamId = team!.id;
    email = `fs-${crypto.randomUUID()}@example.com`;
    await handle.db.insert(schema.user).values({ teamId, email, role: "operator" });
  });

  afterAll(async () => {
    process.env.NODE_ENV = prev.env;
    process.env.DEV_AUTH_BYPASS = prev.bypass;
    await handle.db.delete(schema.source).where(eq(schema.source.teamId, teamId));
    await handle.db.delete(schema.user).where(eq(schema.user.teamId, teamId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("RSS: 201 with feed platformId, title as name, 5-item preview, due for polling", async () => {
    const url = `https://Deals.Example.test/${uniq()}/rss.xml#top`;
    const res = await call(fakeFeedHttp(RSS_BODY), "/api/sources", { url });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { kind: string; platformId: string; name: string; lastOkVisitAt: unknown; preview: { title: string; url: string; postedAt: string | null }[] };
    expect(body.kind).toBe("web");
    expect(body.platformId).toStartWith("feed:https://deals.example.test/");
    expect(body.name).toBe("Example Deals");
    expect(body.lastOkVisitAt).toBeNull();
    expect(body.preview).toHaveLength(5);
    expect(body.preview[0]).toMatchObject({ title: "Deal 1", url: "https://deals.example.test/item/1" });
  });

  test("Atom and JSON feeds are accepted; an explicit name wins", async () => {
    const atom = await call(fakeFeedHttp(ATOM_BODY), "/api/sources", { url: `https://deals.example.test/${uniq()}/atom.xml` });
    expect(atom.status).toBe(201);
    expect(((await atom.json()) as { name: string }).name).toBe("Atom Deals");
    const json = await call(fakeFeedHttp(JSON_BODY), "/api/sources", { url: `https://deals.example.test/${uniq()}/feed.json`, name: "My notes" });
    expect(json.status).toBe(201);
    expect(((await json.json()) as { name: string }).name).toBe("My notes");
  });

  test("an HTML page is 422 invalid_feed and nothing is inserted", async () => {
    const before = await count();
    const res = await call(fakeFeedHttp(HTML_BODY), "/api/sources", { url: `https://deals.example.test/${uniq()}/` });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "invalid_feed", message: expect.stringContaining("HTML") });
    expect(await count()).toBe(before);
  });

  test("an unreachable host is 422 with a readable message", async () => {
    const http: WebHttp = {
      async getJson() {
        throw new Error("unused");
      },
      async getText() {
        throw new WebFetchError("network", "connection refused");
      },
    };
    const res = await call(http, "/api/sources", { url: `https://down.example.test/${uniq()}.xml` });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string; message: string }).error).toBe("invalid_feed");
  });

  test("a non-2xx answer is 422", async () => {
    const res = await call(fakeFeedHttp("", 404), "/api/sources", { url: `https://deals.example.test/${uniq()}.xml` });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { message: string }).message).toContain("404");
  });

  test("a private/loopback host is blocked (default fetcher, no network needed)", async () => {
    const res = await call(undefined, "/api/sources", { url: "http://127.0.0.1:9/feed.xml" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_feed");
    const prev = await call(undefined, "/api/sources/preview", { url: "http://127.0.0.1:9/feed.xml" });
    expect(prev.status).toBe(422);
  });

  test("a non-http url or missing url is 400", async () => {
    expect((await call(fakeFeedHttp(RSS_BODY), "/api/sources", { url: "ftp://deals.example.test/x.xml" })).status).toBe(400);
    expect((await call(fakeFeedHttp(RSS_BODY), "/api/sources", {})).status).toBe(400);
  });

  test("the same feed twice is 409", async () => {
    const url = `https://deals.example.test/${uniq()}/dup.xml`;
    expect((await call(fakeFeedHttp(RSS_BODY), "/api/sources", { url })).status).toBe(201);
    expect((await call(fakeFeedHttp(RSS_BODY), "/api/sources", { url: `${url}#again` })).status).toBe(409);
  });

  test("preview returns items without inserting; failures give the same 422", async () => {
    const before = await count();
    const url = `https://deals.example.test/${uniq()}/preview.xml`;
    const ok = await call(fakeFeedHttp(RSS_BODY), "/api/sources/preview", { url });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { title: string; items: unknown[] };
    expect(body.title).toBe("Example Deals");
    expect(body.items).toHaveLength(5);
    const bad = await call(fakeFeedHttp(HTML_BODY), "/api/sources/preview", { url });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ error: "invalid_feed" });
    expect((await call(fakeFeedHttp(RSS_BODY), "/api/sources/preview", {})).status).toBe(400);
    expect(await count()).toBe(before);
  });
});
