import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { team } from "./team";

// One row per hourly curation attempt (token accounting + skip reason). Migration 0039.
export const trendCurateRun = pgTable(
  "trend_curate_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
    candidates: integer("candidates"),
    tokens: integer("tokens").notNull().default(0),
    outcome: text("outcome"), // ok | invalid | disabled | budget | quota | cap
  },
  (t) => [index("trend_curate_run_team_ran_idx").on(t.teamId, t.ranAt)],
);
