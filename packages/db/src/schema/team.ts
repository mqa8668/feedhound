import { jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";

export const team = pgTable("team", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  settings: jsonb("settings").notNull().default({}),
});
