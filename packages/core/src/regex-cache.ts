// Shared RE2 compile cache.
//
// `re2-wasm`'s wasm module has a fixed 16 MB heap with memory growth
// disabled and `RE2` instances expose no `delete()` — every `new RE2(...)`
// permanently consumes heap that is never reclaimed by the GC or by us.
// Measured empirically (this dev machine, bun 1.4.2): constructing plain
// `new RE2("iphone", "iu")` in a loop aborts at the 2920th construction with
// `RuntimeError: abort(Cannot enlarge memory arrays...)`, and every
// subsequent construction in the process throws the same error forever.
//
// `WatchIndex.reload()` (apps/agent/src/watch-index.ts) recompiles every
// enabled watch's `regex` field on every reload (every `match.reloadDebounceMs`
// after a `watch_changed` notification, and every `match.reloadIntervalSec`
// as a fallback) — with unchanged watches that means the *same* pattern
// source is compiled again and again, burning irreplaceable wasm heap for no
// reason. This module memoizes compiled patterns by `(flags, source)` so an
// unchanged watch across reloads allocates nothing, and enforces a hard cap
// on the number of *distinct* patterns ever constructed in this process
// (comfortably below the measured ~2920 abort ceiling) so a burst of novel
// patterns fails closed with a normal error instead of bricking the process
// for every watch, forever.
import { RE2 } from "re2-wasm";
import { createLogger } from "./logger";

const log = createLogger({ service: "regex-cache" });

/** Minimal surface `matchPost` needs; satisfied by both `RE2` and `RegExp`. */
export interface SafeRegex {
  test(s: string): boolean;
  readonly source: string;
}

export type CompileCachedResult = { ok: true; re: SafeRegex } | { ok: false; reason: string };

/** Hard cap on distinct `new RE2(...)` constructions for the process
 * lifetime, set well under the measured ~2920-construction abort ceiling so
 * there is headroom left for whatever else in the process may compile
 * regexes (tests, other watches) before the cap is hit. Once reached, every
 * novel pattern fails closed (generic error) instead of risking the abort. */
const MAX_DISTINCT_PATTERNS = 1500;

/** Bounded so the cache itself never grows without limit; entries evicted
 * here are simply forgotten (the underlying RE2 instance is not, and cannot
 * be, freed — see module doc) so this is a cache-size bound, not a memory
 * reclamation mechanism.
 *
 * Eviction frees no wasm heap, so a cache smaller than
 * `MAX_DISTINCT_PATTERNS` is strictly harmful — once distinct patterns
 * exceed the cache size, every `WatchIndex.reload()` of unchanged watches
 * past the eviction boundary is a 100% cache miss, each miss burns one more
 * irreplaceable distinct-pattern slot, and the process reaches
 * `MAX_DISTINCT_PATTERNS` (and starts refusing to compile, degrading every
 * regex watch to NEVER_MATCHES) far sooner than the cap alone implies.
 * Setting this equal to the cap makes that failure mode structurally
 * impossible: no watch can ever be evicted while its distinct pattern is
 * still counted against the cap, so a full reload of unchanged watches is
 * always a 100% cache hit. Derived from `MAX_DISTINCT_PATTERNS` so the two
 * cannot drift apart. */
const CACHE_MAX_ENTRIES = MAX_DISTINCT_PATTERNS;

const cache = new Map<string, SafeRegex>(); // Map iteration order == insertion order, used as LRU order.
let distinctConstructed = 0;
let capReached = false;

function cacheKey(src: string, flags: string): string {
  return `${flags}${src}`;
}

function touch(key: string, re: SafeRegex): void {
  cache.delete(key);
  cache.set(key, re);
}

/**
 * Compiles `src` with `flags` (default `"iu"`, matching the watch
 * matcher) through the shared cache. Cache hit: no wasm allocation. Cache
 * miss under the distinct-pattern cap: constructs and caches a new `RE2`.
 * Cache miss at/over the cap: refuses to compile, logs at error level, and
 * returns a generic reason — never the raw engine error text, which can
 * contain emscripten internals unsuitable for an HTTP client.
 */
export function compileCached(src: string, flags = "iu"): CompileCachedResult {
  const key = cacheKey(src, flags);
  const hit = cache.get(key);
  if (hit) {
    touch(key, hit);
    return { ok: true, re: hit };
  }

  if (capReached || distinctConstructed >= MAX_DISTINCT_PATTERNS) {
    capReached = true;
    log.error({ distinctConstructed, cap: MAX_DISTINCT_PATTERNS }, "regex-cache: distinct pattern cap reached, refusing to compile");
    return { ok: false, reason: "invalid regex" };
  }

  let re: RE2;
  try {
    re = new RE2(src, flags);
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err), src }, "regex-cache: compile failed");
    return { ok: false, reason: "invalid regex" };
  }

  distinctConstructed++;
  cache.set(key, re);
  if (cache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  return { ok: true, re };
}

/** Test-only: resets cache/counters so tests measuring the cap don't
 * interfere with each other or with normal application code sharing the
 * same module instance. */
export function _resetRegexCacheForTest(): void {
  cache.clear();
  distinctConstructed = 0;
  capReached = false;
}

/** Test-only: introspection for cap/cache-hit assertions. */
export function _regexCacheStatsForTest(): { size: number; distinctConstructed: number; capReached: boolean } {
  return { size: cache.size, distinctConstructed, capReached };
}
