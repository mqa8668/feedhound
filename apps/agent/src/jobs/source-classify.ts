import { createLogger } from "@feedhound/core/logger";
import { classifySource, type ClassifyConfig, type ClassifyPost } from "@feedhound/core/source-classify";
import { schema, type DbHandle } from "@feedhound/db";
import { desc, eq, sql as dsql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";

const logger = createLogger({ service: "agent" });

const SOURCE_CLASSIFY_QUEUE = "source_classify";
const DEFAULT_CRON = "15 */6 * * *";
const DAY_MS = 24 * 60 * 60 * 1000;

interface ClassifyJobConfig extends ClassifyConfig {
  windowDays: number;
  topicDepth: number;
}

async function configValue(handle: DbHandle, key: string): Promise<unknown> {
  const [row] = await handle.db
    .select({ value: schema.config.value })
    .from(schema.config)
    .where(eq(schema.config.key, key))
    .orderBy(desc(schema.config.version))
    .limit(1);
  return row?.value;
}

async function loadConfig(handle: DbHandle): Promise<ClassifyJobConfig> {
  const num = async (key: string, fallback: number): Promise<number> => {
    const v = await configValue(handle, `sources.classify.${key}`);
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
  };
  return {
    minPosts: await num("minPosts", 20),
    windowDays: await num("windowDays", 30),
    topicDepth: await num("topicDepth", 2),
    topicShareMin: await num("topicShareMin", 0.5),
    regionMinPosts: await num("regionMinPosts", 10),
    regionShareMin: await num("regionShareMin", 0.6),
  };
}

export interface SourceClassifyOptions {
  now: Date;
  teamId?: string;
}

/**
 * Classifies every source (platform -> topic -> region) from its enriched posts. One grouped query per
 * team; upserts one `source_group` row per source (zero-post sources too). Writes `auto_*` and `classified_at`
 * only -- `override_*` belong to the operator and are never touched.
 */
export async function runSourceClassify(handle: DbHandle, opts: SourceClassifyOptions): Promise<{ teams: number; sources: number }> {
  const cfg = await loadConfig(handle);
  const categories = await handle.db.select({ id: schema.category.id, path: schema.category.path }).from(schema.category);
  const idByPath = new Map(categories.map((c) => [c.path, c.id]));
  const pathById = new Map(categories.map((c) => [c.id, c.path]));
  const lift = (id: string | null): string | null => {
    if (id === null) return null;
    const path = pathById.get(id);
    if (path === undefined) return null; // stale id (category deleted)
    return idByPath.get(path.split(".").slice(0, cfg.topicDepth).join(".")) ?? id;
  };

  const teamIds =
    opts.teamId !== undefined
      ? [opts.teamId]
      : (await handle.db.select({ id: schema.team.id }).from(schema.team)).map((t) => t.id);
  const since = new Date(opts.now.getTime() - cfg.windowDays * DAY_MS).toISOString();
  let total = 0;

  for (const teamId of teamIds) {
    const sources = await handle.db
      .select({ id: schema.source.id, defaults: schema.source.defaults })
      .from(schema.source)
      .where(eq(schema.source.teamId, teamId));
    if (sources.length === 0) continue;
    try {
    const rows = await handle.sql<{ source_id: string; category_id: string | null; region: string | null; n: string }[]>`
      select p.source_id::text as source_id, e.category_id::text as category_id, e.attributes->>'region' as region, count(*) as n
      from post p
      join source s on s.id = p.source_id
      join enrichment e on e.post_id = p.id
      where s.team_id = ${teamId}::uuid and p.first_seen_at >= ${since}::timestamptz
      group by 1, 2, 3`;
    const postsBySource = new Map<string, ClassifyPost[]>();
    for (const r of rows) {
      const topic = lift(r.category_id);
      const post: ClassifyPost = { topicCategoryId: topic, region: r.region, topicPath: topic ? (pathById.get(topic) ?? topic) : null };
      const arr = postsBySource.get(r.source_id) ?? [];
      for (let i = 0; i < Number(r.n); i++) arr.push(post);
      postsBySource.set(r.source_id, arr);
    }

    const values = sources.map((s) => {
      const d = s.defaults;
      // A default category that no longer exists (deleted) is skipped rather than written as a dangling FK.
      const defaults = {
        ...(typeof d.categoryId === "string" && lift(d.categoryId) !== null ? { categoryId: lift(d.categoryId)! } : {}),
        ...(typeof d.region === "string" ? { region: d.region } : {}),
      };
      const c = classifySource({ posts: postsBySource.get(s.id) ?? [], defaults, cfg });
      return {
        sourceId: s.id,
        autoTopicCategoryId: c.topicCategoryId,
        autoTopicMethod: c.topicMethod,
        autoTopicShare: c.topicShare,
        autoRegion: c.region,
        autoRegionMethod: c.regionMethod,
        autoRegionShare: c.regionShare,
        sampleN: c.sampleN,
        regionSampleN: c.regionSampleN,
        classifiedAt: opts.now,
      };
    });
    await handle.db
      .insert(schema.sourceGroup)
      .values(values)
      .onConflictDoUpdate({
        target: schema.sourceGroup.sourceId,
        set: {
          autoTopicCategoryId: dsql`excluded.auto_topic_category_id`,
          autoTopicMethod: dsql`excluded.auto_topic_method`,
          autoTopicShare: dsql`excluded.auto_topic_share`,
          autoRegion: dsql`excluded.auto_region`,
          autoRegionMethod: dsql`excluded.auto_region_method`,
          autoRegionShare: dsql`excluded.auto_region_share`,
          sampleN: dsql`excluded.sample_n`,
          regionSampleN: dsql`excluded.region_sample_n`,
          classifiedAt: dsql`excluded.classified_at`,
        },
      });
    total += values.length;
    } catch (err) {
      logger.error({ err, teamId }, "source_classify team failed");
    }
  }
  logger.info({ teams: teamIds.length, sources: total }, "source_classify run");
  return { teams: teamIds.length, sources: total };
}

export async function registerSourceClassifyJob(boss: PgBoss, handle: DbHandle): Promise<void> {
  await boss.createQueue(SOURCE_CLASSIFY_QUEUE);
  const cron = await configValue(handle, "sources.classify.cron");
  const tz = await configValue(handle, "app.tz");
  await boss.schedule(SOURCE_CLASSIFY_QUEUE, typeof cron === "string" ? cron : DEFAULT_CRON, null, {
    tz: typeof tz === "string" ? tz : "Asia/Ho_Chi_Minh",
  });
  await boss.work(SOURCE_CLASSIFY_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const data = (job.data ?? {}) as { teamId?: string };
      await runSourceClassify(handle, { now: new Date(), ...(typeof data.teamId === "string" ? { teamId: data.teamId } : {}) });
    }
  });
}
