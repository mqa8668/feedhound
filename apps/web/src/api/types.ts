// Client-side view of the API DTOs.
// Kept local to `apps/web` (no shared package for these — `packages/core`
// only has domain types, not API response shapes).

import type { ListingFields } from "@feedhound/core/listing";

export type PriceQualifier = "exact" | "floor" | "ceiling" | "approx" | "range";

export type Role = "hunter" | "operator";

export interface MeDto {
  id: string;
  email: string;
  role: Role;
  teamId: string;
  telegramChatId: string | null;
}

export interface UserDto {
  id: string;
  email: string;
  role: Role;
  telegramChatId: string | null;
}

export type KeyScope = "ingest" | "sources:read" | "sources:write";

export interface ApiKeyDto {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  scopes: KeyScope[];
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

/** Shape of `POST /api/keys` — the API returns only these fields (not a full `ApiKeyDto`), plaintext `key` once. */
export interface SourceHealthDto {
  /**
   * Watchdog verdict. A source can be `active` on its schedule and still be
   * unhealthy. `null` = the source has never been visited (empty health, no
   * reason) — renders neutral, not "degraded".
   */
  ok: boolean | null;
  lastVisitAt: string | null;
  reason: string | null;
  pausedAt: string | null;
  /** Timestamp of the most recent ok-outcome visit ledger row; `null` = never had one. */
  lastOkVisitAt: string | null;
  /** Coverage over the last 24h of `metric_rollup` coverage rows, 0-100; `null` = no rows or 0 expected. */
  coveragePct: number | null;
}

export interface SourceDto {
  id: string;
  name: string;
  url: string;
  kind: string;
  status: "active" | "paused" | "paused_by_health";
  assignedKeyId: string | null;
  schedule: { visitEverySec?: { min: number; max: number }; activeHours?: "inherit" | Record<string, unknown> } | null;
  health: SourceHealthDto & { postsLastHour?: number };
  relevance7d?: { posts: number; matched: number; share: number | null };
}

export type Intent = "sell" | "buy" | "other";

export interface WatchDto {
  id: string;
  userId: string;
  name: string;
  enabled: boolean;
  include: string[];
  includeAll: string[];
  exclude: string[];
  regex: string | null;
  categoryIds: string[];
  itemIds: string[];
  priceMin: number | null;
  priceMax: number | null;
  intents: Intent[];
  attributeFilters: AttributeFilterDto[];
  sourceIds: string[];
  notifierIds: string[];
  quietHours: { start: string; end: string } | null;
  mutedUntil: string | null;
  createdAt: string;
  /** Present only on `GET /api/watches?stats=1`. */
  stats?: WatchStatsDto;
}

export interface AttributeFilterDto {
  key: string;
  op: "eq" | "in" | "gte" | "lte";
  value?: string | number;
  values?: (string | number)[];
}

export type NotifierKindDto = "telegram";

export interface WatchStatsDto {
  today: number;
  last7d: number;
  daily: number[];
  lastHitAt: string | null;
  bestDeal: { postId: string; title: string | null; priceVnd: number; dealPct: number } | null;
  routes: NotifierKindDto[];
  /** No notifier picked, so `routes` lists all of the owner's enabled notifiers. */
  routesFallback: boolean;
}

export interface NotifierDto {
  id: string;
  kind: NotifierKindDto;
  enabled: boolean;
}

export interface WatchDraftDto {
  name: string;
  include: string[];
  includeAll: string[];
  exclude: string[];
  categoryIds: string[];
  itemIds: string[];
  intents: Intent[];
  priceMin?: number;
  priceMax?: number;
  attributeFilters: AttributeFilterDto[];
}

export interface WatchParseResponseDto {
  draft: WatchDraftDto;
  warnings: string[];
  suggestions: {
    aliases: string[];
    exclude: string[];
    priceRange: { p25: number; median: number; p75: number; n: number } | null;
  };
}

export interface WatchTestPost {
  id: string;
  title: string | null;
  priceVnd: number | null;
  intent: Intent | null;
  sourceId: string;
  firstSeenAt: string;
  url: string;
  matchedTerms: string[];
}

export interface WatchTestResultDto {
  count: number;
  /** Every match in the scanned window. */
  total: number;
  /** Matches per day, oldest first. */
  daily: number[];
  truncated: boolean;
  posts: WatchTestPost[];
}

export type AttributeDefDto =
  | { key: string; label: string; kind: "enum" | "ordered"; values: string[] }
  | { key: string; label: string; kind: "text"; maxLen: number }
  | { key: string; label: string; kind: "number"; unit: string; min: number; max: number };

export interface CategoryDto {
  id: string;
  parentId: string | null;
  slug: string;
  name: string;
  path: string;
  /** Resolved (inherited) attribute schema. */
  attributeSchema?: AttributeDefDto[];
}

export interface CatalogItemDto {
  id: string;
  categoryId: string;
  name: string;
}

export interface QueueStatDto {
  name: string;
  pending: number;
  failed: number;
}

/** Mirrors `SourceSlo` in apps/api/src/services/slo.ts. */
export interface SourceSloDto {
  sourceId: string;
  name: string;
  status: string;
  coverageOkRatio: number | null;
  coverageCompleteRatio: number | null;
  secondsSinceOkVisit: number | null;
  visits24h: Record<string, number>;
}

export interface OpsSloDto {
  targets: { coverageOk: number; coverageComplete: number; windowHours: number };
  generatedAt: string;
  sources: SourceSloDto[];
}

export interface OpsHealthDto {
  db: "ok" | "down";
  sources: { id: string; name: string; status: string; lastVisitAt: string | null; lastError: string | null; postsLastHour: number }[];
  queues: QueueStatDto[];
  ingest: { lastVisitAt: string | null; silent: boolean; thresholdSec: number };
}

export interface FeedPostDto extends ListingFields {
  id: string;
  sourceId: string;
  title: string | null;
  priceVnd: number | null;
  intent: Intent | null;
  url: string;
  firstSeenAt: string;
  /** First non-blank line of the post text, <= 120 code points. */
  snippet: string | null;
  /** Price text was found but could not be parsed to a sane number. */
  priceSuspect: boolean;
  priceQualifier?: PriceQualifier | null;
  priceMaxVnd?: number | null;
}

export type MatchNotifications = "none" | "pending" | "partial" | "sent" | "failed";

/** One row of `GET /api/dashboard/matches`. */
export interface MatchRowDto {
  id: string;
  postId: string;
  watchId: string;
  score: number;
  matchedTerms: string[];
  createdAt: string;
  post: { id: string; title: string | null; url: string; sourceId: string; sourceName: string; dealMedianVnd?: number | null; dealN?: number | null } & ListingFields;
  intent: Intent | null;
  priceVnd: number | null;
  priceQualifier?: PriceQualifier | null;
  priceMaxVnd?: number | null;
  watch: { id: string; name: string };
  notifications: MatchNotifications;
}

/** Cursor page: `nextCursor` is null on the last page (cursor contract). */
export interface MatchesPageDto {
  matches: MatchRowDto[];
  nextCursor: string | null;
  /** Which S2-S4 features the API has wired (absent = all false). */
  capabilities?: { listing: boolean; dealV2: boolean; risk: boolean; seller: boolean };
}

/** `POST /api/dashboard/matches/seen` response. */
export interface MarkSeenDto {
  lastSeenMatchesAt: string;
}

export type WsFrame =
  | { type: "post.new"; ts: string; data: { postId: string; sourceId: string; title: string | null; priceVnd?: number | null; intent?: Intent | null; url: string; snippet?: string | null; priceSuspect?: boolean; displayTitle?: string | null } }
  | { type: "post.updated"; ts: string; data: { postId: string; sourceId: string; title: string | null; priceVnd?: number | null; intent?: Intent | null; url: string; snippet?: string | null; priceSuspect?: boolean; displayTitle?: string | null } }
  | { type: "match.new"; ts: string; data: { matchId: string; watchId: string; postId: string; title: string } }
  | { type: "source.health"; ts: string; data: { sourceId: string; status: string; reason?: string | null } }
  | { type: "config.changed"; ts: string; data: { key: string; version: number } };

/** `GET /api/posts/:id`. `pipeline` is present for operators only; `raw` and author ids never reach the browser. */
export interface PostDetailDto {
  post: {
    id: string;
    sourceId: string;
    platformPostId: string;
    url: string;
    authorName: string | null;
    authorRef: string | null;
    title: string | null;
    text: string;
    media: unknown[];
    engagement: Record<string, unknown>;
    postedAt: string | null;
    firstSeenAt: string;
    lastSeenAt: string;
    editCount: number;
    capture: "push" | "api" | null;
    fingerprint: string | null;
  };
  source: { id: string; name: string; kind: string; url: string };
  revisions: { id: string; seenAt: string; text: string; engagement: Record<string, unknown> }[];
  enrichment: {
    revision: number;
    intent: string | null;
    priceVnd: number | null;
    priceQualifier?: PriceQualifier | null;
    priceMaxVnd?: number | null;
    priceRaw: string | null;
    condition: string | null;
    confidence: number | null;
    sentiment?: string | null;
    intentTags?: string[];
    engine: string;
    model: string | null;
    updatedAt: string;
    category: { id: string; name: string; path: string } | null;
    item: { id: string; name: string } | null;
  } | null;
  matches: { id: string; watchId: string; watchName: string; score: number; matchedTerms: string[]; createdAt: string }[];
  duplicates: { id: string; sourceId: string; sourceName: string; url: string; firstSeenAt: string }[];
  pipeline?: { enrichState: string; matchState: string; pipelineVersion: number };
}

// Analytics
/** `GET /api/dashboard/overview`. */
/** Search filters as held in the URL (all strings; repeated/comma values for lists). */
// Start a hunt.
// Topics + insights inbox.
export type InsightDelivery = "inbox" | "pending" | "sent" | "failed";

export interface InsightDto {
  id: string;
  kind: "spike" | "digest";
  topicId: string | null;
  day: string;
  text: string;
  payload: Record<string, unknown>;
  delivery: InsightDelivery;
  deliveryError: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface InsightsPageDto {
  items: InsightDto[];
  nextCursor: string | null;
  unread: number;
}

// Watch-driven source discovery.
