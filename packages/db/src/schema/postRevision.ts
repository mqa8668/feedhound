import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { post } from "./post";

export const postRevision = pgTable("post_revision", {
  id: uuid("id").primaryKey().defaultRandom(),
  postId: uuid("post_id")
    .notNull()
    .references(() => post.id),
  seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
  text: text("text").notNull(), // previous (superseded) text; post.text is always current
  engagement: jsonb("engagement").notNull().default({}),
});
