import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { savedSearch } from "./savedSearch";
import { team } from "./team";
import { user } from "./user";

// A topic is a snapshot of a saved search taken at promote time. Migration 0035.
export const topic = pgTable(
  "topic",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    savedSearchId: uuid("saved_search_id").references(() => savedSearch.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    params: jsonb("params").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    alertsEnabled: boolean("alerts_enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("topic_user_name_unique").on(t.userId, t.name), index("topic_team_enabled").on(t.teamId, t.enabled)],
);

export const topicVolume = pgTable(
  "topic_volume",
  {
    topicId: uuid("topic_id")
      .notNull()
      .references(() => topic.id, { onDelete: "cascade" }),
    bucket: text("bucket").notNull(), // hour | day
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    posts: integer("posts").notNull(),
    neg: integer("neg").notNull(),
    neu: integer("neu").notNull(),
    pos: integer("pos").notNull(),
  },
  (t) => [primaryKey({ name: "topic_volume_pk", columns: [t.topicId, t.bucket, t.ts] }), check("topic_volume_bucket_check", sql`${t.bucket} IN ('hour','day')`)],
);

// Spike alerts + daily digests; this row is their delivery record (no `notification` row).
export const insight = pgTable(
  "insight",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // spike | digest
    topicId: uuid("topic_id").references(() => topic.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    payload: jsonb("payload").notNull(),
    text: text("text").notNull(),
    delivery: text("delivery").notNull().default("inbox"), // inbox | pending | sent | failed
    attempts: integer("attempts").notNull().default(0),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    deliveryError: text("delivery_error"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("insight_dedupe_key_unique").on(t.dedupeKey),
    index("insight_user_created").on(t.userId, t.createdAt.desc(), t.id.desc()),
    index("insight_team_created").on(t.teamId, t.createdAt.desc(), t.id.desc()), // migration 0045 (team visibility)
    check("insight_kind_check", sql`${t.kind} IN ('spike','digest')`),
    check("insight_delivery_check", sql`${t.delivery} IN ('inbox','pending','sent','failed')`),
  ],
);
