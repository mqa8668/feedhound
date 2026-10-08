import { check, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { team } from "./team";

export const user = pgTable(
  "user",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id),
    email: text("email").notNull().unique(),
    role: text("role").notNull().default("hunter"), // hunter | operator (least-privilege default)
    telegramChatId: text("telegram_chat_id"),
    linkCode: text("link_code").unique(),
    linkCodeExpiresAt: timestamp("link_code_expires_at", { withTimezone: true }),
    // Unread mark for the /matches inbox — `GET /api/dashboard/matches/unseen`
    // counts matches with `createdAt > last_seen_matches_at`, `POST …/seen` advances it
    // to now(). Defaults (and migration 0020's backfill for existing rows) to the row's
    // creation/migration instant, so a user who never called `seen` starts at 0 unread.
    lastSeenMatchesAt: timestamp("last_seen_matches_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("user_role_check", sql`${t.role} IN ('hunter','operator')`)],
);
