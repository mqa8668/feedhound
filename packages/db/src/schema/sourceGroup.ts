import { check, integer, pgTable, real, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { category } from "./category";
import { source } from "./source";
import { user } from "./user";

// Auto classification of a source (topic + region) plus the operator override, which always wins.
export const sourceGroup = pgTable(
  "source_group",
  {
    sourceId: uuid("source_id")
      .primaryKey()
      .references(() => source.id, { onDelete: "cascade" }),
    autoTopicCategoryId: uuid("auto_topic_category_id").references(() => category.id, { onDelete: "set null" }),
    autoTopicMethod: text("auto_topic_method").notNull(), // auto | mixed | default | insufficient
    autoTopicShare: real("auto_topic_share"),
    autoRegion: text("auto_region"),
    autoRegionMethod: text("auto_region_method").notNull(), // auto | default | none
    autoRegionShare: real("auto_region_share"),
    sampleN: integer("sample_n").notNull().default(0),
    regionSampleN: integer("region_sample_n").notNull().default(0),
    classifiedAt: timestamp("classified_at", { withTimezone: true }),
    overrideTopicCategoryId: uuid("override_topic_category_id").references(() => category.id, { onDelete: "set null" }),
    overrideRegion: text("override_region"),
    overriddenBy: uuid("overridden_by").references(() => user.id, { onDelete: "set null" }),
    overriddenAt: timestamp("overridden_at", { withTimezone: true }),
  },
  (t) => [
    check("source_group_topic_method_check", sql`${t.autoTopicMethod} IN ('auto','mixed','default','insufficient')`),
    check("source_group_region_method_check", sql`${t.autoRegionMethod} IN ('auto','default','none')`),
  ],
);
