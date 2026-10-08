import { canonValue, resolveAllSchemas } from "@feedhound/core/attributes";
import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
// Relative on purpose: @feedhound/agent already depends on @feedhound/api, so a package dep would be a cycle.
import { feedConnector, previewFeed } from "../../../agent/src/web/connectors/feed";
import type { WebHttp } from "../../../agent/src/web/types";
import { authenticateApiKey, type ApiKeyContext } from "../middleware/api-key";
import { resolveSession, type Session } from "../middleware/cf-access";

// A source url must be an http(s) url. Hosts are not restricted here: the server-side fetcher applies its own host
// allow-list, robots.txt and SSRF rules when it polls.
const sourceUrlSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((url) => /^https?:\/\/[^\s/]+/i.test(url), { message: "url must be an http(s) URL" });

// Session "add by URL": kind/platformId are derived from the URL rather than supplied by the client.
const sessionSourceUrlSchema = sourceUrlSchema;

// Default attribute values (and `categoryId`) applied to this source's posts at enrich time.
const defaultsSchema = z
  .record(z.string().max(40), z.union([z.string().max(40), z.number()]))
  .refine((o) => Object.keys(o).length <= 10, { message: "at most 10 defaults" })
  .optional();

const createSourceSchema = z.object({
  kind: z.string().min(1),
  platformId: z.string().min(1),
  name: z.string().min(1),
  url: sourceUrlSchema,
  schedule: z.record(z.string(), z.unknown()).optional(),
  assignedKeyId: z.string().uuid().nullable().optional(),
  defaults: defaultsSchema,
});

const patchSourceSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).optional(),
  // Checked after the row is loaded (web rows keep their own url).
  url: z.string().min(1).optional(),
  status: z.enum(["active", "paused"]).optional(),
  schedule: z.record(z.string(), z.unknown()).optional(),
  assignedKeyId: z.string().uuid().nullable().optional(),
  defaults: defaultsSchema,
});

const sessionCreateSourceSchema = z.object({
  url: sessionSourceUrlSchema,
  name: z.string().min(1).optional(),
  assignedKeyId: z.string().uuid().nullable().optional(),
  schedule: z.record(z.string(), z.unknown()).optional(),
  defaults: defaultsSchema,
});

const sessionPatchSourceSchema = z.object({
  name: z.string().min(1).optional(),
  assignedKeyId: z.string().uuid().nullable().optional(),
  schedule: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(["active", "paused"]).optional(),
  defaults: defaultsSchema,
});

type DefaultsCheck = { ok: true; defaults: Record<string, string | number> } | { ok: false; error: { field: string; reason: string } };

/**
 * Each key must exist in some category's resolved schema and its value must canon-validate against one such def
 * (stored canonical); `categoryId` must name an existing category.
 */
async function validateSourceDefaults(handle: DbHandle, input: Record<string, string | number>): Promise<DefaultsCheck> {
  const rows = await handle.db.select({ id: schema.category.id, path: schema.category.path, attributeSchema: schema.category.attributeSchema }).from(schema.category);
  const resolved = resolveAllSchemas(rows);
  const out: Record<string, string | number> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (key === "categoryId") {
      if (typeof raw !== "string" || !rows.some((r) => r.id === raw)) return { ok: false, error: { field: "defaults.categoryId", reason: "no such category" } };
      out[key] = raw;
      continue;
    }
    const defs = [...resolved.values()].flatMap((s) => s.filter((d) => d.key === key));
    if (defs.length === 0) return { ok: false, error: { field: `defaults.${key}`, reason: `unknown attribute "${key}"` } };
    let canon: string | number | undefined;
    for (const d of defs) {
      canon = canonValue(d, raw);
      if (canon !== undefined) break;
    }
    if (canon === undefined) return { ok: false, error: { field: `defaults.${key}`, reason: `invalid value ${JSON.stringify(raw)}` } };
    out[key] = canon;
  }
  return { ok: true, defaults: out };
}

interface Caller {
  teamId: string;
  role: string;
}

/** Team + role of the user who owns the calling api key (code-review finding #7). */
async function loadCaller(handle: DbHandle, apiKey: ApiKeyContext): Promise<Caller | undefined> {
  const [row] = await handle.db
    .select({ teamId: schema.user.teamId, role: schema.user.role })
    .from(schema.user)
    .where(eq(schema.user.id, apiKey.userId))
    .limit(1);
  return row;
}

/**
 * `true` if api key `keyId` belongs to a user on team `teamId`, is not
 * revoked, and holds the `ingest` scope (a revoked or
 * non-ingest key must not stay assignable, matching the key picker the
 * dashboard shows -- otherwise a source keeps pointing at a key that will
 * 403 every ingest forever while the UI still shows it as valid).
 */
async function isKeyInTeam(handle: DbHandle, keyId: string, teamId: string): Promise<boolean> {
  const [row] = await handle.db
    .select({ id: schema.apiKey.id, scopes: schema.apiKey.scopes })
    .from(schema.apiKey)
    .innerJoin(schema.user, eq(schema.apiKey.userId, schema.user.id))
    .where(
      and(
        eq(schema.apiKey.id, keyId),
        eq(schema.user.teamId, teamId),
        isNull(schema.apiKey.revokedAt),
      ),
    )
    .limit(1);
  return row !== undefined && row.scopes.includes("ingest");
}

export type SessionSourceInput = z.infer<typeof sessionCreateSourceSchema>;

export type CreateSessionSourceResult =
  | { status: 201; body: typeof schema.source.$inferSelect & { preview: FeedPreviewItem[] } }
  | { status: 400 | 409 | 422; body: Record<string, unknown> };

const PREVIEW_ITEMS = 5;

type FeedPreviewItem = { title: string; url: string; postedAt: string | null };

/** `web.allowPrivateHosts` from the Config table (latest version), false when unset or invalid. */
async function readAllowPrivateHosts(handle: DbHandle): Promise<boolean> {
  const [row] = await handle.db
    .select({ value: schema.config.value })
    .from(schema.config)
    .where(eq(schema.config.key, "web.allowPrivateHosts"))
    .orderBy(desc(schema.config.version))
    .limit(1);
  return row?.value === true;
}

type FeedCheck =
  | { ok: true; platformId: string; url: string; title: string; items: FeedPreviewItem[] }
  | { ok: false; message: string };

/** Normalise the url through the feed connector and fetch it once; shared by preview and create. */
async function checkFeed(handle: DbHandle, rawUrl: string, http: WebHttp | undefined): Promise<FeedCheck> {
  const parsed = feedConnector.parseSourceUrl(rawUrl.trim());
  if (!parsed.ok) return { ok: false, message: parsed.reason };
  const preview = await previewFeed(parsed.url, http, { allowPrivateHosts: await readAllowPrivateHosts(handle) });
  if (!preview.ok) return { ok: false, message: preview.reason };
  return { ok: true, platformId: parsed.platformId, url: parsed.url, title: preview.title, items: preview.items.slice(0, PREVIEW_ITEMS) };
}

/**
 * Session "add by feed URL": the url must parse as an RSS/Atom/JSON feed when fetched once.
 * The caller has already checked the operator role and parsed `input`.
 */
export async function createSessionSource(handle: DbHandle, teamId: string, input: SessionSourceInput, http?: WebHttp): Promise<CreateSessionSourceResult> {
  const parsed = feedConnector.parseSourceUrl(input.url.trim());
  if (!parsed.ok) return { status: 422, body: { error: "invalid_feed", message: parsed.reason } };
  const [duplicate] = await handle.db
    .select({ id: schema.source.id })
    .from(schema.source)
    .where(and(eq(schema.source.teamId, teamId), eq(schema.source.kind, "web"), eq(schema.source.platformId, parsed.platformId)))
    .limit(1);
  if (duplicate) return { status: 409, body: { error: "conflict", message: "this feed has already been added" } };

  if (input.assignedKeyId && !(await isKeyInTeam(handle, input.assignedKeyId, teamId))) {
    return { status: 400, body: { error: "validation", message: "assignedKeyId must belong to a key on the same team" } };
  }

  const dv = input.defaults === undefined ? undefined : await validateSourceDefaults(handle, input.defaults);
  if (dv && !dv.ok) return { status: 422, body: dv.error };

  const feed = await checkFeed(handle, input.url, http);
  if (!feed.ok) return { status: 422, body: { error: "invalid_feed", message: feed.message } };

  // lastOkVisitAt stays null, so the web_poll job treats the new source as due on its next run.
  const [row] = await handle.db
    .insert(schema.source)
    .values({
      teamId,
      kind: "web",
      platformId: feed.platformId,
      name: input.name ?? (feed.title.trim() || feed.url),
      url: feed.url,
      schedule: input.schedule ?? {},
      assignedKeyId: input.assignedKeyId ?? null,
      defaults: dv?.ok ? dv.defaults : {},
    })
    .returning();
  if (!row) throw new Error("source insert returned no row");
  return { status: 201, body: { ...row, preview: feed.items } };
}

/**
 * Resolves the caller of a `/api/sources*` request for routes that must
 * accept either a dashboard session or an api key on
 * the same path. Tries session credentials first; falls back to a bearer
 * api key with `requiredScopes`.
 */
async function resolveActor(
  c: { req: { raw: { headers: Headers } } },
  handle: DbHandle,
  requiredScopes: string[],
  authHeader: string | undefined,
): Promise<{ kind: "session"; session: Session } | { kind: "apiKey"; apiKey: ApiKeyContext } | { error: string; status: 401 | 403 }> {
  const session = await resolveSession(c.req.raw.headers, handle);
  if (session === "not_provisioned") return { error: "not_provisioned", status: 403 };
  if (session) return { kind: "session", session };

  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : undefined;
  const result = await authenticateApiKey(token, requiredScopes, handle);
  if (!result.ok) return { error: result.message, status: result.status };
  return { kind: "apiKey", apiKey: result.context };
}

/** Posts first seen in the last 7 days per source, and how many have at least one match. Shared with the source tree. */
export async function loadRelevance7d(
  handle: DbHandle,
  sourceIds: string[],
): Promise<Map<string, { posts: number; matched: number; share: number | null }>> {
  const relevanceRows =
    sourceIds.length === 0
      ? []
      : await handle.sql<{ source_id: string; posts: string; matched: string }[]>`
          select p.source_id::text as source_id, count(*) as posts,
                 count(*) filter (where exists (select 1 from match m where m.post_id = p.id)) as matched
          from post p
          where p.source_id = any(${sourceIds}::uuid[])
            and p.first_seen_at > now() - interval '7 days'
          group by p.source_id`;
  return new Map(
    relevanceRows.map((r) => {
      const posts = Number(r.posts);
      const matched = Number(r.matched);
      return [r.source_id, { posts, matched, share: posts > 0 ? matched / posts : null }] as const;
    }),
  );
}

/**
 * `/api/sources` CRUD. `GET/POST/PATCH /api/sources` accept either a
 * dashboard session or an api key (scoped to sources:read/write);
 * `PATCH /:id`, `/:id/pause` and `/:id/resume` are session-only, operator-role additions.
 */
export function sourcesRoute(handle: DbHandle, opts: { http?: WebHttp } = {}): Hono<{ Variables: { apiKey: ApiKeyContext; session: Session } }> {
  const app = new Hono<{ Variables: { apiKey: ApiKeyContext; session: Session } }>();

/**
 * `/api/sources` used to return the `health` jsonb column verbatim -- just
 * `{ok, reason}` -- while the dashboard's SourceHealthDto declares
 * `{lastVisitAt, reason, pausedAt}` plus `postsLastHour`. Nothing caught it:
 * the type asserted fields the response never carried, so `lastVisitAt` and
 * `postsLastHour` were `undefined` at runtime and every source rendered
 * "- / 0/h" on the Overview panel and in the Sources table, however many
 * posts it had actually ingested. Build the declared shape here, from the
 * same columns `/api/ops/health` already uses.
 */
async function withHealth(handle: DbHandle, rows: (typeof schema.source.$inferSelect)[]) {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const counts =
    rows.length === 0
      ? []
      : await handle.db
          .select({ sourceId: schema.post.sourceId, count: sql<string>`count(*)` })
          .from(schema.post)
          .where(
            and(
              inArray(
                schema.post.sourceId,
                rows.map((r) => r.id),
              ),
              gte(schema.post.firstSeenAt, since),
            ),
          )
          .groupBy(schema.post.sourceId);
  const bySource = new Map(counts.map((r) => [r.sourceId, Number(r.count)]));

  // CoveragePct = round(100 * min(1, sum(visits_ok) /
  // sum(visits_expected))) over `metric_rollup` coverage rows from the last
  // 24h, one grouped query for every source on this page. `null` when a
  // source has no rows or sum(expected) = 0 (never divide by zero).
  const truncatedNow = new Date();
  truncatedNow.setUTCMinutes(0, 0, 0);
  const coverageWindowStart = new Date(truncatedNow.getTime() - 23 * 60 * 60 * 1000);
  const sourceIds = rows.map((r) => r.id);
  const coverageRows =
    sourceIds.length === 0
      ? []
      : await handle.sql<{ source_id: string; expected: string; ok: string }[]>`
          select
            dims->>'sourceId' as source_id,
            sum((counts->>'visits_expected')::numeric) as expected,
            sum((counts->>'visits_ok')::numeric) as ok
          from metric_rollup
          where bucket = 'hour'
            and ts >= ${coverageWindowStart.toISOString()}::timestamptz
            and dims->>'metric' = 'coverage'
            and dims->>'sourceId' = any(${sourceIds})
          group by dims->>'sourceId'
        `;
  const coverageBySource = new Map(
    coverageRows.map((r) => {
      const expected = Number(r.expected);
      const ok = Number(r.ok);
      const pct = expected > 0 ? Math.round(100 * Math.min(1, ok / expected)) : null;
      return [r.source_id, pct];
    }),
  );

  const relevanceBySource = await loadRelevance7d(handle, sourceIds);

  return rows.map((r) => {
    const stored = typeof r.health === "object" && r.health !== null ? (r.health as Record<string, unknown>) : {};
    // A source that was never polled
    // has an empty/ok-less health with no reason — that is "unknown", not
    // "degraded", so report `ok: null` and let the dashboard render its neutral
    // "Not visited yet" state. A boolean `ok` still wins; an ok-less health
    // WITH a reason stays `false` (a recorded reason implies something failed).
    const ok = typeof stored.ok === "boolean" ? stored.ok : stored.reason ? false : null;
    return {
      ...r,
      relevance7d: relevanceBySource.get(r.id) ?? { posts: 0, matched: 0, share: null },
      health: {
        ok,
        reason: (stored.reason as string | null) ?? null,
        pausedAt: (stored.pausedAt as string | null) ?? null,
        lastVisitAt: r.lastIngestAt ?? r.lastHealthAt ?? null,
        postsLastHour: bySource.get(r.id) ?? 0,
                lastOkVisitAt: r.lastOkVisitAt ? r.lastOkVisitAt.toISOString() : null,
        coveragePct: coverageBySource.get(r.id) ?? null,
      },
    };
  });
}

  app.get("/api/sources", async (c) => {
    const actor = await resolveActor(c, handle, ["sources:read"], c.req.header("Authorization"));
    if ("error" in actor) return c.json({ error: actor.error }, actor.status);

    if (actor.kind === "session") {
      const rows = await handle.db.select().from(schema.source).where(eq(schema.source.teamId, actor.session.teamId));
      return c.json({ sources: await withHealth(handle, rows) });
    }

    if (actor.apiKey.sourceIds.length === 0) return c.json({ sources: [] });
    const rows = await handle.db.select().from(schema.source).where(inArray(schema.source.id, actor.apiKey.sourceIds));
    return c.json({ sources: await withHealth(handle, rows) });
  });

  // Preview a feed url without inserting anything (dashboard "Preview" button).
  app.post("/api/sources/preview", async (c) => {
    const session = await requireOperatorSession(c);
    if (session instanceof Response) return session;
    const json: unknown = await c.req.json().catch(() => undefined);
    const parsed = z.object({ url: sourceUrlSchema }).safeParse(json);
    if (!parsed.success) return c.json({ error: "validation", message: "invalid body", issues: parsed.error.issues }, 400);
    const feed = await checkFeed(handle, parsed.data.url, opts.http);
    if (!feed.ok) return c.json({ error: "invalid_feed", message: feed.message }, 422);
    return c.json({ title: feed.title, url: feed.url, platformId: feed.platformId, items: feed.items });
  });

  app.post("/api/sources", async (c) => {
    const actor = await resolveActor(c, handle, ["sources:write"], c.req.header("Authorization"));
    if ("error" in actor) return c.json({ error: actor.error }, actor.status);

    if (actor.kind === "session") {
      if (actor.session.role !== "operator") return c.json({ error: "forbidden", message: "operator role required" }, 403);
      const json: unknown = await c.req.json().catch(() => undefined);
      const parsed = sessionCreateSourceSchema.safeParse(json);
      if (!parsed.success) return c.json({ error: "validation", message: "invalid body", issues: parsed.error.issues }, 400);

      const created = await createSessionSource(handle, actor.session.teamId, parsed.data, opts.http);
      return c.json(created.body, created.status);
    }

    const json: unknown = await c.req.json().catch(() => undefined);
    const parsed = createSourceSchema.safeParse(json);
    if (!parsed.success) return c.json({ error: "invalid body" }, 400);

    const caller = await loadCaller(handle, actor.apiKey);
    if (!caller || caller.role !== "operator") return c.json({ error: "operator role required" }, 403);

    if (parsed.data.assignedKeyId && !(await isKeyInTeam(handle, parsed.data.assignedKeyId, caller.teamId))) {
      return c.json({ error: "assignedKeyId must belong to a key on the same team" }, 400);
    }

    const dv = parsed.data.defaults === undefined ? undefined : await validateSourceDefaults(handle, parsed.data.defaults);
    if (dv && !dv.ok) return c.json(dv.error, 422);

    const [row] = await handle.db
      .insert(schema.source)
      .values({ ...parsed.data, defaults: dv?.ok ? dv.defaults : {}, teamId: caller.teamId })
      .returning();
    return c.json(row, 201);
  });

  app.patch("/api/sources", async (c) => {
    const actor = await resolveActor(c, handle, ["sources:write"], c.req.header("Authorization"));
    if ("error" in actor) return c.json({ error: actor.error }, actor.status);

    const json: unknown = await c.req.json().catch(() => undefined);
    const parsed = patchSourceSchema.safeParse(json);
    if (!parsed.success) return c.json({ error: "invalid body" }, 400);
    const { id, ...patchIn } = parsed.data;
    let patch = patchIn;
    if (Object.keys(patch).length === 0) return c.json({ error: "no fields to update" }, 400);

    const caller = actor.kind === "session" ? { teamId: actor.session.teamId, role: actor.session.role } : await loadCaller(handle, actor.apiKey);
    if (!caller || caller.role !== "operator") return c.json({ error: "operator role required" }, 403);
    const teamId = caller.teamId;

    const [existing] = await handle.db.select({ teamId: schema.source.teamId, kind: schema.source.kind, url: schema.source.url }).from(schema.source).where(eq(schema.source.id, id)).limit(1);
    // Scoped to the caller's team: a source in another team is reported as
    // "not found" (no existence leak), same as a truly missing id.
    if (!existing || existing.teamId !== teamId) return c.json({ error: "not found" }, 404);

    if (existing.kind !== "web" && patch.url !== undefined && !sourceUrlSchema.safeParse(patch.url).success) {
      return c.json({ error: "invalid body" }, 400);
    }
    if (existing.kind === "web") {
      // Only a real change is rejected; a null key / unchanged url is a no-op.
      if (typeof patch.assignedKeyId === "string" || (patch.url !== undefined && patch.url !== existing.url)) {
        return c.json({ error: "url and assignedKeyId cannot be changed on a web source" }, 400);
      }
      patch = { ...patch };
      delete patch.url;
      delete patch.assignedKeyId;
      if (Object.keys(patch).length === 0) {
        const [current] = await handle.db.select().from(schema.source).where(eq(schema.source.id, id)).limit(1);
        return current ? c.json(current) : c.json({ error: "not found" }, 404);
      }
    }
    if (patch.assignedKeyId && !(await isKeyInTeam(handle, patch.assignedKeyId, teamId))) {
      return c.json({ error: "assignedKeyId must belong to a key on the same team" }, 400);
    }

    const dv = patch.defaults === undefined ? undefined : await validateSourceDefaults(handle, patch.defaults);
    if (dv && !dv.ok) return c.json(dv.error, 422);

    const [row] = await handle.db
      .update(schema.source)
      .set(dv?.ok ? { ...patch, defaults: dv.defaults } : patch)
      .where(eq(schema.source.id, id))
      .returning();
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json(row);
  });

  /** Session-only additions: `PATCH/:id`, `/:id/pause`, `/:id/resume`. */
  async function requireOperatorSession(c: { req: { raw: { headers: Headers } } }): Promise<Session | Response> {
    const session = await resolveSession(c.req.raw.headers, handle);
    if (session === "not_provisioned") return Response.json({ error: "not_provisioned", message: "Ask an operator to add you" }, { status: 403 });
    if (!session) return Response.json({ error: "unauthenticated", message: "missing or invalid credentials" }, { status: 401 });
    if (session.role !== "operator") return Response.json({ error: "forbidden", message: "operator role required" }, { status: 403 });
    return session;
  }

  async function loadTeamSource(id: string, teamId: string): Promise<typeof schema.source.$inferSelect | undefined> {
    const [row] = await handle.db.select().from(schema.source).where(and(eq(schema.source.id, id), eq(schema.source.teamId, teamId))).limit(1);
    return row;
  }

  app.patch("/api/sources/:id", async (c) => {
    const session = await requireOperatorSession(c);
    if (session instanceof Response) return session;

    const existing = await loadTeamSource(c.req.param("id"), session.teamId);
    if (!existing) return c.json({ error: "not_found", message: "source not found" }, 404);

    const json: unknown = await c.req.json().catch(() => undefined);
    const parsed = sessionPatchSourceSchema.safeParse(json);
    if (!parsed.success) return c.json({ error: "validation", message: "invalid body", issues: parsed.error.issues }, 400);

    let body = parsed.data;
    if (existing.kind === "web") {
      // A null key is a no-op; only assigning a key is rejected.
      if (typeof body.assignedKeyId === "string") {
        return c.json({ error: "validation", message: "assignedKeyId cannot be changed on a web source" }, 400);
      }
      body = { ...body };
      delete body.assignedKeyId;
      if (Object.keys(body).length === 0) return c.json(existing);
    }
    if (body.assignedKeyId && !(await isKeyInTeam(handle, body.assignedKeyId, session.teamId))) {
      return c.json({ error: "validation", message: "assignedKeyId must belong to a key on the same team" }, 400);
    }

    const dv = body.defaults === undefined ? undefined : await validateSourceDefaults(handle, body.defaults);
    if (dv && !dv.ok) return c.json(dv.error, 422);

    const [row] = await handle.db
      .update(schema.source)
      .set(dv?.ok ? { ...body, defaults: dv.defaults } : body)
      .where(eq(schema.source.id, existing.id))
      .returning();
    return c.json(row);
  });

  app.post("/api/sources/:id/pause", async (c) => {
    const session = await requireOperatorSession(c);
    if (session instanceof Response) return session;

    const existing = await loadTeamSource(c.req.param("id"), session.teamId);
    if (!existing) return c.json({ error: "not_found", message: "source not found" }, 404);

    const [row] = await handle.db.update(schema.source).set({ status: "paused" }).where(eq(schema.source.id, existing.id)).returning();
    return c.json(row);
  });

  app.post("/api/sources/:id/resume", async (c) => {
    const session = await requireOperatorSession(c);
    if (session instanceof Response) return session;

    const existing = await loadTeamSource(c.req.param("id"), session.teamId);
    if (!existing) return c.json({ error: "not_found", message: "source not found" }, 404);

    const health = typeof existing.health === "object" && existing.health !== null ? { ...(existing.health as Record<string, unknown>) } : {};
    health.reason = null;
    const [row] = await handle.db.update(schema.source).set({ status: "active", health }).where(eq(schema.source.id, existing.id)).returning();
    return c.json(row);
  });

  return app;
}
