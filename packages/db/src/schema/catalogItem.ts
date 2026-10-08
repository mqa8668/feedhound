import { jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { category } from "./category";

export const catalogItem = pgTable("catalog_item", {
  id: uuid("id").primaryKey().defaultRandom(),
  categoryId: uuid("category_id")
    .notNull()
    .references(() => category.id),
  name: text("name").notNull(),
  aliases: text("aliases").array().notNull().default([]),
  attributes: jsonb("attributes").notNull().default({}),
});
