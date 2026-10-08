import { createMiddleware } from "hono/factory";
import type { ApiKeyContext } from "./api-key";

const WINDOW_MS = 60_000;
const LIMIT_PER_MIN = 60;

interface Bucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

/** Exposed for tests: clears all rate-limit state. */
export function resetRateLimitState(): void {
  buckets.clear();
}

/**
 * 60 req/min per API key. Must run after `apiKeyAuth` so
 * `c.var.apiKey` is set; keys with no bucket yet start a fresh window.
 */
export function rateLimit() {
  return createMiddleware<{ Variables: { apiKey: ApiKeyContext } }>(async (c, next) => {
    const apiKey = c.get("apiKey");
    if (!apiKey) return next();

    const now = Date.now();
    let bucket = buckets.get(apiKey.id);
    if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
      bucket = { count: 0, windowStart: now };
      buckets.set(apiKey.id, bucket);
    }
    bucket.count++;

    if (bucket.count > LIMIT_PER_MIN) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.windowStart + WINDOW_MS - now) / 1000));
      c.header("Retry-After", String(retryAfterSec));
      return c.json({ error: "rate limited" }, 429);
    }

    await next();
  });
}
