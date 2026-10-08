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
    console.warn(`reenrich.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
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
  throw new Error("reenrich.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("reenrich.test.ts: skipped — TEST_DATABASE_URL is unset");
}

describe.skipIf(!canRun)("POST /api/posts/:id/reenrich", () => {
  let handle: DbHandle;
  let teamId: string;
  let sourceId: string;
  let apiKeyToken: string;

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    const [team] = await handle.db.insert(schema.team).values({ name: "reenrich-test-team" }).returning({ id: schema.team.id });
    teamId = team!.id;
    const [user] = await handle.db
      .insert(schema.user)
      .values({ teamId, email: `reenrich-${crypto.randomUUID()}@example.com`, role: "operator" })
      .returning({ id: schema.user.id });
    apiKeyToken = `sk_test_${crypto.randomUUID().replaceAll("-", "")}`;
    await handle.db.insert(schema.apiKey).values({
      userId: user!.id,
      name: "reenrich",
      prefix: apiKeyToken.slice(0, 8),
      hash: await sha256Hex(apiKeyToken),
      scopes: ["catalogue:write"],
    });
    const [source] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `reenrich-${crypto.randomUUID()}`, name: "s", url: "https://feeds.example.test/reenrich-src" })
      .returning({ id: schema.source.id });
    sourceId = source!.id;
  });

  afterAll(async () => {
    await handle.db.delete(schema.post).where(eq(schema.post.sourceId, sourceId));
    await handle.db.delete(schema.source).where(eq(schema.source.id, sourceId));
    await handle.db.delete(schema.user).where(eq(schema.user.teamId, teamId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  test("returns 202 with a jobId when a boss is configured", async () => {
    const [post] = await handle.db
      .insert(schema.post)
      .values({ sourceId, platformPostId: `reenrich-${crypto.randomUUID()}`, url: "https://feeds.example.test/reenrich-src/posts/1", text: "t", textNormalized: "t" })
      .returning({ id: schema.post.id });

    const sent: { name: string; data: unknown }[] = [];
    const fakeBoss = { send: async (name: string, data: unknown) => { sent.push({ name, data }); return "job-1"; } };
    const app = createApp(handle, fakeBoss as never);

    const res = await app.request(`/api/posts/${post!.id}/reenrich`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKeyToken}`, "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string };
    expect(body.jobId).toBe("job-1");
    expect(sent.length).toBe(1);
    expect(sent[0]?.name).toBe("enrich");
  });

  test("404 for an unknown post", async () => {
    const fakeBoss = { send: async () => "job-2" };
    const app = createApp(handle, fakeBoss as never);
    const res = await app.request(`/api/posts/${crypto.randomUUID()}/reenrich`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKeyToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  // 
  test("400 (not 500) for a non-uuid id", async () => {
    const fakeBoss = { send: async () => "job-3" };
    const app = createApp(handle, fakeBoss as never);
    const res = await app.request("/api/posts/not-a-uuid/reenrich", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKeyToken}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("404 for a post belonging to another team (no cross-tenant probe/re-enrich)", async () => {
    const [otherTeam] = await handle.db.insert(schema.team).values({ name: "reenrich-other-team" }).returning({ id: schema.team.id });
    const [otherSource] = await handle.db
      .insert(schema.source)
      .values({ teamId: otherTeam!.id, kind: "web", platformId: `reenrich-other-${crypto.randomUUID()}`, name: "s2", url: "https://feeds.example.test/reenrich-other-src" })
      .returning({ id: schema.source.id });
    const [otherPost] = await handle.db
      .insert(schema.post)
      .values({ sourceId: otherSource!.id, platformPostId: `reenrich-other-${crypto.randomUUID()}`, url: "https://feeds.example.test/reenrich-other-src/posts/1", text: "t", textNormalized: "t" })
      .returning({ id: schema.post.id });

    const fakeBoss = { send: async () => "job-4" };
    const app = createApp(handle, fakeBoss as never);
    const res = await app.request(`/api/posts/${otherPost!.id}/reenrich`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKeyToken}`, "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    expect(res.status).toBe(404);

    await handle.db.delete(schema.post).where(eq(schema.post.id, otherPost!.id));
    await handle.db.delete(schema.source).where(eq(schema.source.id, otherSource!.id));
    await handle.db.delete(schema.team).where(eq(schema.team.id, otherTeam!.id));
  });
});
