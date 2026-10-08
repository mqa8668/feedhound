import { customType } from "drizzle-orm/pg-core";

/** Postgres `ltree` column (requires the `ltree` extension). */
export const ltree = customType<{ data: string }>({
  dataType() {
    return "ltree";
  },
});

/** Postgres `tsvector` column (requires the `unaccent` extension for generated columns). */
export const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});
