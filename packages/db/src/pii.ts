import { authorKey } from "@feedhound/core/normalize";
import { authorRef } from "@feedhound/core/pii";
import { eq } from "drizzle-orm";
import type { DbHandle } from "./index";
import * as schema from "./schema/index";

// Deployment salt for author pseudonyms and the ref -> raw author lookup.

const SALT_NAME = "pii_salt";
const saltCache = new WeakMap<DbHandle, string>();

/** The deployment's pseudonym salt (migration 0038 seeds it). Cached per handle; throws when missing. */
export async function loadPiiSalt(handle: DbHandle): Promise<string> {
  const hit = saltCache.get(handle);
  if (hit !== undefined) return hit;
  const [row] = await handle.db.select({ value: schema.appSecret.value }).from(schema.appSecret).where(eq(schema.appSecret.name, SALT_NAME)).limit(1);
  if (!row) throw new Error("app_secret.pii_salt is missing (run migrations)");
  saltCache.set(handle, row.value);
  return row.value;
}

/**
 * Raw author ids / names of the team's posts whose pseudonym is `ref`. A post with an author id is identified by
 * the id alone; only id-less posts match by name (mirrors `authorKey`).
 */
export async function resolveAuthorRef(handle: DbHandle, teamId: string, salt: string, ref: string): Promise<{ ids: string[]; names: string[] }> {
  const rows = await handle.sql<{ author_id: string | null; author_name: string | null }[]>`
    SELECT DISTINCT p.author_id, p.author_name
    FROM post p
    WHERE p.source_id IN (SELECT s.id FROM source s WHERE s.team_id = ${teamId}::uuid)
      AND (p.author_id IS NOT NULL OR p.author_name IS NOT NULL)`;
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const r of rows) {
    if (authorRef(salt, authorKey({ authorId: r.author_id, authorName: r.author_name })) !== ref) continue;
    if (r.author_id) ids.add(r.author_id);
    else if (r.author_name) names.add(r.author_name);
  }
  return { ids: [...ids], names: [...names] };
}
