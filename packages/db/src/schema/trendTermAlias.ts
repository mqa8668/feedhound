import { sql } from "drizzle-orm";
import { check, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { team } from "./team";

// Cached LLM curation verdict per trend term key. Migration 0039.
export const trendTermAlias = pgTable(
  "trend_term_alias",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    termKey: text("term_key").notNull(),
    kind: text("kind").notNull(), // merge | drop | keep
    canonicalKey: text("canonical_key"),
    canonicalDisplay: text("canonical_display"),
    model: text("model"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "trend_term_alias_pk", columns: [t.teamId, t.termKey] }),
    check("trend_term_alias_kind_check", sql`${t.kind} IN ('merge','drop','keep')`),
  ],
);
