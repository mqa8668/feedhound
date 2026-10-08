import { drizzle } from "drizzle-orm/postgres-js";
import { migrate as drizzleMigrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

export async function migrate(databaseUrl?: string): Promise<void> {
  const url = databaseUrl ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  // onnotice: drizzle's `CREATE SCHEMA/TABLE IF NOT EXISTS` NOTICEs (42P06/42P07) must not leak to stdout.
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await drizzleMigrate(drizzle(sql), { migrationsFolder: new URL("../migrations", import.meta.url).pathname });
  } finally {
    await sql.end();
  }
}

if (import.meta.main) {
  await migrate();
  console.log("migrate: done");
}
