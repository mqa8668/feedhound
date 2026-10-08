import { sql } from "drizzle-orm";
import { check, doublePrecision, index, integer, pgTable, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { category } from "./category";
import { team } from "./team";

// Hist = hourly term counts; 1h / 24h = trending output. Migration 0028.
export const trendTerm = pgTable(
  "trend_term",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    window: text("window").notNull(), // 1h | 24h | hist
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    term: text("term").notNull(),
    categoryId: uuid("category_id").references(() => category.id),
    count: integer("count").notNull().default(0),
    baseline: doublePrecision("baseline"),
    zscore: doublePrecision("zscore"),
    // Migration 0039: display form, 24h lift, extractor generation (hist rows read only extractor = 2).
    display: text("display"),
    lift: doublePrecision("lift"),
    extractor: smallint("extractor").notNull().default(1),
  },
  (t) => [
    check("trend_term_window_check", sql`${t.window} IN ('hist','1h','24h')`),
    // Serves the overview max(ts) lookup; trend_term_key (0 scans) was dropped in 0031.
    index("trend_term_latest_idx").on(t.teamId, t.window, t.ts.desc()).where(sql`${t.categoryId} IS NULL`),
    index("trend_term_top_idx").on(t.teamId, t.window, t.ts, sql`${t.zscore} DESC`),
    index("trend_term_term_idx").on(t.teamId, t.term, t.window, t.ts),
  ],
);
