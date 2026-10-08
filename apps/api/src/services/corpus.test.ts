import { postFingerprint } from "@feedhound/core/fingerprint";
import { repostKey } from "@feedhound/core/listing";
import type { ServerRawPost as RawPost } from "@feedhound/core/sources";
import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { deriveTitle, ingestPosts } from "./corpus";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
// Same fail-not-skip pattern as routes/ingest.test.ts.
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
    console.warn(`corpus.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
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
  throw new Error("corpus.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("corpus.test.ts: skipped — TEST_DATABASE_URL is unset");
}

function raw(over: Partial<RawPost> & { platformPostId: string }): RawPost {
  return {
    url: "https://feeds.example.test/x/",
    authorName: "Ann",
    authorId: "42",
    text: "Ban xe Wave 2020 gia tot",
    media: [],
    capturedAt: "2026-10-03T00:00:00.000Z",
    ...over,
  };
}

describe.skipIf(!canRun)("corpus identity (integration)", () => {
  let handle: DbHandle;
  let teamId: string;
  let userId: string;
  const sourceIds: string[] = [];
  const platformId = `g013-${crypto.randomUUID()}`;

  async function newSource(): Promise<string> {
    const [s] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId, name: "013", url: "https://example.com/g013" })
      .returning({ id: schema.source.id });
    sourceIds.push(s!.id);
    return s!.id;
  }

  const rowsOf = (sourceId: string) =>
    handle.db.select().from(schema.post).where(eq(schema.post.sourceId, sourceId)).orderBy(asc(schema.post.firstSeenAt));

  /** Deterministic "later": push every row's lastSeenAt a second into the past instead of racing a 5 ms sleep against clock granularity/skew. */
  async function rowsOfBackdated(sourceId: string) {
    await handle.db.update(schema.post).set({ lastSeenAt: new Date(Date.now() - 1_000) }).where(eq(schema.post.sourceId, sourceId));
    return rowsOf(sourceId);
  }

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    const [team] = await handle.db.insert(schema.team).values({ name: "corpus-013-team" }).returning({ id: schema.team.id });
    teamId = team!.id;
    const [user] = await handle.db
      .insert(schema.user)
      .values({ teamId, email: `corpus-013-${crypto.randomUUID()}@example.com`, role: "hunter" })
      .returning({ id: schema.user.id });
    userId = user!.id;
    await handle.db.insert(schema.watch).values({ userId, name: "w013" });
  });

  afterAll(async () => {
    for (const sid of sourceIds) {
      const posts = await handle.db.select({ id: schema.post.id }).from(schema.post).where(eq(schema.post.sourceId, sid));
      for (const p of posts) {
        await handle.db.delete(schema.match).where(eq(schema.match.postId, p.id));
        await handle.db.delete(schema.enrichment).where(eq(schema.enrichment.postId, p.id));
        await handle.db.delete(schema.postRevision).where(eq(schema.postRevision.postId, p.id));
      }
      await handle.db.delete(schema.post).where(eq(schema.post.sourceId, sid));
    }
    await handle.db.delete(schema.source).where(eq(schema.source.teamId, teamId));
    await handle.db.delete(schema.watch).where(eq(schema.watch.userId, userId));
    await handle.db.delete(schema.user).where(eq(schema.user.teamId, teamId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  }, 20_000); // per-row cleanup of every test's posts; the default 5 s flaked under load

  test("Re-ingesting the same post is idempotent and only refreshes lastSeenAt", async () => {
    const sid = await newSource();
    const a = raw({ platformPostId: "item-1", media: [{ type: "image", url: "https://img.example.com/x.jpg" }] });
    expect(await ingestPosts(handle, undefined, sid, [a])).toEqual({ accepted: 1, duplicates: 0, updated: 0 });
    const [before] = await rowsOfBackdated(sid);
    await Bun.sleep(5);
    expect(await ingestPosts(handle, undefined, sid, [a])).toEqual({ accepted: 0, duplicates: 1, updated: 0 });
    const rows = await rowsOf(sid);
    expect(rows.length).toBe(1);
    expect(rows[0]!.fingerprint).toBe(postFingerprint({ scopeId: platformId, authorId: "42", authorName: "Ann", text: a.text }));
    expect(rows[0]!.lastSeenAt.getTime()).toBeGreaterThan(before!.lastSeenAt.getTime());
  });

  test("Edit keeps one row, one revision, fingerprint follows the new text", async () => {
    const sid = await newSource();
    await ingestPosts(handle, undefined, sid, [raw({ platformPostId: "9001", text: "old text here" })]);
    const [orig] = await rowsOf(sid);
    const res = await ingestPosts(handle, undefined, sid, [raw({ platformPostId: "9001", text: "new text here" })]);
    expect(res.updated).toBe(1);
    const rows = await rowsOf(sid);
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe(orig!.id);
    expect(rows[0]!.editCount).toBe(1);
    expect(rows[0]!.fingerprint).toBe(postFingerprint({ scopeId: platformId, authorId: "42", text: "new text here" }));
    const revs = await handle.db.select().from(schema.postRevision).where(eq(schema.postRevision.postId, orig!.id));
    expect(revs.length).toBe(1);
    expect(revs[0]!.text).toBe("old text here");
  });

  test("Different ids with identical text stay separate rows (identity is the platform id)", async () => {
    const sid = await newSource();
    await ingestPosts(handle, undefined, sid, [raw({ platformPostId: "a1" }), raw({ platformPostId: "a2" })]);
    const rows = await rowsOf(sid);
    expect(rows.map((r) => r.platformPostId).sort()).toEqual(["a1", "a2"]);
  });

  test("Author and empty-text edge rules", async () => {
    const sid = await newSource();
    await ingestPosts(handle, undefined, sid, [
      raw({ platformPostId: "1", authorId: "a", authorName: undefined, text: "same words" }),
      raw({ platformPostId: "2", authorId: "b", authorName: undefined, text: "same words" }),
    ]);
    expect((await rowsOf(sid)).length).toBe(2);

    const sid3 = await newSource();
    const empty = (id: string) => raw({ platformPostId: id, text: "" });
    await ingestPosts(handle, undefined, sid3, [empty("g1"), empty("g2"), empty("g1")]);
    const rows = await rowsOf(sid3);
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.fingerprint === null)).toBe(true);
  });

  test("concurrent ingests of the same new post insert one row; of the same edit, one revision", async () => {
    const sid = await newSource();
    const p = raw({ platformPostId: "c1", text: "concurrent original text" });
    await Promise.all([ingestPosts(handle, undefined, sid, [p]), ingestPosts(handle, undefined, sid, [p]), ingestPosts(handle, undefined, sid, [p])]);
    expect((await rowsOf(sid)).length).toBe(1);

    const edit = raw({ platformPostId: "c1", text: "concurrent edited text" });
    await Promise.all([ingestPosts(handle, undefined, sid, [edit]), ingestPosts(handle, undefined, sid, [edit]), ingestPosts(handle, undefined, sid, [edit])]);
    const [row] = await rowsOf(sid);
    expect(row!.editCount).toBe(1);
    expect((await handle.db.select().from(schema.postRevision).where(eq(schema.postRevision.postId, row!.id))).length).toBe(1);
  });

  test("emoji/whitespace-only difference is not an edit; a change past char 500 is", async () => {
    const sid = await newSource();
    await ingestPosts(handle, undefined, sid, [raw({ platformPostId: "6001", text: "Used bike 2020" })]);
    const res = await ingestPosts(handle, undefined, sid, [raw({ platformPostId: "6001", text: "Used  bike 2020 \u{1F525}" })]);
    expect(res).toEqual({ accepted: 0, duplicates: 1, updated: 0 });
    let rows = await rowsOf(sid);
    expect(rows[0]!.editCount).toBe(0);
    expect((await handle.db.select().from(schema.postRevision).where(eq(schema.postRevision.postId, rows[0]!.id))).length).toBe(0);

    const long = "a".repeat(600);
    await ingestPosts(handle, undefined, sid, [raw({ platformPostId: "6002", text: long })]);
    const res2 = await ingestPosts(handle, undefined, sid, [raw({ platformPostId: "6002", text: `${long}b` })]);
    expect(res2.updated).toBe(1);
    rows = await rowsOf(sid);
    expect(rows.find((r) => r.platformPostId === "6002")!.editCount).toBe(1);
  });

  test("api insert stores capture + posted_at; lower-rank push with different text never overwrites", async () => {
    const sid = await newSource();
    const full = "Phone model X 256GB blue, like new, full box, long warranty, nationwide shipping";
    const postedAt = "2026-10-03T03:00:00.000Z";
    await ingestPosts(handle, undefined, sid, [raw({ platformPostId: "9101", text: full, capture: "api", postedAt })]);
    const [row] = await rowsOfBackdated(sid);
    expect(row!.capture).toBe("api");
    expect(row!.postedAt?.toISOString()).toBe(postedAt);

    const res = await ingestPosts(handle, undefined, sid, [raw({ platformPostId: "9101", text: "Phone model X 256GB blue... see more", capture: "push" })]);
    expect(res).toEqual({ accepted: 0, duplicates: 1, updated: 0 });
    const [after] = await rowsOf(sid);
    expect(after!.text).toBe(full);
    expect(after!.capture).toBe("api");
    expect(after!.editCount).toBe(0);
    expect(after!.lastSeenAt.getTime()).toBeGreaterThanOrEqual(row!.lastSeenAt.getTime());
    const revs = await handle.db.select().from(schema.postRevision).where(eq(schema.postRevision.postId, row!.id));
    expect(revs.length).toBe(0);
  });

  test("push row then api with fuller text upgrades in place (no revision, updated outcome)", async () => {
    const sid = await newSource();
    const full = "Selling scooter 2019, clean papers, single owner, low mileage, price negotiable";
    await ingestPosts(handle, undefined, sid, [raw({ platformPostId: "9102", text: "Selling scooter 2019... see more", capture: "push" })]);
    const [orig] = await rowsOf(sid);
    expect(orig!.capture).toBe("push");

    const res = await ingestPosts(handle, undefined, sid, [raw({ platformPostId: "9102", text: full, capture: "api", postedAt: "2026-10-03T04:00:00.000Z" })]);
    expect(res.updated).toBe(1);
    const [row] = await rowsOf(sid);
    expect(row!.text).toBe(full);
    expect(row!.capture).toBe("api");
    expect(row!.editCount).toBe(0);
    expect(row!.postedAt?.toISOString()).toBe("2026-10-03T04:00:00.000Z");
    expect(row!.fingerprint).toBe(postFingerprint({ scopeId: platformId, authorId: "42", text: full }));
    const revs = await handle.db.select().from(schema.postRevision).where(eq(schema.postRevision.postId, orig!.id));
    expect(revs.length).toBe(0);

    // Same text from api onto a legacy (null capture) row only tags the capture.
    const sid2 = await newSource();
    await ingestPosts(handle, undefined, sid2, [raw({ platformPostId: "9103", text: full })]);
    await handle.db.update(schema.post).set({ capture: null }).where(eq(schema.post.sourceId, sid2));
    const same = await ingestPosts(handle, undefined, sid2, [raw({ platformPostId: "9103", text: full, capture: "api" })]);
    expect(same.duplicates).toBe(1);
    const [tagged] = await rowsOf(sid2);
    expect(tagged!.capture).toBe("api");
  });

  test("a push->api upgrade enqueues a forced capture_upgrade enrich with its own singleton key", async () => {
    const sid = await newSource();
    const sent: { name: string; data: Record<string, unknown>; opts: Record<string, unknown> }[] = [];
    const boss = {
      createQueue: async () => undefined,
      send: async (name: string, data: Record<string, unknown>, opts: Record<string, unknown>) => {
        sent.push({ name, data, opts });
        return "id";
      },
    } as unknown as Parameters<typeof ingestPosts>[1];
    const full = "Selling scooter 2021, single owner, papers complete, barely used, price negotiable";
    await ingestPosts(handle, boss, sid, [raw({ platformPostId: "9105", text: "Selling scooter 2021... see more", capture: "push" })]);
    sent.length = 0;
    await ingestPosts(handle, boss, sid, [raw({ platformPostId: "9105", text: full, capture: "api" })]);
    const enrich = sent.filter((m) => m.name === "enrich");
    expect(enrich.length).toBe(1);
    expect(enrich[0]!.data).toMatchObject({ revision: 0, force: true, reason: "capture_upgrade" });
    expect(enrich[0]!.opts.singletonKey).toMatch(/:0:upgrade$/);
    const [row] = await rowsOf(sid);
    expect(row!.editCount).toBe(0);
  });

  test("push -> push text change (equal rank) creates one revision", async () => {
    const sid = await newSource();
    await ingestPosts(handle, undefined, sid, [raw({ platformPostId: "9104", text: "old pushed text here", capture: "push" })]);
    const res = await ingestPosts(handle, undefined, sid, [raw({ platformPostId: "9104", text: "new pushed text here", capture: "push" })]);
    expect(res.updated).toBe(1);
    const [row] = await rowsOf(sid);
    expect(row!.editCount).toBe(1);
    const revs = await handle.db.select().from(schema.postRevision).where(eq(schema.postRevision.postId, row!.id));
    expect(revs.length).toBe(1);
  });

  test("api -> api text change (equal rank) creates one revision", async () => {
    const sid = await newSource();
    await ingestPosts(handle, undefined, sid, [raw({ platformPostId: "9106", text: "old api text here", capture: "api" })]);
    const res = await ingestPosts(handle, undefined, sid, [raw({ platformPostId: "9106", text: "new api text here", capture: "api" })]);
    expect(res.updated).toBe(1);
    const [row] = await rowsOf(sid);
    expect(row!.editCount).toBe(1);
    expect((await handle.db.select().from(schema.postRevision).where(eq(schema.postRevision.postId, row!.id))).length).toBe(1);
  });

  test("pipeline columns default pending, reset on edit/upgrade, untouched on duplicate, CHECK enforced", async () => {
    const sid = await newSource();
    await ingestPosts(handle, undefined, sid, [raw({ platformPostId: "9501", text: "Selling scooter 2019... see more", capture: "push" })]);
    const [p0] = await rowsOf(sid);
    expect([p0!.enrichState, p0!.matchState, p0!.pipelineVersion]).toEqual(["pending", "pending", 0]);

    const markDone = () =>
      handle.db
        .update(schema.post)
        .set({ enrichState: "done", matchState: "done", pipelineAttempts: 2 })
        .where(eq(schema.post.id, p0!.id));
    await markDone();
    const dup = await ingestPosts(handle, undefined, sid, [raw({ platformPostId: "9501", text: "Selling scooter 2019... see more", capture: "push" })]);
    expect(dup.duplicates).toBe(1);
    const [afterDup] = await rowsOf(sid);
    expect([afterDup!.enrichState, afterDup!.matchState, afterDup!.pipelineVersion, afterDup!.pipelineAttempts]).toEqual(["done", "done", 0, 2]);

    const full = "Selling scooter 2019, clean papers, single owner, low mileage, price negotiable, call today";
    await ingestPosts(handle, undefined, sid, [raw({ platformPostId: "9501", text: full, capture: "api" })]);
    const [afterUp] = await rowsOf(sid);
    expect(afterUp!.editCount).toBe(0);
    expect([afterUp!.enrichState, afterUp!.matchState, afterUp!.pipelineVersion, afterUp!.pipelineAttempts]).toEqual(["pending", "pending", 1, 0]);

    await markDone();
    await ingestPosts(handle, undefined, sid, [raw({ platformPostId: "9501", text: `${full} - price reduced, contact now`, capture: "api" })]);
    const [afterEdit] = await rowsOf(sid);
    expect(afterEdit!.editCount).toBe(1);
    expect([afterEdit!.enrichState, afterEdit!.matchState, afterEdit!.pipelineVersion, afterEdit!.pipelineAttempts]).toEqual(["pending", "pending", 2, 0]);

    await expect(Promise.resolve(handle.sql`update post set enrich_state = 'bogus' where id = ${p0!.id}`.execute())).rejects.toThrow(/post_enrich_state_check/);
  }, 30_000);

  test("deriveTitle joins short first lines and cuts at 80 code points", () => {
    expect(deriveTitle("ạh\nSantafe 2019 máy dầu\n\ngiá 680tr")).toBe("ạh · Santafe 2019 máy dầu · giá 680tr");
    const fifty = "x".repeat(50);
    expect(deriveTitle(`${fifty}\nsecond`)).toBe(fifty);
    expect(Array.from(deriveTitle("y".repeat(200))).length).toBe(80);
    expect(deriveTitle("\n \n")).toBe("");
  });

  test("repost_key is shared across groups for one seller, differs per seller, null without author, follows edits", async () => {
    const [a, b, c] = [await newSource(), await newSource(), await newSource()];
    const text = "Ban Santafe 2019 gia 680tr lh 0912345678";
    await ingestPosts(handle, undefined, a, [raw({ platformPostId: "9701", text, authorId: "u1" })]);
    await ingestPosts(handle, undefined, b, [raw({ platformPostId: "9702", text, authorId: "u1" })]);
    await ingestPosts(handle, undefined, c, [raw({ platformPostId: "9703", text, authorId: "u1" })]);
    await ingestPosts(handle, undefined, a, [raw({ platformPostId: "9704", text, authorId: "u2" })]);
    await ingestPosts(handle, undefined, b, [raw({ platformPostId: "9705", text: "Ban Santafe 2019 gia 680tr lh 0912345678 x", authorId: undefined, authorName: undefined })]);
    const [pa] = (await rowsOf(a)).filter((r) => r.authorId === "u1");
    const [pb] = await rowsOf(b);
    const [pc] = await rowsOf(c);
    const u2 = (await rowsOf(a)).find((r) => r.authorId === "u2")!;
    const anon = (await rowsOf(b)).find((r) => r.platformPostId === "9705")!;
    expect(pa!.repostKey).toBe(repostKey({ authorId: "u1", text }));
    expect(pb!.repostKey).toBe(pa!.repostKey);
    expect(pc!.repostKey).toBe(pa!.repostKey);
    expect(u2.repostKey).not.toBeNull();
    expect(u2.repostKey).not.toBe(pa!.repostKey);
    expect(anon.repostKey).toBeNull();
    await ingestPosts(handle, undefined, a, [raw({ platformPostId: "9701", text: `${text} - da giam gia`, authorId: "u1" })]);
    const [edited] = (await rowsOf(a)).filter((r) => r.platformPostId === "9701");
    expect(edited!.repostKey).toBe(repostKey({ authorId: "u1", text: `${text} - da giam gia` }));
    expect(edited!.repostKey).not.toBe(pa!.repostKey);
  });

  test("An api capture with structured is stored as capture api, raw.structured intact", async () => {
    const a = await newSource();
    const structured = { intent: "sell" as const, priceVnd: 175_000_000, attributes: { make: "Toyota", year: 2009 }, sellerType: "dealer" as const };
    const res = await ingestPosts(handle, undefined, a, [raw({ platformPostId: "6001", text: "Toyota Hiace 2009 may dau", capture: "api", structured })]);
    expect(res.accepted).toBe(1);
    const [row] = await rowsOf(a);
    expect(row!.capture).toBe("api");
    expect((row!.raw as { structured: unknown }).structured).toEqual(structured);
  });

  test("missing source throws", async () => {
    await expect(ingestPosts(handle, undefined, crypto.randomUUID(), [])).rejects.toThrow();
  });
});
