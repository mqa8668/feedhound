import { describe, expect, test } from "bun:test";
import { validateRegex } from "./regex-safe";
import { _resetRegexCacheForTest, _regexCacheStatsForTest, compileCached } from "./regex-cache";

// validator half: nested quantifiers, backreferences, lookaround are
// rejected; a safe pattern compiles and actually matches.
describe("validateRegex", () => {
  test("rejects nested quantifiers (a+)+", () => {
    const result = validateRegex("(a+)+$");
    expect(result.ok).toBe(false);
  });

  test("rejects nested quantifiers (\\w*)*", () => {
    const result = validateRegex("(\\w*)*");
    expect(result.ok).toBe(false);
  });

  test("rejects backreferences", () => {
    const result = validateRegex("(\\w)\\1");
    expect(result.ok).toBe(false);
  });

  test("rejects lookahead", () => {
    const result = validateRegex("(?=x)y");
    expect(result.ok).toBe(false);
  });

  test("rejects lookbehind", () => {
    const result = validateRegex("(?<=x)y");
    expect(result.ok).toBe(false);
  });

  test("rejects negative lookahead/lookbehind", () => {
    expect(validateRegex("(?!x)y").ok).toBe(false);
    expect(validateRegex("(?<!x)y").ok).toBe(false);
  });

  test("rejects source longer than maxLen", () => {
    const result = validateRegex("a".repeat(201));
    expect(result.ok).toBe(false);
  });

  test("rejects invalid regex syntax", () => {
    const result = validateRegex("(unclosed");
    expect(result.ok).toBe(false);
  });

  // Regression: compile failures must never leak raw
  // engine internals (e.g. emscripten wasm error text) to an HTTP client.
  test("compile failure returns a generic reason, never raw engine text", () => {
    const result = validateRegex("(unclosed");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid regex");
      expect(result.reason.toLowerCase()).not.toContain("emscripten");
      expect(result.reason.toLowerCase()).not.toContain("wasm");
    }
  });

  test("accepts a safe pattern and it matches", () => {
    const result = validateRegex("\\bip(hone)? ?1[45]\\b");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.re.test("ban ip 15 gia tot")).toBe(true);
    }
  });

  test("safe pattern with an unrelated non-nested quantifier compiles", () => {
    const result = validateRegex("iphone\\s*\\d+");
    expect(result.ok).toBe(true);
  });

  // Regression (+2): match-time ReDoS via
  // catastrophic backtracking must be impossible regardless of which
  // alphabet the pathological input uses, and validation must reject the
  // pattern (near-)instantly rather than run a slow synchronous probe.
  describe("ReDoS regression (findings 1+2)", () => {
    test("rejects overlapping-alternation-in-quantified-group source quickly, regardless of alphabet", () => {
      const start = performance.now();
      const result = validateRegex("(0|0)+z");
      const elapsed = performance.now() - start;
      expect(result.ok).toBe(false);
      // The old ASCII-only probe let this through in 0 ms and then took
      // ~475 ms to match at match time; validation itself must now be fast.
      expect(elapsed).toBeLessThan(20);
    });

    test("rejects the finding-2 attack pattern near-instantly (no synchronous event-loop stall)", () => {
      const start = performance.now();
      const result = validateRegex("(a|a)+$");
      const elapsed = performance.now() - start;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("overlapping alternation");
      // Previously measured 869 ms of synchronous work inside the API.
      expect(elapsed).toBeLessThan(20);
    });

    test("an accepted pattern the alternation heuristic does not catch is still safe to match at match time (RE2 is linear-time)", () => {
      const result = validateRegex("(a|aa)+$");
      expect(result.ok).toBe(true);
      if (result.ok) {
        const pathological = `${"a".repeat(40)}!`;
        const start = performance.now();
        result.re.test(pathological);
        const elapsed = performance.now() - start;
        expect(elapsed).toBeLessThan(50);
      }
    });
  });

  // Regression: re2-wasm's heap is never reclaimed, so
  // `validateRegex` must share the memoized-by-source cache used by
  // `compileWatch` at match time — otherwise every `WatchIndex.reload()`
  // recompiling an unchanged watch's regex permanently leaks wasm heap.
  describe("shared compile cache", () => {
    test("validating the same source repeatedly does not construct a new pattern each time", () => {
      _resetRegexCacheForTest();
      for (let i = 0; i < 25; i++) validateRegex("iphone\\s*\\d+");
      expect(_regexCacheStatsForTest().distinctConstructed).toBe(1);
    });

    test("distinct-pattern cap fails closed with a generic reason once exhausted", () => {
      _resetRegexCacheForTest();
      let sawRefusal = false;
      for (let i = 0; i < 1600; i++) {
        const r = compileCached(`distinct-${i}-[a-z]+`);
        if (!r.ok) {
          sawRefusal = true;
          expect(r.reason).toBe("invalid regex");
          break;
        }
      }
      expect(sawRefusal).toBe(true);
      // Well under the measured ~2920-construction abort ceiling of a bare
      // re2-wasm loop, so the process never reaches the point of aborting.
      expect(_regexCacheStatsForTest().distinctConstructed).toBeLessThan(2000);
      _resetRegexCacheForTest();
    });

    // Regression: a cache smaller than the distinct-
    // pattern cap evicts entries whose wasm-heap allocation is never freed,
    // so a full reload of unchanged watches past the eviction boundary
    // becomes a 100% miss that burns cap headroom for no reason. The cache
    // size must be at least the cap so no watch can ever be evicted while
    // its pattern still counts against the cap.
    test("cache holds at least as many entries as the distinct-pattern cap", () => {
      _resetRegexCacheForTest();
      const cap = 1500;
      for (let i = 0; i < cap; i++) {
        const r = compileCached(`cache-size-${i}-[a-z]+`);
        expect(r.ok).toBe(true);
      }
      const stats = _regexCacheStatsForTest();
      expect(stats.distinctConstructed).toBe(cap);
      expect(stats.size).toBeGreaterThanOrEqual(cap);
      _resetRegexCacheForTest();
    });
  });
});
