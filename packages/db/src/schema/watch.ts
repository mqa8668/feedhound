import {
  boolean,
  doublePrecision,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./user";

export const watch = pgTable("watch", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  include: text("include").array().notNull().default([]),
  includeAll: text("include_all").array().notNull().default([]),
  exclude: text("exclude").array().notNull().default([]),
  regex: text("regex"),
  categoryIds: uuid("category_ids").array().notNull().default([]),
  itemIds: uuid("item_ids").array().notNull().default([]),
  priceMin: doublePrecision("price_min"),
  priceMax: doublePrecision("price_max"),
  // AttributeFilter[] (eq/in/gte/lte on category attributes).
  attributeFilters: jsonb("attribute_filters").$type<unknown[]>().notNull().default([]),
  intents: text("intents").array().notNull().default([]),
  sourceIds: uuid("source_ids").array().notNull().default([]),
  notifierIds: uuid("notifier_ids").array().notNull().default([]),
  quietHours: jsonb("quiet_hours").$type<Record<string, unknown>>(),
  mutedUntil: timestamp("muted_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
