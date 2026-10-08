import { boolean, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { user } from "./user";

export const notifier = pgTable("notifier", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => user.id),
  kind: text("kind").notNull(), // telegram
  config: jsonb("config").notNull().default({}),
  enabled: boolean("enabled").notNull().default(true),
});
