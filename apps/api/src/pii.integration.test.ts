import { authorKey } from "@feedhound/core/normalize";
import { authorLabel, authorRef, PHONE_MASK } from "@feedhound/core/pii";
import { createDb, loadPiiSalt, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { createApp } from "./index";

// Every dashboard-facing JSON body and the CSV are masked.
// Real createApp over the isolated test DB.

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL && process.env.CI) throw new Error("pii.integration.test.ts: TEST_DATABASE_URL is required (CI is set)");
if (TEST_DATABASE_URL && !new URL(TEST_DATABASE_URL).pathname.replace(/^\//, "").endsWith("_test")) {
  throw new Error("TEST_DATABASE_URL must point at a database whose name ends in '_test'");
}
const canRun = Boolean(TEST_DATABASE_URL);

const NAME = "Nguyễn Văn A";
const AUTHOR_ID = "100012345";
const LEAKS = ["0912 345 678", "0912345678", "912 345", "345 678", NAME, AUTHOR_ID];

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe.skipIf(!canRun)("PII masking over the real API", () => {
  const RUN = crypto.randomUUID().slice(0, 8);
  let handle: DbHandle;
  let teamId: string;
  let userId: string;
  let sourceId: string;
  let postId: string;
  let otherPostId: string;
  let watchId: string;
  let key: string;
  const email = `pii-op-${RUN}@example.com`;
  let ref: string;

  const session = async (path: string, init: RequestInit = {}): Promise<Response> =>
    createApp(handle).request(path, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), "X-Dev-User": email } });
  const keyed = async (path: string, init: RequestInit = {}): Promise<Response> =>
    createApp(handle).request(path, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${key}` } });

  function expectClean(body: string): void {
    for (const leak of LEAKS) expect(body).not.toContain(leak);
  }

  beforeAll(async () => {
    process.env.NODE_ENV = "development";
    process.env.DEV_AUTH_BYPASS = "1";
    handle = createDb(TEST_DATABASE_URL!);
    const [team] = await handle.db.insert(schema.team).values({ name: `pii-${RUN}` }).returning({ id: schema.team.id });
    teamId = team!.id;
    const [user] = await handle.db.insert(schema.user).values({ teamId, email, role: "operator" }).returning({ id: schema.user.id });
    userId = user!.id;
    key = `sk_test_${crypto.randomUUID().replaceAll("-", "")}`;
    await handle.db.insert(schema.apiKey).values({ userId, name: "pii", prefix: key.slice(0, 8), hash: await sha256Hex(key), scopes: ["watches:read", "notifications:read"] });
    const [src] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `pii-${RUN}`, name: `pii-src-${RUN}`, url: `https://feeds.example.test/pii-${RUN}` })
      .returning({ id: schema.source.id });
    sourceId = src!.id;
    const [p] = await handle.db
      .insert(schema.post)
      .values({
        sourceId,
        platformPostId: `pa-${RUN}`,
        url: `https://feeds.example.test/g/posts/pa-${RUN}`,
        title: "Bán xe Vios lh 0912 345 678",
        text: "Bán xe Vios 2019 lh 0912 345 678, zalo 0912345678",
        textNormalized: "ban xe vios 2019 lh 0912 345 678, zalo 0912345678",
        authorName: NAME,
        authorId: AUTHOR_ID,
        raw: { authorName: NAME, secret: "raw-marker" },
      })
      .returning({ id: schema.post.id });
    postId = p!.id;
    const [o] = await handle.db
      .insert(schema.post)
      .values({ sourceId, platformPostId: `pb-${RUN}`, url: `https://feeds.example.test/g/posts/pb-${RUN}`, text: "Bán xe Mazda gọi 0987654321", textNormalized: "ban xe mazda goi 0987654321", authorName: "Trần B" })
      .returning({ id: schema.post.id });
    otherPostId = o!.id;

    const [w] = await handle.db.insert(schema.watch).values({ userId, name: `W-${RUN}`, include: ["xe"] }).returning({ id: schema.watch.id });
    watchId = w!.id;
    const [m] = await handle.db.insert(schema.match).values({ postId, watchId, score: 0.9, matchedTerms: ["xe"] }).returning({ id: schema.match.id });
    await handle.db.insert(schema.notification).values({ matchId: m!.id, userId, channel: "telegram", status: "sent", sentAt: new Date() });
    await handle.db.insert(schema.insight).values({
      teamId,
      userId,
      kind: "digest",
      day: "2026-09-15",
      dedupeKey: `pii-${RUN}`,
      text: `Digest: Bán xe lh 0912 345 678 của ${NAME}`.replace(NAME, "anh A"),
      payload: { notable: [{ line: "Bán xe lh 0912 345 678", postId }] },
    });
    await handle.sql`insert into metric_rollup (bucket, ts, dims, counts) values ('day', '2026-09-10T00:00:00Z'::timestamptz, ${JSON.stringify({ metric: "authors", teamId, authorKey: authorKey({ authorId: AUTHOR_ID, authorName: NAME }) })}::jsonb, ${JSON.stringify({ name: NAME, posts: 2, sell: 1 })}::jsonb)`;
    ref = authorRef(await loadPiiSalt(handle), authorKey({ authorId: AUTHOR_ID, authorName: NAME }))!;
  });

  afterAll(async () => {
    await handle.sql`delete from metric_rollup where dims->>'teamId' = ${teamId}`;
    await handle.db.delete(schema.insight).where(eq(schema.insight.teamId, teamId));
    await handle.db.delete(schema.notification).where(eq(schema.notification.userId, userId));
    await handle.db.delete(schema.match).where(inArray(schema.match.postId, [postId, otherPostId]));
    await handle.db.delete(schema.watch).where(eq(schema.watch.userId, userId));
    await handle.db.delete(schema.post).where(inArray(schema.post.id, [postId, otherPostId]));
    await handle.db.delete(schema.apiKey).where(eq(schema.apiKey.userId, userId));
    await handle.db.delete(schema.source).where(eq(schema.source.teamId, teamId));
    await handle.db.delete(schema.user).where(eq(schema.user.teamId, teamId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("/api/posts/:id: authorRef, masked text, no raw, no leaks", async () => {
    const res = await session(`/api/posts/${postId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).not.toBeNull();
    const text = await res.text();
    expectClean(text);
    const body = JSON.parse(text) as { post: Record<string, unknown> };
    expect(body.post.authorRef).toBe(ref);
    expect(body.post.authorName).toBe(authorLabel(ref));
    expect("raw" in body.post).toBe(false);
    expect("authorId" in body.post).toBe(false);
    expect(String(body.post.text)).toContain(PHONE_MASK);
    expect(text).not.toContain("raw-marker");
  });

  const sessionRoutes = ["/api/posts", "/api/search?q=xe", "/api/dashboard/matches", "/api/analytics/authors?from=2026-09-01T00:00:00Z&to=2026-09-30T00:00:00Z", "/api/insights"];
  for (const path of sessionRoutes) {
    test(`${path} has no leaks`, async () => {
      const res = await session(path);
      expect(res.status).toBe(200);
      expectClean(await res.text());
    });
  }

  test("api-key routes: /api/matches, /api/notifications, POST /api/watches/:id/test", async () => {
    for (const [path, init] of [
      ["/api/matches", {}],
      ["/api/notifications", {}],
      [`/api/watches/${watchId}/test`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }],
    ] as [string, RequestInit][]) {
      const res = await keyed(path, init);
      expect(res.status).toBe(200);
      expectClean(await res.text());
    }
  });

  test("analytics authors carry the ref as key and the label as name", async () => {
    const body = (await (await session("/api/analytics/authors?from=2026-09-01T00:00:00Z&to=2026-09-30T00:00:00Z")).json()) as { authors: { authorKey: string; name: string }[] };
    expect(body.authors[0]).toMatchObject({ authorKey: ref, name: `Member #${ref}` });
  });

  test("inbox: the insight text and notable line are masked on read", async () => {
    const body = (await (await session("/api/insights")).json()) as { items: { text: string; payload: { notable: { line: string }[] } }[] };
    expect(body.items[0]!.text).toContain(PHONE_MASK);
    expect(body.items[0]!.payload.notable[0]!.line).toContain(PHONE_MASK);
  });

  test("CSV: author column is the label, phone/name/id absent", async () => {
    const res = await session("/api/search/export.csv?q=xe");
    expect(res.status).toBe(200);
    const csv = await res.text();
    expectClean(csv);
    expect(csv).toContain(`Member #${ref}`);
    expect(csv).toContain(PHONE_MASK);
  });

  test("search: author=<ref> is the only hit; a name is a 400; phone q finds it with a masked snippet", async () => {
    const byRef = (await (await session(`/api/search?q=xe&author=${ref}`)).json()) as { items: { id: string }[] };
    expect(byRef.items.map((i) => i.id)).toEqual([postId]);
    const byName = await session(`/api/search?q=xe&author=${encodeURIComponent("Nguyễn")}`);
    expect(byName.status).toBe(400);
    const byPhone = await session("/api/search?q=0912345678");
    const text = await byPhone.text();
    expect((JSON.parse(text) as { items: { id: string }[] }).items.map((i) => i.id)).toContain(postId);
    expectClean(text);
  });
});
