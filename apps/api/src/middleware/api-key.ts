import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { and, eq, isNull } from "drizzle-orm";
import { createMiddleware } from "hono/factory";

export interface ApiKeyContext {
  id: string;
  userId: string;
  scopes: string[];
  sourceIds: string[];
}

const LAST_USED_DEBOUNCE_MS = 60_000;
const lastTouched = new Map<string, number>();

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export type ApiKeyAuthResult = { ok: true; context: ApiKeyContext } | { ok: false; status: 401 | 403; message: string };

/**
 * Bearer-token lookup shared by the `apiKeyAuth` middleware and routes that
 * accept either a session or an api key on the same path (e.g. `/api/sources`,
 * `/api/watches`). Returns a discriminated result instead of writing a
 * response, so callers can fall back to another auth method first.
 */
export async function authenticateApiKey(token: string | undefined, requiredScopes: string[], handle: DbHandle): Promise<ApiKeyAuthResult> {
  if (!token) return { ok: false, status: 401, message: "missing api key" };

  const prefix = token.slice(0, 8);
  const hash = await sha256Hex(token);

  const rows = await handle.db
    .select()
    .from(schema.apiKey)
    .where(and(eq(schema.apiKey.prefix, prefix), eq(schema.apiKey.hash, hash), isNull(schema.apiKey.revokedAt)))
    .limit(1);
  const row = rows[0];
  if (!row) return { ok: false, status: 401, message: "invalid api key" };

  if (!requiredScopes.every((scope) => row.scopes.includes(scope))) {
    return { ok: false, status: 403, message: "insufficient scope" };
  }

  const sourceRows = await handle.db
    .select({ id: schema.source.id })
    .from(schema.source)
    .where(eq(schema.source.assignedKeyId, row.id));

  touchLastUsed(handle, row.id);

  return {
    ok: true,
    context: { id: row.id, userId: row.userId, scopes: row.scopes, sourceIds: sourceRows.map((r) => r.id) },
  };
}

/** `Authorization: Bearer <key>` -> `c.var.apiKey`. Missing/invalid key -> 401; missing scope -> 403. */
export function apiKeyAuth(requiredScopes: string[], handle: DbHandle) {
  return createMiddleware<{ Variables: { apiKey: ApiKeyContext } }>(async (c, next) => {
    const header = c.req.header("Authorization");
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : undefined;
    const result = await authenticateApiKey(token, requiredScopes, handle);
    if (!result.ok) return c.json({ error: result.message }, result.status);
    c.set("apiKey", result.context);
    await next();
  });
}

function touchLastUsed(handle: DbHandle, id: string): void {
  const now = Date.now();
  const last = lastTouched.get(id) ?? 0;
  if (now - last < LAST_USED_DEBOUNCE_MS) return;
  lastTouched.set(id, now);
  void (async () => {
    try {
      await handle.db.update(schema.apiKey).set({ lastUsedAt: new Date() }).where(eq(schema.apiKey.id, id));
    } catch {
      // best-effort; do not fail the request on a lastUsedAt update failure
    }
  })();
}
