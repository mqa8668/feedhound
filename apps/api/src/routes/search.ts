import { createLogger } from "@feedhound/core/logger";
import { savedSearchParamsSchema, searchParamsFromQuery, searchParamsToWatch, type SearchParams } from "@feedhound/core/search-query";
import { watchInputSchema } from "@feedhound/core/watch";
import { DEFAULT_SEARCH_CONFIG, loadPiiSalt, schema, searchPosts, type DbHandle, type SearchConfig } from "@feedhound/db";
import { desc, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { cfAccessAuth, type Session } from "../middleware/cf-access";
import { requireRole, requireSession } from "../middleware/session";
import { CSV_BOM, csvHeader, csvRow, exportFilename } from "../services/export-csv";
import { teamSourceIds } from "../services/scope";
import { createWatch } from "./watches";

const logger = createLogger({ service: "api" });

const EXPORT_PAGE = 1000;
const DEFAULT_PAGE_LIMIT_MAX = 100;

const CONFIG_KEYS = [
  "search.candidateLimit",
  "search.pageLimitMax",
  "search.exportMaxRows",
  "search.recencyWeight",
  "search.recencyTauDays",
  "search.trgmMinLen",
] as const;

export interface SearchRuntimeConfig extends SearchConfig {
  pageLimitMax: number;
}

/** Latest Config values for the `search.*` keys, falling back to the built-in defaults. */
export async function loadSearchConfig(handle: DbHandle): Promise<SearchRuntimeConfig> {
  const rows = await handle.db
    .select({ key: schema.config.key, value: schema.config.value })
    .from(schema.config)
    .where(inArray(schema.config.key, [...CONFIG_KEYS]))
    .orderBy(desc(schema.config.version));
  const latest = new Map<string, unknown>();
  for (const r of rows) if (!latest.has(r.key)) latest.set(r.key, r.value);
  const num = (key: (typeof CONFIG_KEYS)[number], fallback: number): number => {
    const v = latest.get(key);
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
  };
  return {
    candidateLimit: num("search.candidateLimit", DEFAULT_SEARCH_CONFIG.candidateLimit),
    exportMaxRows: num("search.exportMaxRows", DEFAULT_SEARCH_CONFIG.exportMaxRows),
    recencyWeight: num("search.recencyWeight", DEFAULT_SEARCH_CONFIG.recencyWeight),
    recencyTauDays: num("search.recencyTauDays", DEFAULT_SEARCH_CONFIG.recencyTauDays),
    trgmMinLen: num("search.trgmMinLen", DEFAULT_SEARCH_CONFIG.trgmMinLen),
    pageLimitMax: num("search.pageLimitMax", DEFAULT_PAGE_LIMIT_MAX),
  };
}

const watchBodySchema = z.object({
  params: savedSearchParamsSchema,
  name: z.string().min(1).max(60),
  notifierIds: z.array(z.string().uuid()).max(50).default([]),
});

/** Users with an export running (one at a time per user). */
const exportsInProgress = new Set<string>();

type Env = { Variables: { session: Session } };

/** `GET /api/search`, `GET /api/search/export.csv`, `POST /api/search/watch`. Team-scoped. */
export function searchRoute(handle: DbHandle): Hono<Env> {
  const app = new Hono<Env>();

  function parseParams(raw: Record<string, string[]>, cfg: SearchRuntimeConfig): { ok: true; params: SearchParams } | { ok: false; issues: unknown } {
    const parsed = searchParamsFromQuery(raw);
    if (!parsed.success) return { ok: false, issues: parsed.error.issues };
    if (parsed.data.limit > cfg.pageLimitMax) return { ok: false, issues: [{ path: ["limit"], message: `limit must be <= ${cfg.pageLimitMax}` }] };
    return { ok: true, params: parsed.data };
  }

  app.get("/api/search", cfAccessAuth(handle), requireSession(), async (c) => {
    const session = c.get("session");
    const cfg = await loadSearchConfig(handle);
    const parsed = parseParams(c.req.queries(), cfg);
    if (!parsed.ok) return c.json({ error: "validation", message: "invalid query", issues: parsed.issues }, 400);
    const result = await searchPosts(handle, parsed.params, session.teamId, cfg);
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json(result.page);
  });

  app.get("/api/search/export.csv", cfAccessAuth(handle), requireSession(), requireRole("operator"), async (c) => {
    const session = c.get("session");
    const cfg = await loadSearchConfig(handle);
    const parsed = parseParams(c.req.queries(), cfg);
    if (!parsed.ok) return c.json({ error: "validation", message: "invalid query", issues: parsed.issues }, 400);
    if (exportsInProgress.has(session.userId)) return c.json({ error: "export_in_progress" }, 429);
    exportsInProgress.add(session.userId);
    const salt = await loadPiiSalt(handle);
    let streaming = false;
    try {
      const base: SearchParams = { ...parsed.params, cursor: undefined, limit: EXPORT_PAGE };
      const first = await searchPosts(handle, base, session.teamId, cfg, { full: true });
      if (!first.ok) return c.json({ error: first.error }, 400);
      const truncated = first.page.total > cfg.exportMaxRows;
      const encoder = new TextEncoder();
      let page = first.page;
      let sent = 0;
      let started = false;
      const release = (): void => {
        exportsInProgress.delete(session.userId);
        logger.info({ userId: session.userId, params: { ...parsed.params, cursor: undefined }, rows: sent, truncated }, "corpus export");
      };
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            let out = "";
            if (!started) {
              started = true;
              out += CSV_BOM + csvHeader();
            }
            for (const hit of page.items) {
              if (sent >= cfg.exportMaxRows) break;
              out += csvRow(hit, salt);
              sent++;
            }
            controller.enqueue(encoder.encode(out));
            if (sent >= cfg.exportMaxRows || !page.nextCursor) {
              release();
              controller.close();
              return;
            }
            const next = await searchPosts(handle, { ...base, cursor: page.nextCursor }, session.teamId, cfg, { full: true });
            if (!next.ok) throw new Error(next.error);
            page = next.page;
          } catch (err) {
            release();
            controller.error(err);
          }
        },
        cancel() {
          release();
        },
      });
      streaming = true;
      return new Response(stream, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${exportFilename(new Date())}"`,
          "X-Export-Truncated": truncated ? "true" : "false",
        },
      });
    } finally {
      if (!streaming) exportsInProgress.delete(session.userId);
    }
  });

  app.post("/api/search/watch", cfAccessAuth(handle), requireSession(), async (c) => {
    const session = c.get("session");
    const json: unknown = await c.req.json().catch(() => undefined);
    const body = watchBodySchema.safeParse(json);
    if (!body.success) return c.json({ error: "validation", message: "invalid body", issues: body.error.issues }, 400);
    const { params, name, notifierIds } = body.data;

    if (params.sourceIds?.length) {
      const own = new Set(await teamSourceIds(handle, session.teamId));
      if (params.sourceIds.some((id) => !own.has(id))) {
        return c.json({ error: "validation", message: "one or more sourceIds are not in your team", field: "sourceIds" }, 400);
      }
    }
    const mapped = searchParamsToWatch(params);
    if (!mapped.ok) return c.json({ error: "validation", message: mapped.reason }, 400);
    const input = watchInputSchema.safeParse({ ...mapped.watch, name, notifierIds, enabled: true, include: [] });
    if (!input.success) {
      const issue = input.error.issues[0];
      return c.json({ error: "validation", message: issue?.message ?? "invalid watch", field: issue?.path.join(".") || undefined }, 400);
    }
    const created = await createWatch(handle, { userId: session.userId, teamId: session.teamId, role: session.role }, input.data);
    if (!created.ok) return c.json({ error: "validation", message: created.body.reason ?? "invalid watch", field: created.body.field }, 400);
    return c.json({ watchId: created.row.id, dropped: mapped.dropped }, 201);
  });

  return app;
}
