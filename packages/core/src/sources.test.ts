import { describe, expect, test } from "bun:test";
import { healthRequestSchema, ingestRequestSchema, rawPostSchema, serverRawPostSchema, structuredSchema } from "./sources";

function rawPost(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    platformPostId: "p1",
    url: "https://example.com/posts/p1",
    text: "hello",
    media: [],
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

// Code-review finding #6: bound sizes so a hostile/misbehaving key can't
// exhaust memory before ingest even reaches the DB layer.
describe("rawPostSchema / ingestRequestSchema limits (code-review finding #6)", () => {
  test("accepts a well-formed post", () => {
    expect(rawPostSchema.safeParse(rawPost()).success).toBe(true);
  });

  test("rejects text over 20000 chars", () => {
    const result = rawPostSchema.safeParse(rawPost({ text: "a".repeat(20_001) }));
    expect(result.success).toBe(false);
  });

  test("rejects url over 2048 chars", () => {
    const result = rawPostSchema.safeParse(rawPost({ url: `https://example.com/${"a".repeat(2048)}` }));
    expect(result.success).toBe(false);
  });

  test("rejects more than 50 media items", () => {
    const media = Array.from({ length: 51 }, () => ({ type: "image", url: "https://x.com/i.jpg" }));
    const result = rawPostSchema.safeParse(rawPost({ media }));
    expect(result.success).toBe(false);
  });

  test("accepts exactly 50 media items", () => {
    const media = Array.from({ length: 50 }, () => ({ type: "image", url: "https://x.com/i.jpg" }));
    const result = rawPostSchema.safeParse(rawPost({ media }));
    expect(result.success).toBe(true);
  });

  test("rejects an ingest batch of more than 200 posts", () => {
    const posts = Array.from({ length: 201 }, (_, i) => rawPost({ platformPostId: `p${i}` }));
    const result = ingestRequestSchema.safeParse({
      sourceId: "00000000-0000-0000-0000-000000000000",
      posts,
      visitId: "v1",
    });
    expect(result.success).toBe(false);
  });

  test("accepts an ingest batch of exactly 200 posts", () => {
    const posts = Array.from({ length: 200 }, (_, i) => rawPost({ platformPostId: `p${i}` }));
    const result = ingestRequestSchema.safeParse({
      sourceId: "00000000-0000-0000-0000-000000000000",
      posts,
      visitId: "v1",
    });
    expect(result.success).toBe(true);
  });
});

function health(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    sourceId: "00000000-0000-0000-0000-000000000000",
    ok: false,
    visitId: "v1",
    ...overrides,
  };
}

// Bound `reason`/`visitId` for the same reason as the ingest fields above.
describe("healthRequestSchema limits", () => {
  test("accepts a well-formed body", () => {
    expect(healthRequestSchema.safeParse(health({ reason: "http_403" })).success).toBe(true);
  });

  test("rejects reason over 300 chars", () => {
    const result = healthRequestSchema.safeParse(health({ reason: "a".repeat(301) }));
    expect(result.success).toBe(false);
  });

  test("accepts reason of exactly 300 chars", () => {
    const result = healthRequestSchema.safeParse(health({ reason: "a".repeat(300) }));
    expect(result.success).toBe(true);
  });

  test("rejects visitId over 100 chars", () => {
    const result = healthRequestSchema.safeParse(health({ visitId: "a".repeat(101) }));
    expect(result.success).toBe(false);
  });

  test("accepts visitId of exactly 100 chars", () => {
    const result = healthRequestSchema.safeParse(health({ visitId: "a".repeat(100) }));
    expect(result.success).toBe(true);
  });
});

describe("rawPostSchema capture / postedAt", () => {
  test("accepts capture push with an offset ISO postedAt", () => {
    expect(rawPostSchema.safeParse(rawPost({ capture: "push", postedAt: "2026-10-03T10:00:00+07:00" })).success).toBe(true);
    expect(rawPostSchema.safeParse(rawPost({ capture: "push", postedAt: "2026-10-03T10:00:00.000Z" })).success).toBe(true);
  });

  test("accepts payloads without either field", () => {
    expect(rawPostSchema.safeParse(rawPost()).success).toBe(true);
  });

  test("rejects an unknown capture kind and a non-ISO postedAt", () => {
    expect(rawPostSchema.safeParse(rawPost({ capture: "x" })).success).toBe(false);
    expect(rawPostSchema.safeParse(rawPost({ postedAt: "yesterday" })).success).toBe(false);
  });
});

describe("server capture kinds", () => {
  test("rawPostSchema rejects capture api; serverRawPostSchema accepts it with structured", () => {
    expect(rawPostSchema.safeParse(rawPost({ capture: "api" })).success).toBe(false);
    const ok = serverRawPostSchema.safeParse(rawPost({ capture: "api", structured: { intent: "sell", priceVnd: 5, attributes: { make: "Toyota" } } }));
    expect(ok.success).toBe(true);
  });

  test("structuredSchema bounds: non-positive price, > 20 attributes, bad intent", () => {
    expect(structuredSchema.safeParse({ priceVnd: 0 }).success).toBe(false);
    expect(structuredSchema.safeParse({ intent: "other" }).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i]));
    expect(structuredSchema.safeParse({ attributes: many }).success).toBe(false);
    expect(structuredSchema.parse({}).attributes).toEqual({});
  });

  test("rawPostSchema strips an extra structured key", () => {
    const parsed = rawPostSchema.parse(rawPost({ structured: { priceVnd: 1 } }));
    expect("structured" in parsed).toBe(false);
  });
});
