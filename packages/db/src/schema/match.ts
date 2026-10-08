import { desc } from "drizzle-orm";
import { doublePrecision, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { post } from "./post";
import { watch } from "./watch";

export const match = pgTable(
  "match",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    postId: uuid("post_id")
      .notNull()
      .references(() => post.id, { onDelete: "cascade" }),
    watchId: uuid("watch_id")
      .notNull()
      .references(() => watch.id, { onDelete: "cascade" }),
    score: doublePrecision("score").notNull(),
    matchedTerms: text("matched_terms").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Set once the `match` job has finalised the notify decision for this
    // row (enqueued a `notify` job, or determined none was needed because
    // the watch has no notifiers) — null means "decision not yet made".
    // Lets a retried `match` job (e.g. after a `boss.send` failure)
    // re-scan its own inserted-or-existing matches and enqueue `notify` for
    // any still null, instead of relying on `onConflictDoNothing`'s
    // "no row returned" signal, which is indistinguishable from "already
    // notified" on retry.
    notifyEnqueuedAt: timestamp("notify_enqueued_at", { withTimezone: true }),
  },
  (t) => [
    unique("match_post_watch_unique").on(t.postId, t.watchId),
    index("match_watch_id_created_at_idx").on(t.watchId, desc(t.createdAt)),
    index("match_created_at_id_idx").on(desc(t.createdAt), desc(t.id)), // migration 0020
  ],
);
