import { declaredSchemas, resolvePriceBounds, resolveSchema } from "@feedhound/core/attributes";
import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { and, eq, ilike, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { cfAccessAuth, type Session } from "../middleware/cf-access";
import { requireSession } from "../middleware/session";

const DEFAULT_LIMIT = 20;

/** `GET /api/categories`, `GET /api/catalog-items` (any session). */
export function pickersRoute(handle: DbHandle): Hono<{ Variables: { session: Session } }> {
  const app = new Hono<{ Variables: { session: Session } }>();

  app.get("/api/categories", cfAccessAuth(handle), requireSession(), async (c) => {
    const rows = await handle.db
      .select({
        id: schema.category.id,
        parentId: schema.category.parentId,
        slug: schema.category.slug,
        name: schema.category.name,
        path: schema.category.path,
        attributeSchema: schema.category.attributeSchema,
        priceMinVnd: schema.category.priceMinVnd,
        priceMaxVnd: schema.category.priceMaxVnd,
      })
      .from(schema.category);
    // Schemas and price bounds are inherited from the nearest ancestor that declares them.
    const tree = new Map(rows.map((r) => [r.id, r.path]));
    const declared = declaredSchemas(rows);
    const bounds = new Map(rows.map((r) => [r.id, { min: r.priceMinVnd, max: r.priceMaxVnd }]));
    const categories = rows.map(({ attributeSchema: _a, priceMinVnd: _min, priceMaxVnd: _max, ...r }) => ({
      ...r,
      attributeSchema: resolveSchema(r.id, tree, declared),
      priceBounds: resolvePriceBounds(r.id, tree, bounds),
    }));
    return c.json({ categories });
  });

  app.get("/api/catalog-items", cfAccessAuth(handle), requireSession(), async (c) => {
    const q = c.req.query("q");
    const categoryId = c.req.query("categoryId");
    const limitRaw = Number(c.req.query("limit") ?? DEFAULT_LIMIT);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : DEFAULT_LIMIT;

    const clauses = [];
    if (q) clauses.push(ilike(schema.catalogItem.name, `%${q}%`));
    if (categoryId) clauses.push(eq(schema.catalogItem.categoryId, categoryId));
    const idsRaw = c.req.query("ids");
    if (idsRaw !== undefined) {
      const parsed = z.array(z.string().uuid()).max(100).safeParse(idsRaw.split(",").filter((x) => x.length > 0));
      if (!parsed.success) return c.json({ error: "invalid_ids" }, 422);
      if (parsed.data.length === 0) return c.json({ items: [] });
      clauses.push(inArray(schema.catalogItem.id, parsed.data));
    }

    const rows = await handle.db
      .select()
      .from(schema.catalogItem)
      .where(clauses.length > 0 ? and(...clauses) : undefined)
      .limit(limit);
    return c.json({ items: rows });
  });

  return app;
}
