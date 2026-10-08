import { bigint, check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { ltree } from "./types";
import { user } from "./user";

export const category = pgTable(
  "category",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    parentId: uuid("parent_id"),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    path: ltree("path").notNull(),
    // AttributeSchema (JSON array of AttributeDef) declared on this node; descendants inherit.
    attributeSchema: jsonb("attribute_schema").$type<unknown[]>().notNull().default([]),
    // Price bounds declared on this node (nearest ancestor wins per side); null = inherit.
    priceMinVnd: bigint("price_min_vnd", { mode: "number" }),
    priceMaxVnd: bigint("price_max_vnd", { mode: "number" }),
    // 'seed' = from taxonomy.yaml, 'user' = confirmed through a hunt bootstrap.
    origin: text("origin").notNull().default("seed"),
    confirmedBy: uuid("confirmed_by").references(() => user.id),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("category_path_unique").on(t.path),
    index("category_path_idx").using("gist", t.path),
    check("category_origin_check", sql`${t.origin} IN ('seed','user')`),
  ],
);
