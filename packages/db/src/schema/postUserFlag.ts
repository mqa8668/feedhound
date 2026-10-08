import { sql } from "drizzle-orm";
import { check, index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { post } from "./post";
import { user } from "./user";

// Per-user saved/hidden flag on a post. `repost_key` is copied from the post at flag time
// so hiding one copy hides the same seller's identical listing in other groups.
export const postUserFlag = pgTable(
  "post_user_flag",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    postId: uuid("post_id")
      .notNull()
      .references(() => post.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    repostKey: text("repost_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.postId, t.kind] }),
    index("post_user_flag_user_kind_repost_idx").on(t.userId, t.kind, t.repostKey),
    check("post_user_flag_kind_check", sql`${t.kind} IN ('saved','hidden')`),
  ],
);
