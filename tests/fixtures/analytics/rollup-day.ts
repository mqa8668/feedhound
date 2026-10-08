// Fixture `rollup-day`: team T (2 sources, 2 categories, 10 posts over 3 hours of one local day) + team T2 (3 posts).
import { schema, type DbHandle } from "../../../packages/db/src/index";
import { createCategory, createTeam, insertPosts, type PostSeed } from "./flat-baseline";

/** Hours (UTC) of the fixture; 03:00Z = 10:00 in Asia/Ho_Chi_Minh, so all three share one local day. */
export const ROLLUP_DAY_HOURS = [
  new Date("2026-09-10T03:00:00Z"),
  new Date("2026-09-10T04:00:00Z"),
  new Date("2026-09-10T05:00:00Z"),
] as const;
export const ROLLUP_DAY_START = new Date("2026-09-09T17:00:00Z");

const counts = (c: Record<string, number>): Record<string, number> => c;

/** The expected T rows (dims keys other than metric/teamId; "" = no extra dims). */
export const ROLLUP_DAY_EXPECTED = {
  hour: [
    counts({ posts: 3, unique: 3, sell: 3, buy: 0, other: 0, enriched: 3, matched: 2, notified: 2 }),
    counts({ posts: 4, unique: 4, sell: 2, buy: 2, other: 0, enriched: 4, matched: 1, notified: 0 }),
    counts({ posts: 3, unique: 2, sell: 0, buy: 0, other: 3, enriched: 1, matched: 0, notified: 0 }),
  ],
  day: counts({ posts: 10, unique: 9, sell: 5, buy: 2, other: 3, enriched: 8, matched: 3, notified: 2 }),
  author: { posts: 4, sell: 4, name: "Shop Alpha" },
} as const;

export interface RollupDayFixture {
  teamId: string;
  otherTeamId: string;
  sourceIds: string[];
  categoryIds: string[];
  authorKey: string;
}

export async function seedRollupDay(handle: DbHandle): Promise<RollupDayFixture> {
  const t = await createTeam(handle, "rd-t", 2);
  const t2 = await createTeam(handle, "rd-t2", 1);
  const [c1, c2] = [await createCategory(handle, "RD cat 1"), await createCategory(handle, "RD cat 2")] as [string, string];
  const [a, b] = t.sourceIds as [string, string];
  const [h0, h1, h2] = ROLLUP_DAY_HOURS;
  const at = (h: Date, i: number): Date => new Date(h.getTime() + i * 60_000);
  const alpha = { authorName: "Shop Alpha" }; // no authorId on purpose
  const seeds: PostSeed[] = [
    { sourceId: a, text: "iphone 13 cũ", firstSeenAt: at(h0, 1), ...alpha }, // p1
    { sourceId: a, text: "iphone 14 cũ", firstSeenAt: at(h0, 2), ...alpha }, // p2
    { sourceId: a, text: "iphone 12 cũ", firstSeenAt: at(h0, 3), ...alpha }, // p3
    { sourceId: a, text: "iphone 11 cũ", firstSeenAt: at(h1, 1), ...alpha }, // p4
    { sourceId: a, text: "cần mua ipad", firstSeenAt: at(h1, 2), authorId: "u5" }, // p5
    { sourceId: a, text: "cần mua macbook", firstSeenAt: at(h1, 3), authorId: "u6" }, // p6
    { sourceId: b, text: "bán macbook m1", firstSeenAt: at(h1, 4), authorId: "u7" }, // p7
    { sourceId: b, text: "tin chung", firstSeenAt: at(h2, 1), authorId: "u8" }, // p8
    { sourceId: b, text: "quảng cáo lặp", firstSeenAt: at(h2, 2), authorId: "u9", fingerprint: "fp-dup" }, // p9
    { sourceId: b, text: "quảng cáo lặp", firstSeenAt: at(h2, 3), authorId: "u9", fingerprint: "fp-dup" }, // p10
  ];
  const ids = await insertPosts(handle, seeds);
  const intents: [string, string][] = [
    ["sell", c1], ["sell", c1], ["sell", c1], ["sell", c1],
    ["buy", c1], ["buy", c2], ["sell", c2], ["other", c2],
  ];
  await handle.db.insert(schema.enrichment).values(
    intents.map(([intent, categoryId], i) => ({ postId: ids[i]!, intent, categoryId, priceVnd: intent === "sell" ? 10_000_000 + i * 1_000_000 : null })),
  );
  const [w] = await handle.db.insert(schema.watch).values({ userId: t.userId, name: "rd-watch" }).returning({ id: schema.watch.id });
  const matched = [0, 1, 4]; // p1 (sent), p2 (merged), p5 (failed -> matched but not notified)
  const statuses = ["sent", "merged", "failed"];
  for (const [k, idx] of matched.entries()) {
    const [m] = await handle.db.insert(schema.match).values({ postId: ids[idx]!, watchId: w!.id, score: 1 }).returning({ id: schema.match.id });
    await handle.db.insert(schema.notification).values({ matchId: m!.id, userId: t.userId, channel: "telegram", status: statuses[k]! });
  }
  const other = await insertPosts(handle, [0, 1, 2].map((i) => ({ sourceId: t2.sourceIds[0]!, text: `t2 post ${i}`, firstSeenAt: at(h0, 10 + i), authorName: "Other Team" })));
  await handle.db.insert(schema.enrichment).values(other.map((postId) => ({ postId, intent: "sell", categoryId: c1 })));
  return { teamId: t.teamId, otherTeamId: t2.teamId, sourceIds: t.sourceIds, categoryIds: [c1, c2], authorKey: "name:shop alpha" };
}
