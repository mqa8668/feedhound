import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../index";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const MUST_RUN = Boolean(process.env.CI) || Boolean(TEST_DATABASE_URL);

function isTestDbUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    return new URL(url).pathname.replace(/^\//, "").endsWith("_test");
  } catch {
    return false;
  }
}

if (TEST_DATABASE_URL && !isTestDbUrl(TEST_DATABASE_URL)) {
  throw new Error("TEST_DATABASE_URL must point at a database whose name ends in '_test'");
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

let canRun = false;
if (TEST_DATABASE_URL) {
  const probe = createDb(TEST_DATABASE_URL);
  let reachable = true;
  try {
    await probe.sql`select 1`;
  } catch (err) {
    reachable = false;
    if (MUST_RUN) {
      await probe.close();
      throw err;
    }
    console.warn(`catalogue.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
  }
  if (reachable) {
    const rows = await probe.sql<{ name: string }[]>`select current_database() as name`;
    const name = rows[0]?.name;
    if (!name || !name.endsWith("_test")) {
      await probe.close();
      throw new Error(`refusing to run against non-test database: ${name ?? "unknown"}`);
    }
    canRun = true;
  }
  await probe.close();
} else if (MUST_RUN) {
  throw new Error("catalogue.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("catalogue.test.ts: skipped — TEST_DATABASE_URL is unset");
}

describe.skipIf(!canRun)("catalogue routes", () => {
  let handle: DbHandle;
  let teamId: string;
  let operatorKey: string;
  let hunterKey: string;
  let categoryId: string;

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    const [team] = await handle.db.insert(schema.team).values({ name: "catalogue-test-team" }).returning({ id: schema.team.id });
    teamId = team!.id;
    const [operator] = await handle.db
      .insert(schema.user)
      .values({ teamId, email: `catalogue-op-${crypto.randomUUID()}@example.com`, role: "operator" })
      .returning({ id: schema.user.id });
    const [hunter] = await handle.db
      .insert(schema.user)
      .values({ teamId, email: `catalogue-hunter-${crypto.randomUUID()}@example.com`, role: "hunter" })
      .returning({ id: schema.user.id });

    operatorKey = `sk_test_${crypto.randomUUID().replaceAll("-", "")}`;
    await handle.db.insert(schema.apiKey).values({
      userId: operator!.id,
      name: "operator",
      prefix: operatorKey.slice(0, 8),
      hash: await sha256Hex(operatorKey),
      scopes: ["catalogue:read", "catalogue:write"],
    });

    hunterKey = `sk_test_${crypto.randomUUID().replaceAll("-", "")}`;
    await handle.db.insert(schema.apiKey).values({
      userId: hunter!.id,
      name: "hunter",
      prefix: hunterKey.slice(0, 8),
      hash: await sha256Hex(hunterKey),
      scopes: ["catalogue:read", "catalogue:write"],
    });

    const [cat] = await handle.db
      .insert(schema.category)
      .values({ slug: `catalogue-test-${crypto.randomUUID()}`, name: "Catalogue Test", path: `catalogue_test_${Date.now()}` })
      .returning({ id: schema.category.id });
    categoryId = cat!.id;
  });

  afterAll(async () => {
    const users = await handle.db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.teamId, teamId));
    for (const u of users) await handle.db.delete(schema.apiKey).where(eq(schema.apiKey.userId, u.id));
    await handle.db.delete(schema.catalogItem).where(eq(schema.catalogItem.categoryId, categoryId));
    await handle.db.delete(schema.category).where(eq(schema.category.id, categoryId));
    await handle.db.delete(schema.user).where(eq(schema.user.teamId, teamId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("POST /api/catalogue/items -> 201; PATCH adds alias; GET reflects it", async () => {
    const app = createApp(handle);
    const createRes = await app.request("/api/catalogue/items", {
      method: "POST",
      headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
      body: JSON.stringify({ categoryId, name: "iPhone 15 Pro Max", aliases: ["ip15pm"] }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { item: { id: string; aliases: string[] } };
    expect(created.item.aliases).toEqual(["ip15pm"]);

    const patchRes = await app.request(`/api/catalogue/items/${created.item.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${operatorKey}`, "content-type": "application/json" },
      body: JSON.stringify({ aliases: ["ip15pm", "ip15 pro max"] }),
    });
    expect(patchRes.status).toBe(200);

    const listRes = await app.request(`/api/catalogue/items?categoryId=${categoryId}`, {
      headers: { authorization: `Bearer ${operatorKey}` },
    });
    const list = (await listRes.json()) as { items: { id: string; aliases: string[] }[] };
    const found = list.items.find((i) => i.id === created.item.id);
    expect(found?.aliases).toEqual(["ip15pm", "ip15 pro max"]);

    // DELETE of a referenced item -> 409 (referenced by Enrichment).
    const [post] = await handle.db
      .insert(schema.post)
      .values({
        sourceId: (
          await handle.db
            .insert(schema.source)
            .values({ teamId, kind: "web", platformId: `catalogue-src-${crypto.randomUUID()}`, name: "s", url: "https://feeds.example.test/catalogue-src" })
            .returning({ id: schema.source.id })
        )[0]!.id,
        platformPostId: `catalogue-${crypto.randomUUID()}`,
        url: "https://feeds.example.test/catalogue-src/posts/1",
        text: "t",
        textNormalized: "t",
      })
      .returning({ id: schema.post.id, sourceId: schema.post.sourceId });
    await handle.db.insert(schema.enrichment).values({ postId: post!.id, itemId: created.item.id });

    const deleteRes = await app.request(`/api/catalogue/items/${created.item.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${operatorKey}` },
    });
    expect(deleteRes.status).toBe(409);

    await handle.db.delete(schema.enrichment).where(eq(schema.enrichment.postId, post!.id));
    await handle.db.delete(schema.post).where(eq(schema.post.id, post!.id));
    await handle.db.delete(schema.source).where(eq(schema.source.id, post!.sourceId));
  });

  test("POST /api/catalogue/categories rejects a non-operator key with 403", async () => {
    const app = createApp(handle);
    const res = await app.request("/api/catalogue/categories", {
      method: "POST",
      headers: { authorization: `Bearer ${hunterKey}`, "content-type": "application/json" },
      body: JSON.stringify({ slug: "nope", name: "Nope" }),
    });
    expect(res.status).toBe(403);
  });

  test("GET /api/enrichment/unclassified lists categoryId=null, omits high-confidence rows", async () => {
    const app = createApp(handle);
    const [source] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `unclassified-src-${crypto.randomUUID()}`, name: "s", url: "https://feeds.example.test/unclassified-src" })
      .returning({ id: schema.source.id });

    const [postA] = await handle.db
      .insert(schema.post)
      .values({ sourceId: source!.id, platformPostId: `uc-a-${crypto.randomUUID()}`, url: "https://feeds.example.test/unclassified-src/posts/1", text: "a", textNormalized: "a" })
      .returning({ id: schema.post.id });
    const [postB] = await handle.db
      .insert(schema.post)
      .values({ sourceId: source!.id, platformPostId: `uc-b-${crypto.randomUUID()}`, url: "https://feeds.example.test/unclassified-src/posts/2", text: "b", textNormalized: "b" })
      .returning({ id: schema.post.id });

    await handle.db.insert(schema.enrichment).values({ postId: postA!.id, categoryId: null, confidence: 0.1 });
    await handle.db.insert(schema.enrichment).values({ postId: postB!.id, categoryId, confidence: 0.9 });

    const res = await app.request("/api/enrichment/unclassified", { headers: { authorization: `Bearer ${operatorKey}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { post: { id: string } }[] };
    const ids = body.items.map((i) => i.post.id);
    expect(ids).toContain(postA!.id);
    expect(ids).not.toContain(postB!.id);

    await handle.db.delete(schema.enrichment).where(eq(schema.enrichment.postId, postA!.id));
    await handle.db.delete(schema.enrichment).where(eq(schema.enrichment.postId, postB!.id));
    await handle.db.delete(schema.post).where(eq(schema.post.sourceId, source!.id));
    await handle.db.delete(schema.source).where(eq(schema.source.id, source!.id));
  });

  // this endpoint had no team scoping and leaked
  // post id/title/url across teams to any `catalogue:read` key.
  test("GET /api/enrichment/unclassified never returns another team's posts", async () => {
    const app = createApp(handle);
    const [otherTeam] = await handle.db.insert(schema.team).values({ name: "catalogue-other-team" }).returning({ id: schema.team.id });
    const [otherSource] = await handle.db
      .insert(schema.source)
      .values({ teamId: otherTeam!.id, kind: "web", platformId: `unclassified-other-${crypto.randomUUID()}`, name: "s2", url: "https://feeds.example.test/unclassified-other-src" })
      .returning({ id: schema.source.id });
    const [otherPost] = await handle.db
      .insert(schema.post)
      .values({ sourceId: otherSource!.id, platformPostId: `uc-other-${crypto.randomUUID()}`, url: "https://feeds.example.test/unclassified-other-src/posts/1", text: "c", textNormalized: "c" })
      .returning({ id: schema.post.id });
    await handle.db.insert(schema.enrichment).values({ postId: otherPost!.id, categoryId: null, confidence: 0.1 });

    const res = await app.request("/api/enrichment/unclassified?limit=100", { headers: { authorization: `Bearer ${operatorKey}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { post: { id: string } }[] };
    const ids = body.items.map((i) => i.post.id);
    expect(ids).not.toContain(otherPost!.id);

    await handle.db.delete(schema.enrichment).where(eq(schema.enrichment.postId, otherPost!.id));
    await handle.db.delete(schema.post).where(eq(schema.post.id, otherPost!.id));
    await handle.db.delete(schema.source).where(eq(schema.source.id, otherSource!.id));
    await handle.db.delete(schema.team).where(eq(schema.team.id, otherTeam!.id));
  });
});
