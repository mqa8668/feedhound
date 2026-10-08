import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { source } from "./source";

/**
 * One row per source poll (the ledger behind source health and SLOs). `id` is a caller-generated `visitId` (no default) so the
 * same visit posted twice upserts the same row. `outcome` null
 * = visit not finished yet (a stub row from ingest tagging).
 */
export const visit = pgTable(
  "visit",
  {
    id: uuid("id").primaryKey(),
    sourceId: uuid("source_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    outcome: text("outcome"),
    mode: text("mode").notNull().default("normal"),
    postsSeen: integer("posts_seen"),
    postsNew: integer("posts_new"),
    pages: integer("pages"),
    reachedKnownTail: boolean("reached_known_tail"),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // FK names are the Postgres defaults chosen by hand-written migration 0021.
    foreignKey({ name: "visit_source_id_fkey", columns: [t.sourceId], foreignColumns: [source.id] }).onDelete("cascade"),
    index("visit_source_started_idx").on(t.sourceId, t.startedAt.desc()),
    check(
      "visit_outcome_check",
      sql`${t.outcome} IS NULL OR ${t.outcome} IN ('ok','no_slots','blocked','timeout','error','skipped')`,
    ),
    check("visit_mode_check", sql`${t.mode} IN ('normal','catchup','probe')`),
  ],
);
