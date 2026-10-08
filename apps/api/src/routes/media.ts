import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { cfAccessAuth, type Session } from "../middleware/cf-access";
import { requireSession } from "../middleware/session";

const uuidSchema = z.string().uuid();

/** A relative MEDIA_DIR resolves against the repo root, not the per-app dev cwd (agent writes, api reads). */
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const mediaDir = (): string => resolve(REPO_ROOT, process.env.MEDIA_DIR ?? "./data/media");

/** Mirrors the agent's `thumbPath`; the path is built only from a parsed uuid. */
function thumbFile(mediaDir: string, postId: string): string {
  return join(mediaDir, "thumbs", postId.slice(0, 2), `${postId}.webp`);
}

/**
 * `GET /api/media/:postId/thumb` serves the cached webp thumbnail (api mounts `MEDIA_DIR` read-only).
 * Non-uuid ids, other teams' posts and missing files are all 404.
 */
export function mediaRoute(handle: DbHandle): Hono<{ Variables: { session: Session } }> {
  const app = new Hono<{ Variables: { session: Session } }>();

  app.get("/api/media/:postId/thumb", cfAccessAuth(handle), requireSession(), async (c) => {
    const session = c.get("session");
    const parsed = uuidSchema.safeParse(c.req.param("postId"));
    if (!parsed.success) return c.json({ error: "not_found" }, 404);
    const id = parsed.data.toLowerCase();

    const [row] = await handle.db
      .select({ id: schema.post.id })
      .from(schema.post)
      .innerJoin(schema.source, eq(schema.source.id, schema.post.sourceId))
      .where(and(eq(schema.post.id, id), eq(schema.source.teamId, session.teamId)))
      .limit(1);
    if (!row) return c.json({ error: "not_found" }, 404);

    const path = thumbFile(mediaDir(), id);
    let size: number;
    let mtimeMs: number;
    try {
      const info = await stat(path);
      size = info.size;
      mtimeMs = info.mtimeMs;
    } catch {
      return c.json({ error: "not_found" }, 404);
    }
    const etag = `"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
    const headers = { "Cache-Control": "private, max-age=31536000, immutable", ETag: etag };
    if (c.req.header("if-none-match") === etag) return new Response(null, { status: 304, headers });
    let body: Buffer;
    try {
      body = await readFile(path);
    } catch {
      return c.json({ error: "not_found" }, 404);
    }
    return new Response(new Uint8Array(body), { status: 200, headers: { ...headers, "Content-Type": "image/webp" } });
  });

  return app;
}
