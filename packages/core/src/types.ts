import type { PriceQualifier } from "./price";
import type { AttributeFilter, Attributes } from "./attributes";

// Domain DTOs, kept in sync with `packages/db/src/schema`. No business logic here.

export interface PostDto {
  id: string;
  sourceId: string;
  platformPostId: string;
  url: string;
  authorName: string | null;
  authorId: string | null;
  title: string | null;
  text: string;
  textNormalized: string;
  media: unknown[];
  engagement: Record<string, unknown>;
  postedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  editCount: number;
  raw: Record<string, unknown>;
}

export interface EnrichmentDto {
  postId: string;
  revision: number;
  intent: "sell" | "buy" | "other" | null;
  priceVnd: number | null;
  priceRaw: string | null;
  /** How the seller wrote the amount (exact/floor/ceiling/approx/range); null when no price. */
  priceQualifier: PriceQualifier | null;
  priceMaxVnd: number | null;
  priceConfidence: number | null;
  condition: "new" | "like_new" | "used" | "broken" | "unknown" | null;
  categoryId: string | null;
  itemId: string | null;
  confidence: number | null;
  engine: "rule" | "llm";
  model: string | null;
  promptVersion: string | null;
  tokens: number | null;
  /** Typed product attributes; `{}` when the category has no schema. */
  attributes: Attributes;
  /** Price outside the category bounds or phone-shaped: `priceVnd` was nulled, `priceRaw` kept. */
  priceSuspect: boolean;
  dealMedianVnd: number | null;
  dealN: number | null;
  dealPct: number | null;
  /** Advisory one-line title (A5). */
  displayTitle: string | null;
  createdAt: string;
  updatedAt: string;
}

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
  attributeFilters: AttributeFilter[];
  intents: string[];
  sourceIds: string[];
  notifierIds: string[];
  quietHours: Record<string, unknown> | null;
  mutedUntil: string | null;
  createdAt: string;
}

export interface MatchDto {
  id: string;
  postId: string;
  watchId: string;
  score: number;
  matchedTerms: string[];
  createdAt: string;
}
