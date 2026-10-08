import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { source } from "./source";
import { tsvector } from "./types";
import { visit } from "./visit";

export const post = pgTable(
  "post",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => source.id),
    platformPostId: text("platform_post_id").notNull(),
    url: text("url").notNull(),
    authorName: text("author_name"),
    authorId: text("author_id"),
    title: text("title"),
    text: text("text").notNull().default(""),
    textNormalized: text("text_normalized").notNull().default(""),
    media: jsonb("media").notNull().default([]),
    engagement: jsonb("engagement").notNull().default({}),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    editCount: integer("edit_count").notNull().default(0),
    raw: jsonb("raw").notNull().default({}),
    // Which visit ingested this post. Null for
    // pre-migration posts and legacy non-uuid visitIds.
    // Capture-independent content fingerprint (postFingerprint); null for empty text / pre-backfill rows.
    fingerprint: text("fingerprint"),
    // How the stored text was captured ('push' | 'api'); null for legacy rows.
    capture: text("capture"),
    visitId: uuid("visit_id"),
    // Sha256(authorKey + fingerprintText) without scope (same seller, same text across groups); null = unknown author/empty text.
    repostKey: text("repost_key"),
    // Thumbnail cache state; null = not tried yet.
    thumbState: text("thumb_state"),
    thumbAttempts: smallint("thumb_attempts").notNull().default(0),
    thumbCheckedAt: timestamp("thumb_checked_at", { withTimezone: true }),
    // The post row is the outbox record. enrich/match states + optimistic version.
    enrichState: text("enrich_state").notNull().default("pending"),
    matchState: text("match_state").notNull().default("pending"),
    pipelineVersion: integer("pipeline_version").notNull().default(0),
    pipelineAttempts: integer("pipeline_attempts").notNull().default(0),
    pipelineUpdatedAt: timestamp("pipeline_updated_at", { withTimezone: true }).notNull().defaultNow(),
    pipelineReconciledAt: timestamp("pipeline_reconciled_at", { withTimezone: true }),
    // immutable_unaccent is a wrapper around unaccent() created in migration 0000
    // (unaccent() itself is STABLE, which Postgres rejects for generated columns).
    tsv: tsvector("tsv").generatedAlwaysAs(
      () => sql`to_tsvector('simple', immutable_unaccent(coalesce("text_normalized", '')))`,
    ),
    // Accent-folded text with every non [a-z0-9] removed (trigram "ip15 full box" ~ "ip15fullbox"), and the sort/filter timestamp.
    textCompact: text("text_compact").generatedAlwaysAs(
      () => sql`regexp_replace(immutable_unaccent(text_normalized), '[^a-z0-9]+', '', 'g')`,
    ),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).generatedAlwaysAs(() => sql`coalesce(posted_at, first_seen_at)`),
  },
  (t) => [
    unique("post_source_platform_post_unique").on(t.sourceId, t.platformPostId),
    index("post_source_id_idx").on(t.sourceId),
    index("post_visit_id_idx").on(t.visitId),
    index("post_source_fingerprint_idx").on(t.sourceId, t.fingerprint),
    index("post_first_seen_at_idx").on(t.firstSeenAt),
    index("post_pipeline_pending_idx")
      .on(t.pipelineUpdatedAt)
      .where(sql`${t.enrichState} = 'pending' OR ${t.matchState} = 'pending'`),
    index("post_pipeline_failed_idx")
      .on(t.id)
      .where(sql`${t.enrichState} = 'failed' OR ${t.matchState} = 'failed'`),
    index("post_repost_key_idx").on(t.repostKey),
    index("post_thumb_todo_idx")
      .on(t.firstSeenAt.desc())
      .where(sql`${t.thumbState} IS NULL`),
    index("post_tsv_idx").using("gin", t.tsv),
    index("post_text_compact_trgm").using("gin", sql`${t.textCompact} gin_trgm_ops`),
    index("post_effective_at_id").on(t.effectiveAt.desc(), t.id.desc()),
    index("post_source_effective_at").on(t.sourceId, t.effectiveAt.desc()),
    index("post_author_id").on(t.authorId).where(sql`${t.authorId} IS NOT NULL`),
    index("post_author_name_trgm").using("gin", sql`${t.authorName} gin_trgm_ops`),
    // FK name is the Postgres default chosen by hand-written migration 0021.
    foreignKey({ name: "post_visit_id_fkey", columns: [t.visitId], foreignColumns: [visit.id] }).onDelete("set null"),
    check("post_enrich_state_check", sql`${t.enrichState} IN ('pending','done','failed')`),
    check("post_match_state_check", sql`${t.matchState} IN ('pending','done','failed')`),
    check("post_thumb_state_check", sql`${t.thumbState} IS NULL OR ${t.thumbState} IN ('ok','none','expired','failed','purged')`),
    check("post_capture_check", sql`${t.capture} IS NULL OR ${t.capture} IN ('push','api')`),
  ],
);
