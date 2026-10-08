// Source library -- platform -> topic -> region tree, per-source override, reclassify trigger.
import { resolveAllSchemas } from "@feedhound/core/attributes";
import { buildTree, sourceHealth, type SourceLeaf, type SourceTreeResponse } from "@feedhound/core/source-classify";
import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { resolveSession, type Session } from "../middleware/cf-access";
import { computeSlo } from "../services/slo";
import { loadRelevance7d } from "./sources";

const SOURCE_CLASSIFY_QUEUE = "source_classify";
const RECLASSIFY_DEBOUNCE_SECONDS = 300;

export interface SourceGroupsBoss {
  send(name: string, data: object, opts?: Record<string, unknown>): Promise<string | null>;
}

/** Debounced `source_classify` job for a team (reused by hunt add). */
export async function enqueueSourceClassify(boss: SourceGroupsBoss, teamId: string): Promise<void> {
  await boss.send(SOURCE_CLASSIFY_QUEUE, { teamId }, {
    singletonKey: `${SOURCE_CLASSIFY_QUEUE}:${teamId}`,
    // singletonKey alone is only enforced with singletonSeconds on a default-policy queue (pg-boss 12).
    singletonSeconds: RECLASSIFY_DEBOUNCE_SECONDS,
  });
}

const overrideSchema = z.object({
  topicCategoryId: z.string().uuid().nullable().optional(),
  region: z.string().min(1).max(64).nullable().optional(),
});

function titleize(value: string): string {
  return value
    .split("_")
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

interface Catalogue {
  categories: Map<string, { name: string }>;
  regions: Map<string, string>;
}

/** Category names plus every province declared by a `region` enum attribute (026), with its label. */
async function loadCatalogue(handle: DbHandle): Promise<Catalogue> {
  const rows = await handle.db
    .select({ id: schema.category.id, path: schema.category.path, name: schema.category.name, attributeSchema: schema.category.attributeSchema })
    .from(schema.category);
  const regions = new Map<string, string>();
  for (const defs of resolveAllSchemas(rows).values()) {
    for (const d of defs) {
      if (d.key !== "region" || d.kind !== "enum") continue;
      for (const v of d.values) if (!regions.has(v)) regions.set(v, titleize(v));
      for (const a of d.aliases ?? []) if (a.label) regions.set(a.value, a.label);
    }
  }
  return { categories: new Map(rows.map((r) => [r.id, { name: r.name }])), regions };
}

/** `sources.classify.minPosts` (latest config version), falling back to the shipped default. */
async function loadMinPosts(handle: DbHandle): Promise<number> {
  const [row] = await handle.db
    .select({ value: schema.config.value })
    .from(schema.config)
    .where(eq(schema.config.key, "sources.classify.minPosts"))
    .orderBy(desc(schema.config.version))
    .limit(1);
  return typeof row?.value === "number" && Number.isFinite(row.value) ? row.value : 20;
}

/** One query set for the team's sources (all, or `onlyIds`): SLO ledger figures, 028 relevance, source_group rows. */
async function loadLeaves(handle: DbHandle, teamId: string, now: Date, onlyIds?: string[]): Promise<SourceLeaf[]> {
  const sources = await handle.db
    .select()
    .from(schema.source)
    .where(onlyIds ? and(eq(schema.source.teamId, teamId), inArray(schema.source.id, onlyIds)) : eq(schema.source.teamId, teamId));
  if (sources.length === 0) return [];
  const ids = sources.map((s) => s.id);
  const [slo, relevance, groups, cat] = await Promise.all([
    computeSlo(handle, { now, teamId, sourceIds: ids }),
    loadRelevance7d(handle, ids),
    handle.db.select().from(schema.sourceGroup).where(inArray(schema.sourceGroup.sourceId, ids)),
    loadCatalogue(handle),
  ]);
  const sloById = new Map(slo.map((s) => [s.sourceId, s]));
  const groupById = new Map(groups.map((g) => [g.sourceId, g]));
  const regionLabel = (key: string) => cat.regions.get(key) ?? titleize(key);

  return sources.map((s): SourceLeaf => {
    const sl = sloById.get(s.id);
    const g = groupById.get(s.id);
    const stored = typeof s.health === "object" && s.health !== null ? (s.health as Record<string, unknown>) : {};
    const healthOk = typeof stored.ok === "boolean" ? stored.ok : stored.reason ? false : null;
    const coverageOk = sl?.coverageOkRatio ?? null;

    let topic: SourceLeaf["topic"];
    if (g?.overrideTopicCategoryId) {
      const id = g.overrideTopicCategoryId;
      topic = { key: id, categoryId: id, label: cat.categories.get(id)?.name ?? "Unknown", method: "override", share: null };
    } else if (g?.autoTopicCategoryId && (g.autoTopicMethod === "auto" || g.autoTopicMethod === "default")) {
      const id = g.autoTopicCategoryId;
      topic = { key: id, categoryId: id, label: cat.categories.get(id)?.name ?? "Unknown", method: g.autoTopicMethod, share: g.autoTopicShare };
    } else if (g?.autoTopicMethod === "mixed") {
      topic = { key: "mixed", categoryId: null, label: "Mixed", method: "mixed", share: null };
    } else {
      topic = { key: "unclassified", categoryId: null, label: "Unclassified", method: "insufficient", share: null };
    }

    let region: SourceLeaf["region"];
    if (g?.overrideRegion) {
      region = { key: g.overrideRegion, label: regionLabel(g.overrideRegion), method: "override", share: null };
    } else if (g?.autoRegion && (g.autoRegionMethod === "auto" || g.autoRegionMethod === "default")) {
      region = { key: g.autoRegion, label: regionLabel(g.autoRegion), method: g.autoRegionMethod, share: g.autoRegionShare };
    } else {
      region = { key: "any", label: "Any region", method: "none", share: null };
    }

    return {
      id: s.id,
      name: s.name,
      url: s.url,
      kind: s.kind,
      status: s.status,
      health: sourceHealth({ status: s.status, healthOk, coverageOk, healthAgeSec: s.lastHealthAt ? (now.getTime() - s.lastHealthAt.getTime()) / 1000 : null }),
      coverageOk,
      coverageComplete: sl?.coverageCompleteRatio ?? null,
      secondsSinceOkVisit: sl?.secondsSinceOkVisit ?? null,
      relevance7d: relevance.get(s.id) ?? { posts: 0, matched: 0, share: null },
      topic,
      region,
      sampleN: g?.sampleN ?? 0,
      classifiedAt: g?.classifiedAt ? g.classifiedAt.toISOString() : null,
      override: { topicCategoryId: g?.overrideTopicCategoryId ?? null, region: g?.overrideRegion ?? null },
    };
  });
}

export function sourceGroupsRoute(handle: DbHandle, boss?: SourceGroupsBoss): Hono<{ Variables: { session: Session } }> {
  const app = new Hono<{ Variables: { session: Session } }>();

  async function auth(c: { req: { raw: { headers: Headers } } }, operator: boolean): Promise<Session | Response> {
    const session = await resolveSession(c.req.raw.headers, handle);
    if (session === "not_provisioned") return Response.json({ error: "not_provisioned", message: "Ask an operator to add you" }, { status: 403 });
    if (!session) return Response.json({ error: "unauthenticated", message: "missing or invalid credentials" }, { status: 401 });
    if (operator && session.role !== "operator") return Response.json({ error: "forbidden" }, { status: 403 });
    return session;
  }

  app.get("/api/source-groups/tree", async (c) => {
    const session = await auth(c, false);
    if (session instanceof Response) return session;
    const now = new Date();
    const [leaves, cat, minPosts] = await Promise.all([loadLeaves(handle, session.teamId, now), loadCatalogue(handle), loadMinPosts(handle)]);
    const tree: SourceTreeResponse = { ...buildTree(leaves, now.toISOString()), minPosts, regionOptions: [...cat.regions.keys()].sort() };
    return c.json(tree);
  });

  app.put("/api/source-groups/:sourceId/override", async (c) => {
    const session = await auth(c, true);
    if (session instanceof Response) return session;
    const sourceId = c.req.param("sourceId");
    const body = overrideSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "validation" }, 400);
    if (!z.string().uuid().safeParse(sourceId).success) return c.json({ error: "not_found" }, 404);
    const [src] = await handle.db
      .select({ id: schema.source.id })
      .from(schema.source)
      .where(and(eq(schema.source.id, sourceId), eq(schema.source.teamId, session.teamId)))
      .limit(1);
    if (!src) return c.json({ error: "not_found" }, 404);

    const { topicCategoryId, region } = body.data;
    const cat = await loadCatalogue(handle);
    if (topicCategoryId && !cat.categories.has(topicCategoryId)) return c.json({ error: "validation", field: "topicCategoryId" }, 422);
    if (region && !cat.regions.has(region)) return c.json({ error: "validation", field: "region" }, 422);

    const set: Partial<typeof schema.sourceGroup.$inferInsert> = { overriddenBy: session.userId, overriddenAt: new Date() };
    if (topicCategoryId !== undefined) set.overrideTopicCategoryId = topicCategoryId;
    if (region !== undefined) set.overrideRegion = region;
    await handle.db
      .insert(schema.sourceGroup)
      .values({ sourceId, autoTopicMethod: "insufficient", autoRegionMethod: "none", ...set })
      .onConflictDoUpdate({ target: schema.sourceGroup.sourceId, set });
    const [leaf] = await loadLeaves(handle, session.teamId, new Date(), [sourceId]);
    return c.json(leaf);
  });

  app.delete("/api/source-groups/:sourceId/override", async (c) => {
    const session = await auth(c, true);
    if (session instanceof Response) return session;
    const sourceId = c.req.param("sourceId");
    if (!z.string().uuid().safeParse(sourceId).success) return c.json({ error: "not_found" }, 404);
    const [src] = await handle.db
      .select({ id: schema.source.id })
      .from(schema.source)
      .where(and(eq(schema.source.id, sourceId), eq(schema.source.teamId, session.teamId)))
      .limit(1);
    if (!src) return c.json({ error: "not_found" }, 404);
    await handle.db
      .update(schema.sourceGroup)
      .set({ overrideTopicCategoryId: null, overrideRegion: null, overriddenBy: null, overriddenAt: null })
      .where(eq(schema.sourceGroup.sourceId, sourceId));
    return c.body(null, 204);
  });

  app.post("/api/source-groups/reclassify", async (c) => {
    const session = await auth(c, true);
    if (session instanceof Response) return session;
    if (!boss) return c.json({ error: "unavailable", message: "job queue not configured" }, 503);
    await enqueueSourceClassify(boss, session.teamId);
    return c.body(null, 202);
  });

  return app;
}
