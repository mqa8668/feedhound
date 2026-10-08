// Fixtures: shared helpers + `flat-baseline` (7 d x 24 h, 20 posts/h, no "airpods").
import { schema, type DbHandle } from "../../../packages/db/src/index";

export const HOUR_MS = 3_600_000;
const CHUNK = 1000;

export interface TeamFixture {
  teamId: string;
  userId: string;
  sourceIds: string[];
}

/** One team, one operator user and `sources` sources. Names carry a random suffix so reruns never collide. */
export async function createTeam(handle: DbHandle, label: string, sources = 1): Promise<TeamFixture> {
  const tag = crypto.randomUUID().slice(0, 8);
  const [team] = await handle.db.insert(schema.team).values({ name: `${label}-${tag}` }).returning({ id: schema.team.id });
  const [user] = await handle.db
    .insert(schema.user)
    .values({ teamId: team!.id, email: `${label}-${tag}@example.com`, role: "operator" })
    .returning({ id: schema.user.id });
  const sourceIds: string[] = [];
  for (let i = 0; i < sources; i++) {
    const [s] = await handle.db
      .insert(schema.source)
      .values({ teamId: team!.id, kind: "web", platformId: `${label}-${tag}-${i}`, name: `${label} source ${i}`, url: `https://example.com/${tag}/${i}` })
      .returning({ id: schema.source.id });
    sourceIds.push(s!.id);
  }
  return { teamId: team!.id, userId: user!.id, sourceIds };
}

export async function createCategory(handle: DbHandle, name: string): Promise<string> {
  const tag = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const [c] = await handle.db.insert(schema.category).values({ slug: `a007-${tag}`, name, path: `a007_${tag}` }).returning({ id: schema.category.id });
  return c!.id;
}

export interface PostSeed {
  sourceId: string;
  text: string;
  firstSeenAt: Date;
  authorName?: string;
  authorId?: string;
  fingerprint?: string;
}

/** Inserts posts in chunks and returns their ids in input order. */
export async function insertPosts(handle: DbHandle, posts: readonly PostSeed[]): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < posts.length; i += CHUNK) {
    const rows = await handle.db
      .insert(schema.post)
      .values(
        posts.slice(i, i + CHUNK).map((p) => ({
          sourceId: p.sourceId,
          platformPostId: crypto.randomUUID(),
          url: "https://example.com/p",
          text: p.text,
          textNormalized: p.text.toLowerCase(),
          firstSeenAt: p.firstSeenAt,
          authorName: p.authorName ?? null,
          authorId: p.authorId ?? null,
          fingerprint: p.fingerprint ?? null,
        })),
      )
      .returning({ id: schema.post.id });
    ids.push(...rows.map((r) => r.id));
  }
  return ids;
}

/** Removes every row a fixture team (and its categories) can own. */
export async function cleanupTeams(handle: DbHandle, teamIds: readonly string[], categoryIds: readonly string[] = []): Promise<void> {
  if (teamIds.length === 0) return;
  const t = [...teamIds];
  const { sql } = handle;
  await sql`delete from metric_rollup where dims->>'teamId' in ${sql(t)}`;
  await sql`delete from trend_term where team_id in ${sql(t)}`;
  await sql`delete from notification where user_id in (select id from "user" where team_id in ${sql(t)})`;
  await sql`delete from match where post_id in (select p.id from post p join source s on s.id = p.source_id where s.team_id in ${sql(t)})`;
  await sql`delete from enrichment where post_id in (select p.id from post p join source s on s.id = p.source_id where s.team_id in ${sql(t)})`;
  await sql`delete from post where source_id in (select id from source where team_id in ${sql(t)})`;
  await sql`delete from watch where user_id in (select id from "user" where team_id in ${sql(t)})`;
  await sql`delete from source where team_id in ${sql(t)}`;
  await sql`delete from "user" where team_id in ${sql(t)}`;
  await sql`delete from team where id in ${sql(t)}`;
  if (categoryIds.length > 0) await sql`delete from category where id in ${sql([...categoryIds])}`;
}

const PHRASES = ["iphone cũ pin tốt", "macbook air m1 đẹp", "samsung galaxy fullbox", "ipad gen 9 trầy nhẹ", "sony tai nghe chống ồn"];

/** 168 hours ending at (excluding) `endHour`, 20 posts/h; every phrase term lands 4x per hour. */
export async function seedFlatBaseline(handle: DbHandle, sourceId: string, endHour: Date): Promise<Date[]> {
  const hours: Date[] = [];
  const posts: PostSeed[] = [];
  for (let h = 168; h >= 1; h--) {
    const hour = new Date(endHour.getTime() - h * HOUR_MS);
    hours.push(hour);
    for (let i = 0; i < 20; i++) {
      posts.push({ sourceId, text: PHRASES[i % PHRASES.length]!, firstSeenAt: new Date(hour.getTime() + i * 60_000) });
    }
  }
  await insertPosts(handle, posts);
  return hours;
}
