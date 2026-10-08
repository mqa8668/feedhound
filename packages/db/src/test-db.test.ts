import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { deriveSuffix, testDbName } from "./test-db";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const MUST_RUN = Boolean(process.env.CI) || Boolean(TEST_DATABASE_URL);
const SCRIPT = new URL("./test-db.ts", import.meta.url).pathname;
const JOURNAL = new URL("../migrations/meta/_journal.json", import.meta.url).pathname;

describe("test-db naming (pure)", () => {
  test("deriveSuffix lowercases, strips non-alphanumerics, keeps the last 24 chars", () => {
    expect(deriveSuffix("/x/worktree-agent-A812_f")).toBe("worktreeagenta812f");
    expect(deriveSuffix("/x/" + "a".repeat(30) + "b")).toBe("a".repeat(23) + "b");
  });

  test("testDbName accepts valid suffixes and throws on invalid ones", () => {
    expect(testDbName("ac8x")).toBe("feedhound_ac8x_test");
    for (const bad of ["Bad-1", "", "a".repeat(25), "x_y"]) expect(() => testDbName(bad)).toThrow();
  });

  test("A worktree's .env.test (loaded by bun test) names its own DB, never plain feedhound_test", () => {
    if (TEST_DATABASE_URL && existsSync(new URL("../../../.env.test", import.meta.url).pathname)) {
      expect(new URL(TEST_DATABASE_URL).pathname).toMatch(/^\/feedhound_[a-z0-9]{1,24}_test$/);
    }
  });
});

async function run(args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bun", SCRIPT, ...args], { stdout: "pipe", stderr: "pipe", env: process.env });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out: out + err };
}

const dbDescribe = MUST_RUN ? describe : describe.skip;

dbDescribe("test:db create/drop (integration)", () => {
  const dir = mkdtempSync(join(tmpdir(), "testdb-"));
  const envOut = join(dir, ".env.test");

  afterAll(async () => {
    await run(["drop", "--suffix", "ac8x", "--env-out", envOut]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("create is idempotent, migrates, writes the env file, hides the password; drop removes both", async () => {
    if (!TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is required");
    const password = new URL(TEST_DATABASE_URL).password;
    const first = await run(["create", "--suffix", "ac8x", "--env-out", envOut]);
    const second = await run(["create", "--suffix", "ac8x", "--env-out", envOut]);
    expect([first.code, second.code]).toEqual([0, 0]);
    expect(first.out.trim()).toBe("feedhound_ac8x_test");
    if (password) expect(first.out + second.out).not.toContain(`:${password}@`);

    const target = new URL(TEST_DATABASE_URL);
    target.pathname = "/feedhound_ac8x_test";
    expect(readFileSync(envOut, "utf8")).toMatch(/TEST_DATABASE_URL='.*\/feedhound_ac8x_test'\n$/);

    const sql = postgres(target.toString(), { max: 1 });
    try {
      const entries = (JSON.parse(readFileSync(JOURNAL, "utf8")) as { entries: unknown[] }).entries.length;
      const [row] = await sql<{ n: number }[]>`select count(*)::int as n from drizzle.__drizzle_migrations`;
      expect(row!.n).toBe(entries);
    } finally {
      await sql.end();
    }

    const dropped = await run(["drop", "--suffix", "ac8x", "--env-out", envOut]);
    expect(dropped.code).toBe(0);
    expect(existsSync(envOut)).toBe(false);
    const admin = postgres(TEST_DATABASE_URL, { max: 1 });
    try {
      const rows = await admin`select 1 from pg_database where datname = 'feedhound_ac8x_test'`;
      expect(rows).toHaveLength(0);
    } finally {
      await admin.end();
    }
  }, 60_000);

  test("an invalid suffix exits 2 before any SQL", async () => {
    const bad = await run(["create", "--suffix", "Bad-1", "--env-out", envOut]);
    expect(bad.code).toBe(2);
    expect(existsSync(envOut)).toBe(false);
  });
});
