import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Per-deployment secrets (the author-pseudonym salt). Migration 0038.
export const appSecret = pgTable("app_secret", {
  name: text("name").primaryKey(),
  value: text("value").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
