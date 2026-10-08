import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { apiKey } from "./apiKey";
import { team } from "./team";

export const source = pgTable(
  "source",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id),
    kind: text("kind").notNull(), // web | telegram | push
    platformId: text("platform_id").notNull(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    status: text("status").notNull().default("active"), // active | paused | paused_by_health
    schedule: jsonb("schedule").notNull().default({}),
    // Default attribute values (e.g. region, categoryId) applied to this source's posts at enrich time.
    defaults: jsonb("defaults").$type<Record<string, string | number>>().notNull().default({}),
    health: jsonb("health").notNull().default({}), // { ok, reason }
    // SET NULL on delete so removing a user (which
    // cascades their api_key rows) unassigns the key from any source instead
    // of raising an FK violation.
    assignedKeyId: uuid("assigned_key_id").references(() => apiKey.id, { onDelete: "set null" }),
    lastIngestAt: timestamp("last_ingest_at", { withTimezone: true }),
    lastHealthAt: timestamp("last_health_at", { withTimezone: true }),
    // last ops alert timestamps, used to rate-limit `/api/health ok=false` (1/hour)
    // and the silence watchdog (1/6h) independently, per source.
    healthAlertAt: timestamp("health_alert_at", { withTimezone: true }),
    // Null = no open gap; set when the watchdog raises an alert,
    // cleared on the recovery alert.
    watchdogAlertAt: timestamp("watchdog_alert_at", { withTimezone: true }),
    // Null -> watchdog fallback interval (Interface).
    expectedIntervalSec: integer("expected_interval_sec"),
    lastOkVisitAt: timestamp("last_ok_visit_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("source_assigned_key_idx").on(t.assignedKeyId),
    check("source_status_check", sql`${t.status} IN ('active','paused','paused_by_health')`),
    check("source_kind_check", sql`${t.kind} IN ('web','telegram','push')`),
  ],
);
