// web_poll scheduling, ingest, visits and backoff (fake WebHttp, fake clock, test DB).

import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { desc, eq, inArray } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { CONNECTORS } from "../web/registry";
import { exampleList } from "../web/testing/example-list-connector";
import { WebFetchError, type SiteConnector, type WebHttp, type WebResponse, type WebTextResponse } from "../web/types";
import { runWebPoll, type WebConfig } from "./web-poll";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL && !new URL(TEST_DATABASE_URL).pathname.replace(/^\//, "").endsWith("_test")) {
  throw new Error("TEST_DATABASE_URL must point at a database whose name ends in '_test'");
}

const FIXTURE: unknown = await Bun.file(new URL("../../../../tests/fixtures/web/list.json", import.meta.url)).json();
const LIST_URL = "https://feeds.example.test/api/items?topic=gpu";
const T0 = new Date("2026-10-06T10:00:00.000Z");

function fakeBoss(): PgBoss {
  return { createQueue: async () => undefined, send: async () => "job" } as unknown as PgBoss;
}

class FakeHttp implements WebHttp {
  requests: string[] = [];
  constructor(private respond: () => WebResponse | Promise<WebResponse>) {}
  set(respond: () => WebResponse | Promise<WebResponse>): void {
    this.respond = respond;
  }
  async getJson(url: string): Promise<WebResponse> {
    this.requests.push(url);
    return this.respond();
  }
  async getText(): Promise<WebTextResponse> {
    throw new Error("getText is not used by this connector");
  }
}
const ok = (): WebResponse => ({ status: 200, retryAfterSec: null, body: FIXTURE });

describe.skipIf(!TEST_DATABASE_URL)("runWebPoll ", () => {
  let handle: DbHandle;
  let teamId: string;
  let version = 2_000_000;
  const sourceIds: string[] = [];
  let clock = T0;
  let override: Partial<WebConfig> = {};
  const now = (): Date => clock;

  /** Config rows carry `enabled`; the other values go through `configOverride` (pageSize 3 is below the Config minimum). */
  async function setConfig(over: Record<string, unknown>): Promise<void> {
    const merged: Record<string, unknown> = { enabled: true, pollIntervalSec: 600, maxSourcesPerRun: 5, maxPagesPerRun: 3, pageSize: 3, backoffBaseSec: 300, backoffMaxSec: 21600 };
    for (const [k, v] of Object.entries(over)) merged[k.replace(/^web\./, "")] = v;
    override = merged as Partial<WebConfig>;
    await handle.db.insert(schema.config).values({ key: "web.enabled", version: ++version, value: merged.enabled, updatedBy: "testpoll" });
  }

  async function newSource(): Promise<string> {
    const [s] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `example-list:topic=t${crypto.randomUUID()}`, name: "tpoll", url: LIST_URL })
      .returning({ id: schema.source.id });
    sourceIds.push(s!.id);
    return s!.id;
  }

  async function retire(id: string): Promise<void> {
    await handle.db.update(schema.source).set({ status: "paused" }).where(eq(schema.source.id, id));
  }

  const lastVisit = async (id: string) =>
    (await handle.db.select().from(schema.visit).where(eq(schema.visit.sourceId, id)).orderBy(desc(schema.visit.startedAt), desc(schema.visit.createdAt)).limit(1))[0]!;
  const sourceRow = async (id: string) => (await handle.db.select().from(schema.source).where(eq(schema.source.id, id)))[0]!;

  beforeAll(async () => {
    (CONNECTORS as Map<string, SiteConnector>).set(exampleList.id, exampleList as SiteConnector);
    handle = createDb(TEST_DATABASE_URL);
    await handle.sql`update source set status = 'paused' where kind = 'web' and status = 'active'`;
    const [team] = await handle.db.insert(schema.team).values({ name: "web-poll-team" }).returning({ id: schema.team.id });
    teamId = team!.id;
  });

  afterAll(async () => {
    (CONNECTORS as Map<string, SiteConnector>).delete(exampleList.id);
    await handle.db.delete(schema.config).where(eq(schema.config.updatedBy, "testpoll"));
    await handle.db.delete(schema.post).where(inArray(schema.post.sourceId, sourceIds));
    await handle.db.delete(schema.visit).where(inArray(schema.visit.sourceId, sourceIds));
    await handle.db.delete(schema.source).where(inArray(schema.source.id, sourceIds));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("disabled makes no request", async () => {
    await setConfig({ "web.enabled": false });
    const id = await newSource();
    const http = new FakeHttp(ok);
    await runWebPoll({ handle, boss: fakeBoss(), http, now, configOverride: override });
    expect(http.requests.length).toBe(0);
    await retire(id);
  });

  test("two pages, visit counters, not due again until the interval passes", async () => {
    await setConfig({});
    const id = await newSource();
    const http = new FakeHttp(ok);
    clock = T0;
    await runWebPoll({ handle, boss: fakeBoss(), http, now, configOverride: override });
    expect(http.requests.length).toBe(2);
    expect(http.requests[0]).toBe(`${LIST_URL}&o=0&limit=3`);
    expect(http.requests[1]).toBe(`${LIST_URL}&o=3&limit=3`);
    expect((await handle.db.select().from(schema.post).where(eq(schema.post.sourceId, id))).length).toBe(3);
    const v = await lastVisit(id);
    expect(v).toMatchObject({ outcome: "ok", postsSeen: 6, postsNew: 3, pages: 2, reachedKnownTail: true, mode: "normal" });
    const s = await sourceRow(id);
    expect(s.lastOkVisitAt?.getTime()).toBe(T0.getTime());
    expect(s.lastIngestAt).not.toBeNull();
    expect(s.health).toEqual({ ok: true });

    await runWebPoll({ handle, boss: fakeBoss(), http, now, configOverride: override });
    expect(http.requests.length).toBe(2);

    clock = new Date(T0.getTime() + 600_000);
    await runWebPoll({ handle, boss: fakeBoss(), http, now, configOverride: override });
    expect(http.requests.length).toBe(3);
    await retire(id);
  });

  test("maxPagesPerRun 1 on an empty source makes exactly one request", async () => {
    await setConfig({ "web.maxPagesPerRun": 1 });
    const id = await newSource();
    const http = new FakeHttp(ok);
    clock = new Date("2026-10-07T10:00:00.000Z");
    await runWebPoll({ handle, boss: fakeBoss(), http, now, configOverride: override });
    expect(http.requests.length).toBe(1);
    await retire(id);
  });

  test("429 with Retry-After sets backoff and blocks the next run", async () => {
    await setConfig({ "web.maxPagesPerRun": 3 });
    const id = await newSource();
    const http = new FakeHttp(() => ({ status: 429, retryAfterSec: 900, body: {} }));
    clock = new Date("2026-10-08T10:00:00.000Z");
    await runWebPoll({ handle, boss: fakeBoss(), http, now, configOverride: override });
    expect(http.requests.length).toBe(1);
    expect(await lastVisit(id)).toMatchObject({ outcome: "error", reason: "http_429" });
    const health = (await sourceRow(id)).health as { backoffUntil: string; ok: boolean };
    expect(health.ok).toBe(false);
    expect(new Date(health.backoffUntil).getTime()).toBe(clock.getTime() + 900_000);

    clock = new Date(clock.getTime() + 60_000);
    await runWebPoll({ handle, boss: fakeBoss(), http, now, configOverride: override });
    expect(http.requests.length).toBe(1);

    // recovery: the next ok run resets health
    clock = new Date(clock.getTime() + 900_000);
    http.set(ok);
    await runWebPoll({ handle, boss: fakeBoss(), http, now, configOverride: override });
    expect((await sourceRow(id)).health).toEqual({ ok: true });
    await retire(id);
  });

  test("consecutive 503s double the backoff, capped by backoffMaxSec", async () => {
    await setConfig({});
    const id = await newSource();
    const http = new FakeHttp(() => ({ status: 503, retryAfterSec: null, body: {} }));
    let t = new Date("2026-10-09T10:00:00.000Z");
    const expected = [300, 600, 1200];
    for (const sec of expected) {
      clock = t;
      await runWebPoll({ handle, boss: fakeBoss(), http, now, configOverride: override });
      const h = (await sourceRow(id)).health as { backoffUntil: string };
      expect(new Date(h.backoffUntil).getTime()).toBe(clock.getTime() + sec * 1000);
      t = new Date(clock.getTime() + sec * 1000 + 1000);
    }
    await setConfig({ "web.backoffMaxSec": 600 });
    clock = t;
    await runWebPoll({ handle, boss: fakeBoss(), http, now, configOverride: override });
    const h = (await sourceRow(id)).health as { backoffUntil: string };
    expect(new Date(h.backoffUntil).getTime()).toBe(clock.getTime() + 600_000);
    await retire(id);
  });

  test("403 is blocked http_403; robots refusal is blocked robots", async () => {
    await setConfig({});
    const a = await newSource();
    clock = new Date("2026-10-10T10:00:00.000Z");
    await runWebPoll({ handle, boss: fakeBoss(), http: new FakeHttp(() => ({ status: 403, retryAfterSec: null, body: {} })), now });
    expect(await lastVisit(a)).toMatchObject({ outcome: "blocked", reason: "http_403" });
    await retire(a);

    const b = await newSource();
    const http = new FakeHttp(ok);
    const robotsHttp: WebHttp = {
      async getJson(): Promise<WebResponse> {
        throw new WebFetchError("robots", "disallowed");
      },
      async getText(): Promise<WebTextResponse> {
        throw new WebFetchError("robots", "disallowed");
      },
    };
    await runWebPoll({ handle, boss: fakeBoss(), http: robotsHttp, now });
    expect(await lastVisit(b)).toMatchObject({ outcome: "blocked", reason: "robots" });
    expect(http.requests.length).toBe(0);
    await retire(b);
  });

  test("a 3xx from the list endpoint is an http_3xx error", async () => {
    await setConfig({});
    const id = await newSource();
    const http = new FakeHttp(() => ({ status: 302, retryAfterSec: null, body: "" }));
    clock = new Date("2026-10-12T10:00:00.000Z");
    await runWebPoll({ handle, boss: fakeBoss(), http, now, configOverride: override });
    expect(await lastVisit(id)).toMatchObject({ outcome: "error", reason: "http_302" });
    await retire(id);
  });

  test("a stored url the connector no longer accepts is not fetched and is marked unhealthy", async () => {
    await setConfig({});
    const [s] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `example-list:topic=t${crypto.randomUUID()}`, name: "tpoll", url: "https://feeds.example.test/api/other" })
      .returning({ id: schema.source.id });
    sourceIds.push(s!.id);
    const http = new FakeHttp(ok);
    clock = new Date("2026-10-13T10:00:00.000Z");
    await runWebPoll({ handle, boss: fakeBoss(), http, now, configOverride: override });
    expect(http.requests.length).toBe(0);
    expect(await lastVisit(s!.id)).toMatchObject({ outcome: "error", reason: "invalid_url" });
    expect((await sourceRow(s!.id)).health).toMatchObject({ ok: false, reason: "invalid_url" });
    await retire(s!.id);
  });

  test("time budget: a run stops starting sources and pages once the budget is spent", async () => {
    await setConfig({ "web.maxPagesPerRun": 5, "web.minRequestGapMs": 1000 });
    const a = await newSource();
    const b = await newSource();
    let calls = 0;
    const http = new FakeHttp(() => {
      calls++;
      clock = new Date(clock.getTime() + 300_000); // each request "takes" 5 min of the fake clock
      return ok();
    });
    clock = new Date("2026-10-14T10:00:00.000Z");
    await runWebPoll({ handle, boss: fakeBoss(), http, now, configOverride: { ...override, minRequestGapMs: 1000 } });
    // budget 480 s: two requests fit (page 2 ends the run on a known tail); the second source finds the budget spent and never starts
    expect(calls).toBe(2);
    const visits = await handle.db.select().from(schema.visit).where(inArray(schema.visit.sourceId, [a, b]));
    expect(visits.length).toBe(1);
    await retire(a);
    await retire(b);
  });

  test("unknown connector writes an error visit with no request", async () => {
    await setConfig({});
    const [s] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: "nosuch:x", name: "tpoll", url: LIST_URL })
      .returning({ id: schema.source.id });
    sourceIds.push(s!.id);
    const http = new FakeHttp(ok);
    clock = new Date("2026-10-11T10:00:00.000Z");
    await runWebPoll({ handle, boss: fakeBoss(), http, now, configOverride: override });
    expect(http.requests.length).toBe(0);
    expect(await lastVisit(s!.id)).toMatchObject({ outcome: "error", reason: "unknown_connector" });
    await retire(s!.id);
  });
});
