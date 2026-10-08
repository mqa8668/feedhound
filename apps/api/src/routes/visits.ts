import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { apiKeyAuth, type ApiKeyContext } from "../middleware/api-key";
import { cfAccessAuth, type Session } from "../middleware/cf-access";
import { rateLimit } from "../middleware/rate-limit";
import { requireSession } from "../middleware/session";
import { applyVisitOutcome } from "../services/source-health";

// `POST /api/visits` bodies are tiny (a handful of scalars); 16 KB is far above any legitimate payload but stops an oversized body
// from a hostile/misbehaving key.
const VISITS_BODY_LIMIT_BYTES = 16 * 1024;

const OUTCOMES = ["ok", "no_slots", "blocked", "timeout", "error", "skipped"] as const;

/** Zod contract for `POST /api/visits`. */
export const visitReportSchema = z
  .object({
    id: z.string().uuid(),
    sourceId: z.string().uuid(),
    startedAt: z.string().datetime({ offset: true }).optional(),
    finishedAt: z.string().datetime({ offset: true }).optional(),
    outcome: z.enum(OUTCOMES).optional(),
    mode: z.enum(["normal", "catchup", "probe"]).default("normal"),
    postsSeen: z.number().int().min(0).max(100_000).optional(),
    postsNew: z.number().int().min(0).max(100_000).optional(),
    pages: z.number().int().min(0).max(100_000).optional(),
    reachedKnownTail: z.boolean().optional(),
    reason: z.string().max(500).optional(),
  })
  .refine((v) => (v.outcome !== undefined) === (v.finishedAt !== undefined), {
    message: "outcome must be present if and only if finishedAt is present",
  });

export type VisitReportInput = z.infer<typeof visitReportSchema>;

interface VisitRow {
  id: string;
  source_id: string;
  started_at: Date;
  started_at_text: string;
  finished_at: Date | null;
  outcome: string | null;
  mode: string;
  posts_seen: number | null;
  posts_new: number | null;
  pages: number | null;
  reached_known_tail: boolean | null;
  reason: string | null;
}

/** Shared shape for a visit row plus its ingest-tagged post count (Interface `VisitDto`). */
export interface VisitDto {
  id: string;
  sourceId: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: string | null;
  mode: string;
  postsSeen: number | null;
  postsNew: number | null;
  pages: number | null;
  reachedKnownTail: boolean | null;
  reason: string | null;
  postsIngested: number;
}

function toDto(row: VisitRow, postsIngested: number): VisitDto {
  return {
    id: row.id,
    sourceId: row.source_id,
    startedAt: new Date(row.started_at).toISOString(),
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    outcome: row.outcome,
    mode: row.mode,
    postsSeen: row.posts_seen,
    postsNew: row.posts_new,
    pages: row.pages,
    reachedKnownTail: row.reached_known_tail,
    reason: row.reason,
    postsIngested,
  };
}

async function countPostsIngested(handle: DbHandle, visitId: string): Promise<number> {
  const [row] = await handle.db
    .select({ count: sql<string>`count(*)` })
    .from(schema.post)
    .where(eq(schema.post.visitId, visitId));
  return Number(row?.count ?? 0);
}

const visitsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
});

const VISIT_CURSOR_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?([+-])(\d{2})(:\d{2})?$/;

function isCalendarValidTimestamp(v: string): boolean {
  const m = VISIT_CURSOR_RE.exec(v);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const s = Number(m[6]);
  const tzH = Number(m[9]);
  const tzM = m[10] ? Number(m[10].slice(1)) : 0;
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 60 || tzH > 15 || tzM > 59) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

const visitCursorSchema = z.object({
  startedAt: z.string().regex(VISIT_CURSOR_RE).refine(isCalendarValidTimestamp, "startedAt is not a valid timestamp"),
  id: z.string().uuid(),
});

type VisitCursor = z.infer<typeof visitCursorSchema>;

function encodeVisitCursor(row: { startedAtText: string; id: string }): string {
  return Buffer.from(JSON.stringify({ startedAt: row.startedAtText, id: row.id }), "utf8").toString("base64url");
}

function decodeVisitCursor(raw: string): VisitCursor | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  const parsed = visitCursorSchema.safeParse(decoded);
  return parsed.success ? parsed.data : undefined;
}

/** `POST /api/visits` + `GET /api/sources/:id/visits`. */
export function visitsRoute(handle: DbHandle): Hono<{ Variables: { apiKey: ApiKeyContext; session: Session } }> {
  const app = new Hono<{ Variables: { apiKey: ApiKeyContext; session: Session } }>();

  app.post(
    "/api/visits",
    apiKeyAuth(["ingest"], handle),
    rateLimit(),
    bodyLimit({ maxSize: VISITS_BODY_LIMIT_BYTES, onError: (c) => c.json({ error: "payload too large" }, 413) }),
    async (c) => {
      const json: unknown = await c.req.json().catch(() => undefined);
      const parsed = visitReportSchema.safeParse(json);
      if (!parsed.success) return c.json({ error: "invalid body" }, 400);
      const body = parsed.data;

      const apiKey = c.get("apiKey");

      const [source] = await handle.db
        .select({ id: schema.source.id })
        .from(schema.source)
        .where(eq(schema.source.id, body.sourceId))
        .limit(1);
      // Same status for "unknown source" and "not assigned" — a 404 vs 403
      // split would let an ingest key probe source ids in other teams.
      if (!source || !apiKey.sourceIds.includes(body.sourceId)) return c.json({ error: "source not assigned to key" }, 403);

      const now = new Date();

      const finishedAt = body.finishedAt ? new Date(Math.min(new Date(body.finishedAt).getTime(), now.getTime())) : null;
      const rawStartedAt = body.startedAt ? new Date(body.startedAt) : (finishedAt ?? now);
      // Clamp startedAt to min(startedAt, finishedAt, now) — never reject,
      // just pull an out-of-order/future value back in line.
      const startedAtCeiling = finishedAt ? Math.min(finishedAt.getTime(), now.getTime()) : now.getTime();
      const startedAt = new Date(Math.min(rawStartedAt.getTime(), startedAtCeiling));

      // `ON CONFLICT (id) DO UPDATE ... WHERE visit.source_id =
      // excluded.source_id` — a same-id conflict for a *different* source
      // updates zero rows (RETURNING is then empty), which the caller turns
      // into a 409. Raw SQL (not drizzle's `onConflictDoUpdate`, which has no
      // `where` guard) so that guard is enforced atomically.
      const rows = await handle.sql<VisitRow[]>`
        insert into visit (id, source_id, started_at, finished_at, outcome, mode, posts_seen, posts_new, pages, reached_known_tail, reason)
        values (
          ${body.id}, ${body.sourceId}, ${startedAt.toISOString()}::timestamptz,
          ${finishedAt ? finishedAt.toISOString() : null}::timestamptz, ${body.outcome ?? null}, ${body.mode},
          ${body.postsSeen ?? null}, ${body.postsNew ?? null}, ${body.pages ?? null}, ${body.reachedKnownTail ?? null}, ${body.reason ?? null}
        )
        on conflict (id) do update set
          started_at = least(visit.started_at, excluded.started_at),
          finished_at = coalesce(excluded.finished_at, visit.finished_at),
          outcome = coalesce(excluded.outcome, visit.outcome),
          posts_seen = coalesce(excluded.posts_seen, visit.posts_seen),
          posts_new = coalesce(excluded.posts_new, visit.posts_new),
          pages = coalesce(excluded.pages, visit.pages),
          reached_known_tail = coalesce(excluded.reached_known_tail, visit.reached_known_tail),
          reason = coalesce(excluded.reason, visit.reason),
          updated_at = now()
        where visit.source_id = excluded.source_id
        returning id, source_id, started_at, started_at::text as started_at_text, finished_at, outcome, mode, posts_seen, posts_new, pages, reached_known_tail, reason
      `;
      const row = rows[0];
      if (!row) return c.json({ error: "visit belongs to another source" }, 409);

      if (row.outcome === "ok" && row.finished_at) {
        await handle.db
          .update(schema.source)
          .set({ lastOkVisitAt: sql`greatest(coalesce(${schema.source.lastOkVisitAt}, ${new Date(row.finished_at).toISOString()}::timestamptz), ${new Date(row.finished_at).toISOString()}::timestamptz)` })
          .where(eq(schema.source.id, row.source_id));
      }

      // Pause / resume / parser alerts follow the ledger row (incl. 022 counters).
      if (row.outcome !== null && row.finished_at) {
        await applyVisitOutcome(handle, {
          id: row.id,
          sourceId: row.source_id,
                outcome: row.outcome,
          reason: row.reason,
          mode: row.mode,
          finishedAt: new Date(row.finished_at),
        });
      }

      const postsIngested = await countPostsIngested(handle, row.id);
      return c.json({ visit: toDto(row, postsIngested) });
    },
  );

  app.get("/api/sources/:id/visits", cfAccessAuth(handle), requireSession(), async (c) => {
    const session = c.get("session");
    const sourceId = c.req.param("id");

    const parsed = visitsQuerySchema.safeParse({
      limit: c.req.query("limit") || undefined,
      cursor: c.req.query("cursor") || undefined,
    });
    if (!parsed.success) return c.json({ error: "validation", message: "invalid query", issues: parsed.error.issues }, 400);

    let cursor: VisitCursor | undefined;
    if (parsed.data.cursor) {
      cursor = decodeVisitCursor(parsed.data.cursor);
      if (!cursor) return c.json({ error: "validation", message: "invalid cursor" }, 400);
    }

    const [source] = await handle.db
      .select({ id: schema.source.id })
      .from(schema.source)
      .where(and(eq(schema.source.id, sourceId), eq(schema.source.teamId, session.teamId)))
      .limit(1);
    if (!source) return c.json({ error: "not_found", message: "source not found" }, 404);

    const conditions = [eq(schema.visit.sourceId, sourceId)];
    if (cursor) {
      conditions.push(sql`(${schema.visit.startedAt}, ${schema.visit.id}) < (${cursor.startedAt}::timestamptz, ${cursor.id}::uuid)`);
    }

    const rows = await handle.db
      .select({
        id: schema.visit.id,
        sourceId: schema.visit.sourceId,
        startedAt: schema.visit.startedAt,
        startedAtText: sql<string>`${schema.visit.startedAt}::text`,
        finishedAt: schema.visit.finishedAt,
        outcome: schema.visit.outcome,
        mode: schema.visit.mode,
        postsSeen: schema.visit.postsSeen,
        postsNew: schema.visit.postsNew,
        pages: schema.visit.pages,
        reachedKnownTail: schema.visit.reachedKnownTail,
        reason: schema.visit.reason,
      })
      .from(schema.visit)
      .where(and(...conditions))
      .orderBy(sql`${schema.visit.startedAt} desc`, sql`${schema.visit.id} desc`)
      .limit(parsed.data.limit);

    const visitIds = rows.map((r) => r.id);
    const countRows =
      visitIds.length === 0
        ? []
        : await handle.db
            .select({ visitId: schema.post.visitId, count: sql<string>`count(*)` })
            .from(schema.post)
            .where(inArray(schema.post.visitId, visitIds))
            .groupBy(schema.post.visitId);
    const countsByVisit = new Map(countRows.map((r) => [r.visitId, Number(r.count)]));

    const visits: VisitDto[] = rows.map((row) => ({
      id: row.id,
      sourceId: row.sourceId,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
      outcome: row.outcome,
      mode: row.mode,
      postsSeen: row.postsSeen,
      postsNew: row.postsNew,
      pages: row.pages,
      reachedKnownTail: row.reachedKnownTail,
      reason: row.reason,
      postsIngested: countsByVisit.get(row.id) ?? 0,
    }));

    const last = rows.at(-1);
    const nextCursor = last && rows.length === parsed.data.limit ? encodeVisitCursor({ startedAtText: last.startedAtText, id: last.id }) : null;
    return c.json({ visits, nextCursor });
  });

  return app;
}
