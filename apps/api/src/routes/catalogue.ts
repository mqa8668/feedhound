import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { and, eq, ilike, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { apiKeyAuth, type ApiKeyContext } from "../middleware/api-key";

const DEFAULT_LIMIT = 20;

interface CategoryNode {
  id: string;
  parentId: string | null;
  slug: string;
  name: string;
  children: CategoryNode[];
}

function buildTree(rows: { id: string; parentId: string | null; slug: string; name: string }[]): CategoryNode[] {
  const nodes = new Map<string, CategoryNode>();
  for (const r of rows) nodes.set(r.id, { id: r.id, parentId: r.parentId, slug: r.slug, name: r.name, children: [] });
  const roots: CategoryNode[] = [];
  for (const node of nodes.values()) {
    if (node.parentId && nodes.has(node.parentId)) {
      nodes.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

const createCategorySchema = z.object({
  parentId: z.string().uuid().nullable().optional(),
  slug: z.string().min(1),
  name: z.string().min(1),
});

const patchCategorySchema = z.object({
  parentId: z.string().uuid().nullable().optional(),
  slug: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
});

const createItemSchema = z.object({
  categoryId: z.string().uuid(),
  name: z.string().min(1),
  aliases: z.array(z.string().min(1)).default([]),
  attributes: z.record(z.string(), z.unknown()).optional(),
});

const patchItemSchema = z.object({
  categoryId: z.string().uuid().optional(),
  name: z.string().min(1).optional(),
  aliases: z.array(z.string().min(1)).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
});

async function isOperator(handle: DbHandle, apiKey: ApiKeyContext): Promise<boolean> {
  const [row] = await handle.db.select({ role: schema.user.role }).from(schema.user).where(eq(schema.user.id, apiKey.userId)).limit(1);
  return row?.role === "operator";
}

/** "Any catalogue write -> NOTIFY catalogue_changed". */
async function notifyCatalogueChanged(handle: DbHandle): Promise<void> {
  await handle.sql.notify("catalogue_changed", "1");
}

async function itemReferenced(handle: DbHandle, itemId: string): Promise<boolean> {
  const [enrichRow] = await handle.db
    .select({ postId: schema.enrichment.postId })
    .from(schema.enrichment)
    .where(eq(schema.enrichment.itemId, itemId))
    .limit(1);
  if (enrichRow) return true;
  const [watchRow] = await handle.db
    .select({ id: schema.watch.id })
    .from(schema.watch)
    .where(sql`${itemId} = any(${schema.watch.itemIds})`)
    .limit(1);
  return watchRow !== undefined;
}

/** `/api/catalogue/{categories,items}` CRUD (`Bearer <apiKey>`). */
export function catalogueRoute(handle: DbHandle): Hono<{ Variables: { apiKey: ApiKeyContext } }> {
  const app = new Hono<{ Variables: { apiKey: ApiKeyContext } }>();

  app.get("/api/catalogue/categories", apiKeyAuth(["catalogue:read"], handle), async (c) => {
    const rows = await handle.db
      .select({ id: schema.category.id, parentId: schema.category.parentId, slug: schema.category.slug, name: schema.category.name })
      .from(schema.category);
    return c.json({ categories: buildTree(rows) });
  });

  app.post("/api/catalogue/categories", apiKeyAuth(["catalogue:write"], handle), async (c) => {
    const apiKey = c.get("apiKey");
    if (!(await isOperator(handle, apiKey))) return c.json({ error: "forbidden", message: "operator role required" }, 403);

    const json: unknown = await c.req.json().catch(() => undefined);
    const parsed = createCategorySchema.safeParse(json);
    if (!parsed.success) return c.json({ error: "validation", issues: parsed.error.issues }, 400);

    let parentPath = "";
    if (parsed.data.parentId) {
      const [parent] = await handle.db.select({ path: schema.category.path }).from(schema.category).where(eq(schema.category.id, parsed.data.parentId)).limit(1);
      if (!parent) return c.json({ error: "validation", message: "parentId does not exist" }, 400);
      parentPath = parent.path;
    }
    const path = parentPath ? `${parentPath}.${parsed.data.slug.replaceAll("-", "_")}` : parsed.data.slug.replaceAll("-", "_");

    const [row] = await handle.db
      .insert(schema.category)
      .values({ parentId: parsed.data.parentId ?? null, slug: parsed.data.slug, name: parsed.data.name, path })
      .returning();
    await notifyCatalogueChanged(handle);
    return c.json({ category: row }, 201);
  });

  app.patch("/api/catalogue/categories/:id", apiKeyAuth(["catalogue:write"], handle), async (c) => {
    const apiKey = c.get("apiKey");
    if (!(await isOperator(handle, apiKey))) return c.json({ error: "forbidden", message: "operator role required" }, 403);

    const id = c.req.param("id");
    const json: unknown = await c.req.json().catch(() => undefined);
    const parsed = patchCategorySchema.safeParse(json);
    if (!parsed.success) return c.json({ error: "validation", issues: parsed.error.issues }, 400);

    const [existing] = await handle.db.select().from(schema.category).where(eq(schema.category.id, id)).limit(1);
    if (!existing) return c.json({ error: "not_found" }, 404);

    const slug = parsed.data.slug ?? existing.slug;
    const parentId = parsed.data.parentId === undefined ? existing.parentId : parsed.data.parentId;

    // Minor: PATCH .../:id { parentId: <own id> } (or any descendant) would
    // otherwise re-point a node's `path` under itself, making the whole
    // subtree unreachable from the real root. Reject self- and
    // cycle-parenting outright.
    if (parentId === id) return c.json({ error: "validation", message: "parentId cannot be the category itself" }, 400);

    let parentPath = "";
    if (parentId) {
      const [parent] = await handle.db.select({ path: schema.category.path }).from(schema.category).where(eq(schema.category.id, parentId)).limit(1);
      if (!parent) return c.json({ error: "validation", message: "parentId does not exist" }, 400);
      if (parent.path === existing.path || parent.path.startsWith(`${existing.path}.`)) {
        return c.json({ error: "validation", message: "parentId cannot be a descendant of the category" }, 400);
      }
      parentPath = parent.path;
    }
    const path = parentPath ? `${parentPath}.${slug.replaceAll("-", "_")}` : slug.replaceAll("-", "_");

    const [row] = await handle.db
      .update(schema.category)
      .set({ parentId, slug, name: parsed.data.name ?? existing.name, path })
      .where(eq(schema.category.id, id))
      .returning();
    await notifyCatalogueChanged(handle);
    return c.json({ category: row });
  });

  app.get("/api/catalogue/items", apiKeyAuth(["catalogue:read"], handle), async (c) => {
    const categoryId = c.req.query("categoryId");
    const q = c.req.query("q");
    const limitRaw = Number(c.req.query("limit") ?? DEFAULT_LIMIT);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : DEFAULT_LIMIT;
    const cursor = c.req.query("cursor");

    const clauses = [];
    if (categoryId) clauses.push(eq(schema.catalogItem.categoryId, categoryId));
    if (q) clauses.push(ilike(schema.catalogItem.name, `%${q}%`));
    if (cursor) clauses.push(sql`${schema.catalogItem.id} > ${cursor}`);

    const rows = await handle.db
      .select()
      .from(schema.catalogItem)
      .where(clauses.length > 0 ? and(...clauses) : undefined)
      .orderBy(schema.catalogItem.id)
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;
    return c.json({ items, nextCursor });
  });

  app.post("/api/catalogue/items", apiKeyAuth(["catalogue:write"], handle), async (c) => {
    const json: unknown = await c.req.json().catch(() => undefined);
    const parsed = createItemSchema.safeParse(json);
    if (!parsed.success) return c.json({ error: "validation", issues: parsed.error.issues }, 400);

    const [category] = await handle.db.select({ id: schema.category.id }).from(schema.category).where(eq(schema.category.id, parsed.data.categoryId)).limit(1);
    if (!category) return c.json({ error: "validation", message: "categoryId does not exist" }, 400);

    const [row] = await handle.db
      .insert(schema.catalogItem)
      .values({ categoryId: parsed.data.categoryId, name: parsed.data.name, aliases: parsed.data.aliases, attributes: parsed.data.attributes ?? {} })
      .returning();
    await notifyCatalogueChanged(handle);
    return c.json({ item: row }, 201);
  });

  app.patch("/api/catalogue/items/:id", apiKeyAuth(["catalogue:write"], handle), async (c) => {
    const id = c.req.param("id");
    const json: unknown = await c.req.json().catch(() => undefined);
    const parsed = patchItemSchema.safeParse(json);
    if (!parsed.success) return c.json({ error: "validation", issues: parsed.error.issues }, 400);

    const [existing] = await handle.db.select().from(schema.catalogItem).where(eq(schema.catalogItem.id, id)).limit(1);
    if (!existing) return c.json({ error: "not_found" }, 404);

    const [row] = await handle.db
      .update(schema.catalogItem)
      .set({
        categoryId: parsed.data.categoryId ?? existing.categoryId,
        name: parsed.data.name ?? existing.name,
        aliases: parsed.data.aliases ?? existing.aliases,
        attributes: (parsed.data.attributes ?? existing.attributes) as Record<string, unknown>,
      })
      .where(eq(schema.catalogItem.id, id))
      .returning();
    await notifyCatalogueChanged(handle);
    return c.json({ item: row });
  });

  app.delete("/api/catalogue/items/:id", apiKeyAuth(["catalogue:write"], handle), async (c) => {
    const id = c.req.param("id");
    const [existing] = await handle.db.select({ id: schema.catalogItem.id }).from(schema.catalogItem).where(eq(schema.catalogItem.id, id)).limit(1);
    if (!existing) return c.json({ error: "not_found" }, 404);

    if (await itemReferenced(handle, id)) {
      return c.json({ error: "conflict", message: "item is referenced by an Enrichment or Watch" }, 409);
    }

    await handle.db.delete(schema.catalogItem).where(eq(schema.catalogItem.id, id));
    await notifyCatalogueChanged(handle);
    return c.body(null, 204);
  });

  return app;
}
