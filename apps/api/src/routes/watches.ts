import { attributeFilterSchema, canonFilter, checkFilter, resolveAllSchemas, type AttributeFilter } from "@feedhound/core/attributes";
import { watchInputSchema, watchPatchSchema, watchTestSchema, type WatchInput } from "@feedhound/core/watch";
import { validateRegex } from "@feedhound/core/regex-safe";
import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { Hono } from "hono";
import { authenticateApiKey, type ApiKeyContext } from "../middleware/api-key";
import { resolveSession, type Session } from "../middleware/cf-access";
import { testWatch } from "../services/watch-test";
import { loadWatchStats } from "../services/watch-stats";

const DEFAULT_REGEX_MAX_LEN = 200;

async function fetchRegexMaxLen(handle: DbHandle): Promise<number> {
  const [row] = await handle.db
    .select({ value: schema.config.value })
    .from(schema.config)
    .where(eq(schema.config.key, "match.regexMaxLen"))
    .orderBy(desc(schema.config.version))
    .limit(1);
  return (row?.value as number | undefined) ?? DEFAULT_REGEX_MAX_LEN;
}

/** Optional `?hours=` (integer 1..168) overriding the body's window; `"invalid"` -> 422. */
function parseHoursQuery(raw: string | undefined): number | undefined | "invalid" {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 168 ? n : "invalid";
}

export interface WatchActor {
  userId: string;
  teamId: string;
  role: "hunter" | "operator";
}

/** Role + team for the calling api key's user (code-review pattern, sources.ts). */
async function loadRoleAndTeam(handle: DbHandle, userId: string): Promise<{ role: "hunter" | "operator"; teamId: string }> {
  const [row] = await handle.db.select({ role: schema.user.role, teamId: schema.user.teamId }).from(schema.user).where(eq(schema.user.id, userId)).limit(1);
  return { role: row?.role === "operator" ? "operator" : "hunter", teamId: row?.teamId ?? "" };
}

/**
 * Resolves the caller of a `/api/watches*` request, accepting either a
 * dashboard session (owner-or-operator) or an api key
 * (`watches:read`/`watches:write`) on the same path.
 */
export async function resolveWatchActor(
  c: { req: { raw: { headers: Headers }; header(name: string): string | undefined } },
  handle: DbHandle,
  requiredScopes: string[],
): Promise<WatchActor | Response> {
  const session = await resolveSession(c.req.raw.headers, handle);
  if (session === "not_provisioned") return Response.json({ error: "not_provisioned", message: "Ask an operator to add you" }, { status: 403 });
  if (session) return { userId: session.userId, teamId: session.teamId, role: session.role };

  const authHeader = c.req.header("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : undefined;
  const result = await authenticateApiKey(token, requiredScopes, handle);
  if (!result.ok) return Response.json({ error: result.message }, { status: result.status });
  const { role, teamId } = await loadRoleAndTeam(handle, result.context.userId);
  return { userId: result.context.userId, teamId, role };
}

/**
 * Resolves the effective owner userId for list/log routes: `?userId=` is
 * honoured only for operators, and only for a user in the operator's own
 * team — otherwise an operator could read
 * another team's watches cross-team via the query param.
 */
export async function resolveTargetUserId(handle: DbHandle, actor: WatchActor, queryUserId: string | undefined): Promise<string | Response> {
  if (!queryUserId || actor.role !== "operator") return actor.userId;
  const [target] = await handle.db.select({ teamId: schema.user.teamId }).from(schema.user).where(eq(schema.user.id, queryUserId)).limit(1);
  if (!target || target.teamId !== actor.teamId) return Response.json({ error: "not_found", message: "user not found" }, { status: 404 });
  return queryUserId;
}

const ownerBodySchema = z.object({ userId: z.string().uuid().optional() });

/**
 * Optional body `userId` naming another owner. Absent or equal to the current owner -> that owner;
 * otherwise operator only (403), and the target must be in the actor's team (404).
 */
async function resolveOwnerOverride(handle: DbHandle, actor: WatchActor, bodyUserId: string | undefined, currentOwnerId: string): Promise<string | Response> {
  if (!bodyUserId || bodyUserId === currentOwnerId) return currentOwnerId;
  if (actor.role !== "operator") return Response.json({ error: "forbidden" }, { status: 403 });
  const [target] = await handle.db.select({ teamId: schema.user.teamId }).from(schema.user).where(eq(schema.user.id, bodyUserId)).limit(1);
  if (!target || target.teamId !== actor.teamId) return Response.json({ error: "not_found" }, { status: 404 });
  return bodyUserId;
}

interface ExistenceCheckError {
  field: string;
  reason: string;
}

/**
 * CategoryIds/itemIds/sourceIds must exist; notifierIds must
 * exist and be owned by `userId`. sourceIds must additionally belong to
 * `teamId` — otherwise `/api/watches/test` (and
 * a saved watch) could read another team's posts by title/url/price.
 */
async function checkReferencesExist(
  handle: DbHandle,
  userId: string,
  teamId: string,
  input: Pick<WatchInput, "categoryIds" | "itemIds" | "sourceIds" | "notifierIds">,
): Promise<ExistenceCheckError | undefined> {
  if (input.categoryIds.length > 0) {
    const rows = await handle.db.select({ id: schema.category.id }).from(schema.category).where(inArray(schema.category.id, input.categoryIds));
    if (rows.length !== new Set(input.categoryIds).size) return { field: "categoryIds", reason: "one or more categoryIds do not exist" };
  }
  if (input.itemIds.length > 0) {
    const rows = await handle.db.select({ id: schema.catalogItem.id }).from(schema.catalogItem).where(inArray(schema.catalogItem.id, input.itemIds));
    if (rows.length !== new Set(input.itemIds).size) return { field: "itemIds", reason: "one or more itemIds do not exist" };
  }
  if (input.sourceIds.length > 0) {
    const rows = await handle.db
      .select({ id: schema.source.id })
      .from(schema.source)
      .where(and(inArray(schema.source.id, input.sourceIds), eq(schema.source.teamId, teamId)));
    if (rows.length !== new Set(input.sourceIds).size) return { field: "sourceIds", reason: "one or more sourceIds do not exist" };
  }
  if (input.notifierIds.length > 0) {
    const rows = await handle.db
      .select({ id: schema.notifier.id })
      .from(schema.notifier)
      .where(and(inArray(schema.notifier.id, input.notifierIds), eq(schema.notifier.userId, userId)));
    if (rows.length !== new Set(input.notifierIds).size) {
      return { field: "notifierIds", reason: "one or more notifierIds do not exist or are not owned by the caller" };
    }
  }
  return undefined;
}

/**
 * Every filter key must exist in the resolved schema of at least one of `categoryIds`, the op must
 * suit the attribute kind and the values must canon-validate. Returns the filters with canonical values.
 */
async function validateAttributeFilters(
  handle: DbHandle,
  categoryIds: string[],
  filters: AttributeFilter[],
): Promise<{ ok: true; filters: AttributeFilter[] } | { ok: false; error: ExistenceCheckError }> {
  if (filters.length === 0) return { ok: true, filters };
  const rows = await handle.db
    .select({ id: schema.category.id, path: schema.category.path, attributeSchema: schema.category.attributeSchema })
    .from(schema.category);
  const resolved = resolveAllSchemas(rows);
  const out: AttributeFilter[] = [];
  for (const [i, f] of filters.entries()) {
    let def = categoryIds.map((id) => resolved.get(id)?.find((d) => d.key === f.key)).find((d) => d !== undefined);
    // A region filter may stand without categories; its def comes from any schema declaring `region`.
    if (!def && f.key === "region") def = [...resolved.values()].map((schemaDefs) => schemaDefs.find((d) => d.key === "region")).find((d) => d !== undefined);
    if (!def) return { ok: false, error: { field: `attributeFilters.${i}`, reason: `attribute "${f.key}" is not defined for the selected categories` } };
    const reason = checkFilter(def, f);
    if (reason) return { ok: false, error: { field: `attributeFilters.${i}`, reason } };
    out.push(canonFilter(def, f));
  }
  return { ok: true, filters: out };
}

export type CreateWatchResult =
  | { ok: true; row: typeof schema.watch.$inferSelect }
  | { ok: false; status: 422; body: { field?: string; reason?: string } };

/**
 * Shared validation + insert for `POST /api/watches` and save-as-watch: regex bounds,
 * reference/ownership checks, attribute filters, then the insert.
 */
export async function createWatch(handle: DbHandle, actor: WatchActor, input: WatchInput): Promise<CreateWatchResult> {
  if (input.regex) {
    const maxLen = await fetchRegexMaxLen(handle);
    const validated = validateRegex(input.regex, maxLen);
    if (!validated.ok) return { ok: false, status: 422, body: { field: "regex", reason: validated.reason } };
  }

  const refError = await checkReferencesExist(handle, actor.userId, actor.teamId, input);
  if (refError) return { ok: false, status: 422, body: refError };
  const attrCheck = await validateAttributeFilters(handle, input.categoryIds, input.attributeFilters);
  if (!attrCheck.ok) return { ok: false, status: 422, body: attrCheck.error };

  const [row] = await handle.db
    .insert(schema.watch)
    .values({
      userId: actor.userId,
      name: input.name,
      enabled: input.enabled,
      include: input.include,
      includeAll: input.includeAll,
      exclude: input.exclude,
      regex: input.regex ?? null,
      categoryIds: input.categoryIds,
      itemIds: input.itemIds,
      priceMin: input.priceMin ?? null,
      priceMax: input.priceMax ?? null,
      attributeFilters: attrCheck.filters,
      intents: input.intents,
      sourceIds: input.sourceIds,
      notifierIds: input.notifierIds,
      quietHours: input.quietHours ?? null,
      mutedUntil: input.mutedUntil ? new Date(input.mutedUntil) : null,
    })
    .returning();
  return { ok: true, row: row! };
}

/**
 * Loads a watch the actor may read/write: the owner's own watch, or any watch when the actor is an operator. `undefined` for a
 * missing id or a non-owner/non-operator (404, no existence leak).
 */
async function loadOwnWatch(handle: DbHandle, id: string, actor: WatchActor): Promise<typeof schema.watch.$inferSelect | undefined> {
  const where = actor.role === "operator" ? eq(schema.watch.id, id) : and(eq(schema.watch.id, id), eq(schema.watch.userId, actor.userId));
  const [row] = await handle.db.select().from(schema.watch).where(where).limit(1);
  return row;
}

/**
 * `/api/watches` CRUD + `/test`. Owner-scoped by
 * `watch.userId = key.userId`; cross-owner access is always 404, never 403.
 */
export function watchesRoute(handle: DbHandle): Hono<{ Variables: { apiKey: ApiKeyContext; session: Session } }> {
  const app = new Hono<{ Variables: { apiKey: ApiKeyContext; session: Session } }>();

  app.get("/api/watches", async (c) => {
    const actor = await resolveWatchActor(c, handle, ["watches:read"]);
    if (actor instanceof Response) return actor;
    const queryUserId = c.req.query("userId");
    const targetUserId = await resolveTargetUserId(handle, actor, queryUserId);
    if (targetUserId instanceof Response) return targetUserId;
    const rows = await handle.db.select().from(schema.watch).where(eq(schema.watch.userId, targetUserId));
    // `?stats=1` adds per-watch card stats (additive).
    if (c.req.query("stats") === "1") {
      const stats = await loadWatchStats(handle, rows);
      return c.json({ watches: rows.map((w) => ({ ...w, stats: stats.get(w.id) })) });
    }
    return c.json({ watches: rows });
  });

  app.post("/api/watches", async (c) => {
    const actor = await resolveWatchActor(c, handle, ["watches:write"]);
    if (actor instanceof Response) return actor;
    const json: unknown = await c.req.json().catch(() => undefined);
    const parsed = watchInputSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json({ error: "invalid body", field: issue?.path.join(".") || undefined, reason: issue?.message }, 422);
    }
    const ownerBody = ownerBodySchema.safeParse(json);
    if (!ownerBody.success) return c.json({ error: "invalid body", field: "userId", reason: "must be a uuid" }, 422);
    const ownerId = await resolveOwnerOverride(handle, actor, ownerBody.data.userId, actor.userId);
    if (ownerId instanceof Response) return ownerId;
    const created = await createWatch(handle, { ...actor, userId: ownerId }, parsed.data);
    if (!created.ok) return c.json(created.body, created.status);
    const row = created.row;
    return c.json(row, 201);
  });

  app.get("/api/watches/:id", async (c) => {
    const actor = await resolveWatchActor(c, handle, ["watches:read"]);
    if (actor instanceof Response) return actor;
    const row = await loadOwnWatch(handle, c.req.param("id"), actor);
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json(row);
  });

  app.patch("/api/watches/:id", async (c) => {
    const actor = await resolveWatchActor(c, handle, ["watches:write"]);
    if (actor instanceof Response) return actor;
    const existing = await loadOwnWatch(handle, c.req.param("id"), actor);
    if (!existing) return c.json({ error: "not found" }, 404);

    const json: unknown = await c.req.json().catch(() => undefined);
    const parsed = watchPatchSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json({ error: "invalid body", field: issue?.path.join(".") || undefined, reason: issue?.message }, 422);
    }
    const ownerBody = ownerBodySchema.safeParse(json);
    if (!ownerBody.success) return c.json({ error: "invalid body", field: "userId", reason: "must be a uuid" }, 422);
    const newOwnerId = await resolveOwnerOverride(handle, actor, ownerBody.data.userId, existing.userId);
    if (newOwnerId instanceof Response) return newOwnerId;
    const moving = newOwnerId !== existing.userId;
    // `.partial()` still applies the schema defaults (`[]`); only fields actually sent in the body are a patch.
    const sent = new Set(json !== null && typeof json === "object" ? Object.keys(json) : []);
    const patch = Object.fromEntries(Object.entries(parsed.data).filter(([k]) => sent.has(k))) as typeof parsed.data;

    const merged = {
      categoryIds: patch.categoryIds ?? existing.categoryIds,
      itemIds: patch.itemIds ?? existing.itemIds,
      sourceIds: patch.sourceIds ?? existing.sourceIds,
      notifierIds: patch.notifierIds ?? existing.notifierIds,
      include: patch.include ?? existing.include,
      includeAll: patch.includeAll ?? existing.includeAll,
      regex: patch.regex !== undefined ? patch.regex : existing.regex,
    };

    if (
      merged.include.length === 0 &&
      merged.includeAll.length === 0 &&
      !merged.regex &&
      merged.categoryIds.length === 0 &&
      merged.itemIds.length === 0
    ) {
      return c.json({
        error: "invalid body",
        reason: "at least one of include | includeAll | regex | categoryIds | itemIds must be non-empty",
      }, 422);
    }

    if (patch.regex) {
      const maxLen = await fetchRegexMaxLen(handle);
      const validated = validateRegex(patch.regex, maxLen);
      if (!validated.ok) return c.json({ field: "regex", reason: validated.reason }, 422);
    }

    // sourceIds must belong to the watch owner's team, not necessarily the
    // acting operator's own team.
    const { teamId: ownerTeamId } = await loadRoleAndTeam(handle, newOwnerId);
    const refError = await checkReferencesExist(handle, newOwnerId, ownerTeamId, {
      categoryIds: patch.categoryIds ?? [],
      itemIds: patch.itemIds ?? [],
      sourceIds: patch.sourceIds ?? [],
      notifierIds: patch.notifierIds ?? [],
    });
    if (refError) return c.json(refError, 422);

    let canonicalFilters: AttributeFilter[] | undefined;
    if (patch.attributeFilters !== undefined || patch.categoryIds !== undefined) {
      const storedFilters = attributeFilterSchema.array().safeParse(existing.attributeFilters);
      const filters = patch.attributeFilters ?? (storedFilters.success ? storedFilters.data : []);
      if (filters.length > 0 && merged.categoryIds.length === 0 && !filters.every((f) => f.key === "region")) {
        return c.json({ field: "attributeFilters", reason: "attributeFilters need at least one category" }, 422);
      }
      const attrCheck = await validateAttributeFilters(handle, merged.categoryIds, filters);
      if (!attrCheck.ok) return c.json(attrCheck.error, 422);
      canonicalFilters = attrCheck.filters;
    }

    // Only set fields actually present in the patch body — a `Partial<WatchInput>`
    // must never null out fields the caller didn't touch.
    const setValues: Partial<typeof schema.watch.$inferInsert> = {};
    for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
      const value = patch[key];
      if (value === undefined) continue;
      if (key === "mutedUntil") {
        setValues.mutedUntil = value ? new Date(value as string) : null;
        continue;
      }
      (setValues as Record<string, unknown>)[key] = key === "regex" && value === "" ? null : value;
    }
    if (canonicalFilters !== undefined) setValues.attributeFilters = canonicalFilters;
    if (moving) {
      // A move resets the notifier picks to the new owner's defaults unless the body re-picks.
      setValues.userId = newOwnerId;
      if (patch.notifierIds === undefined) setValues.notifierIds = [];
    }

    if (Object.keys(setValues).length === 0) return c.json(existing); // e.g. only `userId` equal to the current owner
    const [row] = await handle.db.update(schema.watch).set(setValues).where(eq(schema.watch.id, existing.id)).returning();
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json(row);
  });

  // `DELETE` cascades to `match`, which silently destroys match history. Chosen fix
  // is to keep the cascade (it's the literal, already-implemented behaviour  Interface text, and 003's Out-of-scope explicitly does not cover
  // history retention) but require an explicit `?confirm=true` so a plain
  // `DELETE` can no longer destroy history by accident.
  app.delete("/api/watches/:id", async (c) => {
    const actor = await resolveWatchActor(c, handle, ["watches:write"]);
    if (actor instanceof Response) return actor;
    const existing = await loadOwnWatch(handle, c.req.param("id"), actor);
    if (!existing) return c.json({ error: "not found" }, 404);
    if (c.req.query("confirm") !== "true") {
      return c.json(
        { error: "confirmation required", reason: "deleting a watch cascades and permanently deletes its match history; retry with ?confirm=true" },
        400,
      );
    }
    await handle.db.delete(schema.watch).where(eq(schema.watch.id, existing.id));
    return c.body(null, 204);
  });

  app.post("/api/watches/:id/test", async (c) => {
    const actor = await resolveWatchActor(c, handle, ["watches:read"]);
    if (actor instanceof Response) return actor;
    const existing = await loadOwnWatch(handle, c.req.param("id"), actor);
    if (!existing) return c.json({ error: "not found" }, 404);

    const json: unknown = await c.req.json().catch(() => ({}));
    const parsed = watchTestSchema.safeParse(json ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json({ error: "invalid body", field: issue?.path.join("."), reason: issue?.message }, 422);
    }
    const queryHours = parseHoursQuery(c.req.query("hours"));
    if (queryHours === "invalid") return c.json({ error: "invalid query", field: "hours", reason: "must be an integer 1..168" }, 422);

    // An operator may `/test` another team's watch, so `actor.teamId`
    // (the operator's own team) is wrong here — always scope by the watch owner's team.
    const { teamId: ownerTeamId } = await loadRoleAndTeam(handle, existing.userId);
    const result = await testWatch(handle, existing, queryHours ?? parsed.data.hours, parsed.data.limit, ownerTeamId);
    // `truncated` is additive to the documented
    // `{ posts }` shape — surfaces when the 20,000-row scan cap was hit
    // before the whole `since` window was scanned.
    return c.json(result);
  });

  // Tests an unsaved watch draft (no id/userId
  // yet) against posts from the last `hours` (default 24h). Read-only, same
  // matcher as `/:id/test`.
  app.post("/api/watches/test", async (c) => {
    const actor = await resolveWatchActor(c, handle, ["watches:read"]);
    if (actor instanceof Response) return actor;

    const json: unknown = await c.req.json().catch(() => undefined);
    const parsed = watchInputSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json({ error: "invalid body", field: issue?.path.join(".") || undefined, reason: issue?.message }, 422);
    }
    const input = parsed.data;

    if (input.regex) {
      const maxLen = await fetchRegexMaxLen(handle);
      const validated = validateRegex(input.regex, maxLen);
      if (!validated.ok) return c.json({ field: "regex", reason: validated.reason }, 422);
    }

    // without this, a draft test naming another
    // team's sourceIds returned that team's post titles/urls/prices.
    const refError = await checkReferencesExist(handle, actor.userId, actor.teamId, input);
    if (refError) return c.json(refError, 422);
    const attrCheck = await validateAttributeFilters(handle, input.categoryIds, input.attributeFilters);
    if (!attrCheck.ok) return c.json(attrCheck.error, 422);

    const draft: typeof schema.watch.$inferSelect = {
      id: "00000000-0000-0000-0000-000000000000",
      userId: actor.userId,
      name: input.name,
      enabled: input.enabled,
      include: input.include,
      includeAll: input.includeAll,
      exclude: input.exclude,
      regex: input.regex ?? null,
      categoryIds: input.categoryIds,
      itemIds: input.itemIds,
      priceMin: input.priceMin ?? null,
      priceMax: input.priceMax ?? null,
      attributeFilters: attrCheck.filters,
      intents: input.intents,
      sourceIds: input.sourceIds,
      notifierIds: input.notifierIds,
      quietHours: input.quietHours ?? null,
      mutedUntil: input.mutedUntil ? new Date(input.mutedUntil) : null,
      createdAt: new Date(),
    };

    const hours = parseHoursQuery(c.req.query("hours"));
    if (hours === "invalid") return c.json({ error: "invalid query", field: "hours", reason: "must be an integer 1..168" }, 422);
    const limitRaw = Number(c.req.query("limit") ?? 50);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 50) : 50;

    const result = await testWatch(handle, draft, hours ?? 24, limit, actor.teamId);
    // Response shape: `{ count, posts: { id, title,
    // sourceId, firstSeenAt, url, matchedTerms }[] }` (priceVnd/intent are
    // not tracked by `testWatch`'s result today; omitted rather than faked).
    const posts = result.posts.map((p) => ({
      id: p.postId,
      title: p.title,
      sourceId: p.sourceId,
      firstSeenAt: p.postedAt,
      url: p.url,
      matchedTerms: p.matchedTerms,
      priceVnd: p.priceVnd,
    }));
    return c.json({ count: posts.length, total: result.total, daily: result.daily, truncated: result.truncated, posts });
  });

  return app;
}
