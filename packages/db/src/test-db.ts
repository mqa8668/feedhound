import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import postgres from "postgres";
import { migrate } from "./migrate";

// Per-worktree integration-test databases (`feedhound_<suffix>_test`).
// Usage: bun run test:db create|drop|list [--suffix s] [--reset] [--env-out path]
// Reads the base TEST_DATABASE_URL and swaps only the database name. The password is never printed.

const SUFFIX_RE = /^[a-z0-9]{1,24}$/;

/** Lowercase the worktree directory name, drop non-alphanumerics, keep the last 24 chars. */
export function deriveSuffix(worktreeDir: string): string {
  return basename(worktreeDir)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(-24);
}

export function testDbName(suffix: string): string {
  if (!SUFFIX_RE.test(suffix)) throw new Error(`invalid test-db suffix: ${JSON.stringify(suffix)}`);
  return `feedhound_${suffix}_test`;
}

function urlFor(base: string, dbName: string): string {
  const u = new URL(base);
  u.pathname = `/${dbName}`;
  return u.toString();
}

function parseArgs(argv: string[]): { cmd: string; suffix?: string; reset: boolean; envOut?: string } {
  const [cmd = "", ...rest] = argv;
  let suffix: string | undefined;
  let envOut: string | undefined;
  let reset = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--suffix") suffix = rest[++i];
    else if (a === "--env-out") envOut = rest[++i];
    else if (a === "--reset") reset = true;
  }
  return { cmd, suffix, reset, envOut };
}

async function gitToplevel(): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0 || !out) throw new Error("cannot derive suffix: not in a git worktree (use --suffix)");
  return out;
}

async function main(argv: string[]): Promise<number> {
  const { cmd, suffix: given, reset, envOut } = parseArgs(argv);
  if (!["create", "drop", "list"].includes(cmd)) {
    console.error("usage: test:db create|drop|list [--suffix s] [--reset] [--env-out path]");
    return 2;
  }
  const base = process.env.TEST_DATABASE_URL;
  if (!base) {
    console.error("TEST_DATABASE_URL is not set");
    return 2;
  }
  const admin = postgres(base, { max: 1 });
  try {
    if (cmd === "list") {
      const rows = await admin<{ datname: string; size: string }[]>`
        select datname, pg_size_pretty(pg_database_size(datname)) as size from pg_database
        where datname like 'hunt\_%\_test' order by datname`;
      for (const r of rows) console.log(`${r.datname}\t${r.size}`);
      return 0;
    }
    let name: string;
    try {
      name = testDbName(given ?? deriveSuffix(await gitToplevel()));
    } catch (e) {
      console.error((e as Error).message);
      return 2;
    }
    const target = urlFor(base, name);
    const file = envOut ?? ".env.test";
    if (cmd === "create") {
      if (reset) await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      const exists = await admin`select 1 from pg_database where datname = ${name}`;
      if (exists.length === 0) await admin.unsafe(`CREATE DATABASE "${name}"`);
      await migrate(target);
      writeFileSync(file, `TEST_DATABASE_URL='${target}'\n`);
    } else {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      if (existsSync(file) && readFileSync(file, "utf8").includes(`/${name}'`)) rmSync(file);
    }
    console.log(name);
    return 0;
  } finally {
    await admin.end();
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
