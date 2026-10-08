import { z } from "zod";

// Bounds on ingest payloads (code-review finding #6): keep a single
// `/api/ingest` call small enough to process synchronously and cheap enough
// that a hostile/misbehaving key can't exhaust memory or disk.
const MAX_TEXT_LEN = 20_000;
const MAX_URL_LEN = 2048;
const MAX_SHORT_STR_LEN = 300;
const MAX_MEDIA_ITEMS = 50;
const MAX_POSTS_PER_BATCH = 200;

/** How a post reached the pipeline: pushed through `/api/ingest`. Server-side polling writes `api` (see SERVER_CAPTURE_KINDS). */
export const CAPTURE_KINDS = ["push"] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];

/** One raw post as pushed by a client or mapped by a connector. */
export const rawPostSchema = z.object({
  platformPostId: z.string().min(1).max(MAX_SHORT_STR_LEN),
  url: z.string().min(1).max(MAX_URL_LEN),
  authorName: z.string().max(MAX_SHORT_STR_LEN).optional(),
  authorId: z.string().max(MAX_SHORT_STR_LEN).optional(),
  text: z.string().max(MAX_TEXT_LEN),
  media: z
    .array(z.object({ type: z.string().max(MAX_SHORT_STR_LEN), url: z.string().max(MAX_URL_LEN) }))
    .max(MAX_MEDIA_ITEMS)
    .default([]),
  engagement: z
    .object({
      reactions: z.number().optional(),
      comments: z.number().optional(),
      shares: z.number().optional(),
    })
    .optional(),
  postedAtText: z.string().max(MAX_SHORT_STR_LEN).optional(),
  capturedAt: z.string().max(MAX_SHORT_STR_LEN),
  capture: z.enum(CAPTURE_KINDS).optional(),
  postedAt: z.iso.datetime({ offset: true }).optional(),
});

export type RawPost = z.infer<typeof rawPostSchema>;

/** Capture kinds only the server-side collectors may write; `/api/ingest` still rejects `api`. */
export const SERVER_CAPTURE_KINDS = ["push", "api"] as const;

/** Structured hints from a site API: consumed by enrich instead of guessing from text. */
export const structuredSchema = z.object({
  intent: z.enum(["sell", "buy"]).optional(),
  priceVnd: z.number().int().positive().max(1e12).optional(),
  attributes: z
    .record(z.string().max(40), z.union([z.string().max(80), z.number()]))
    .refine((o) => Object.keys(o).length <= 20)
    .default({}),
  sellerType: z.enum(["dealer", "private"]).optional(),
  payload: z.record(z.string(), z.unknown()).optional(), // allow-listed source fields, JSON <= 8 KB
});

export const serverRawPostSchema = rawPostSchema.extend({
  capture: z.enum(SERVER_CAPTURE_KINDS).optional(),
  structured: structuredSchema.optional(),
});

export type Structured = z.infer<typeof structuredSchema>;
export type ServerRawPost = z.infer<typeof serverRawPostSchema>;

export const ingestRequestSchema = z.object({
  sourceId: z.string().uuid(),
  posts: z.array(rawPostSchema).max(MAX_POSTS_PER_BATCH),
  visitId: z.string().max(MAX_SHORT_STR_LEN),
});

export type IngestRequest = z.infer<typeof ingestRequestSchema>;

// Bound `reason`/`visitId` like the other short strings in
// this file, so a misbehaving/hostile key can't send an unbounded payload.
export const healthRequestSchema = z.object({
  sourceId: z.string().uuid(),
  ok: z.boolean(),
  reason: z.string().max(300).optional(),
  visitId: z.string().max(100),
});

export type HealthRequest = z.infer<typeof healthRequestSchema>;

/**
 * Contract a platform adapter must satisfy: fetch posts for a source and report reachability.
 */
export interface SourceAdapter {
  readonly kind: string;
  fetchPosts(sourceUrl: string): Promise<RawPost[]>;
  checkHealth(sourceUrl: string): Promise<{ ok: boolean; reason?: string }>;
}
