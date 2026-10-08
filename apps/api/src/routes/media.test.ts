import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../index";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL && process.env.CI) throw new Error("media.test.ts: TEST_DATABASE_URL is required (CI is set)");
if (TEST_DATABASE_URL && !new URL(TEST_DATABASE_URL).pathname.replace(/^\//, "").endsWith("_test")) {
  throw new Error("TEST_DATABASE_URL must point at a database whose name ends in '_test'");
}

// route half: 
describe.skipIf(!TEST_DATABASE_URL)("GET /api/media/:postId/thumb", () => {
  const RUN = crypto.randomUUID().slice(0, 8);
  const mine = `md-me-${RUN}@example.com`;
  const theirs = `md-other-${RUN}@example.com`;
  let handle: DbHandle;
  let mediaDir: string;
  let prevMedia: string | undefined;
  let teamId: string;
  let team2: string;
  let withFile: string;
  let withoutFile: string;

  const get = async (path: string, as?: string): Promise<Response> => createApp(handle).request(path, as ? { headers: { "X-Dev-User": as } } : {});

  beforeAll(async () => {
    process.env.NODE_ENV = "development";
    process.env.DEV_AUTH_BYPASS = "1";
    prevMedia = process.env.MEDIA_DIR;
    mediaDir = await mkdtemp(join(tmpdir(), "media-"));
    process.env.MEDIA_DIR = mediaDir;
    handle = createDb(TEST_DATABASE_URL!);
    const teams = await handle.db
      .insert(schema.team)
      .values([{ name: `md-1-${RUN}` }, { name: `md-2-${RUN}` }])
      .returning({ id: schema.team.id });
    teamId = teams[0]!.id;
    team2 = teams[1]!.id;
    await handle.db.insert(schema.user).values([
      { teamId, email: mine, role: "hunter" },
      { teamId: team2, email: theirs, role: "hunter" },
    ]);
    const [s] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `md-${RUN}`, name: "md", url: `https://feeds.example.test/md-${RUN}` })
      .returning({ id: schema.source.id });
    const posts = await handle.db
      .insert(schema.post)
      .values([
        { sourceId: s!.id, platformPostId: `md1-${RUN}`, url: "u", thumbState: "ok" },
        { sourceId: s!.id, platformPostId: `md2-${RUN}`, url: "u", thumbState: "ok" },
      ])
      .returning({ id: schema.post.id });
    withFile = posts[0]!.id;
    withoutFile = posts[1]!.id;
    await mkdir(join(mediaDir, "thumbs", withFile.slice(0, 2)), { recursive: true });
    await writeFile(join(mediaDir, "thumbs", withFile.slice(0, 2), `${withFile}.webp`), "RIFFfakewebp");
  });

  afterAll(async () => {
    if (prevMedia === undefined) delete process.env.MEDIA_DIR;
    else process.env.MEDIA_DIR = prevMedia;
    await rm(mediaDir, { recursive: true, force: true });
    await handle.db.delete(schema.post).where(eq(schema.post.platformPostId, `md1-${RUN}`));
    await handle.db.delete(schema.post).where(eq(schema.post.platformPostId, `md2-${RUN}`));
    await handle.db.delete(schema.source).where(eq(schema.source.teamId, teamId));
    await handle.db.delete(schema.user).where(eq(schema.user.teamId, teamId));
    await handle.db.delete(schema.user).where(eq(schema.user.teamId, team2));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, team2));
    await handle.close();
  });

  test("200 image/webp with immutable private cache headers and an ETag; 304 on revalidation", async () => {
    const res = await get(`/api/media/${withFile}/thumb`, mine);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    const etag = res.headers.get("etag");
    expect(etag).toBeTruthy();
    expect(await res.text()).toBe("RIFFfakewebp");
    const again = await createApp(handle).request(`/api/media/${withFile}/thumb`, { headers: { "X-Dev-User": mine, "If-None-Match": etag! } });
    expect(again.status).toBe(304);
  });

  test("404 for another team, a missing file, a non-uuid; 401 without a session", async () => {
    expect((await get(`/api/media/${withFile}/thumb`, theirs)).status).toBe(404);
    expect((await get(`/api/media/${withoutFile}/thumb`, mine)).status).toBe(404);
    expect((await get(`/api/media/..%2Fx/thumb`, mine)).status).toBe(404);
    expect((await get(`/api/media/../x/thumb`, mine)).status).toBe(404);
    expect((await get(`/api/media/${withFile}/thumb`)).status).toBe(401);
  });
});
