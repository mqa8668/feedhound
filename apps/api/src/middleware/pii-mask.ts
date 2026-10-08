import { authorKey } from "@feedhound/core/normalize";
import { authorLabel, authorRef, maskPii } from "@feedhound/core/pii";
import { loadPiiSalt, type DbHandle } from "@feedhound/db";
import type { MiddlewareHandler } from "hono";

// Every JSON body under /api/* is masked server-side before it leaves the process.

const TEXT_KEYS = new Set(["text", "title", "displayTitle", "snippet", "excerpt", "postTitle", "line", "plain", "headline"]);
const DROP_KEYS = new Set(["raw", "phone"]);

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Pure walk: masks free-text fields, pseudonymises authors, drops `raw` / `phone`. Input is not mutated. */
export function maskJson(value: unknown, salt: string): unknown {
  if (Array.isArray(value)) return value.map((v) => maskJson(v, salt));
  if (value === null || typeof value !== "object") return value;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (DROP_KEYS.has(k)) continue;
    if (TEXT_KEYS.has(k) && typeof v === "string") out[k] = maskPii(v, { html: k === "snippet" });
    else out[k] = maskJson(v, salt);
  }
  if ("authorName" in src || "authorId" in src) {
    const ref = authorRef(salt, authorKey({ authorId: str(src.authorId), authorName: str(src.authorName) }));
    out.authorRef = ref;
    out.authorName = authorLabel(ref);
    delete out.authorId;
  }
  if (typeof src.authorKey === "string") {
    const ref = authorRef(salt, src.authorKey);
    out.authorKey = ref ?? "";
    out.name = authorLabel(ref);
  }
  return out;
}

/** Rewrites `application/json` responses of the routes it is mounted on; status and headers are kept. */
export function piiMask(handle: DbHandle): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const res = c.res;
    if (!(res.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return;
    const body = await res.text();
    if (body === "") {
      c.res = new Response(body, res);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      c.res = new Response(body, res);
      return;
    }
    const masked = JSON.stringify(maskJson(parsed, await loadPiiSalt(handle)));
    const headers = new Headers(res.headers);
    headers.set("content-length", String(new TextEncoder().encode(masked).length));
    c.res = new Response(masked, { status: res.status, statusText: res.statusText, headers });
  };
}
