import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { createApp } from "../index";
import { csvCell, exportFilename } from "../services/export-csv";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL && process.env.CI) throw new Error("export.test.ts: TEST_DATABASE_URL is required (CI is set)");
if (TEST_DATABASE_URL && !new URL(TEST_DATABASE_URL).pathname.replace(/^\//, "").endsWith("_test")) {
  throw new Error("TEST_DATABASE_URL must point at a database whose name ends in '_test'");
}
const canRun = Boolean(TEST_DATABASE_URL);

describe("csv helpers", () => {
  test("formula guard, quoting, filename", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell("@x")).toBe("'@x");
    expect(csvCell("\tx")).toBe("'\tx");
    expect(csvCell("\rx")).toBe('"\'\rx"');
    expect(csvCell('a "b", c')).toBe('"a ""b"", c"');
    expect(csvCell("l1\nl2")).toBe('"l1\nl2"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(42)).toBe("42");
    expect(exportFilename(new Date(Date.UTC(2026, 9, 5, 7, 3)))).toBe("corpus-20261005-0703.csv");
  });
});

// + team scope of export: 
describe.skipIf(!canRun)("GET /api/search/export.csv", () => {
  const RUN = crypto.randomUUID().slice(0, 8);
  const OP = `ex-op-${RUN}@example.com`;
  const HUNTER = `ex-h-${RUN}@example.com`;
  let handle: DbHandle;
  const sourceIds: string[] = [];

  const get = (who: string, qs = ""): Response | Promise<Response> => createApp(handle).request(`/api/search/export.csv${qs}`, { headers: { "X-Dev-User": who } });

  beforeAll(async () => {
    process.env.NODE_ENV = "development";
    process.env.DEV_AUTH_BYPASS = "1";
    handle = createDb(TEST_DATABASE_URL!);
    const teams = await handle.db
      .insert(schema.team)
      .values([{ name: `ex1-${RUN}` }, { name: `ex2-${RUN}` }])
      .returning({ id: schema.team.id });
    await handle.db.insert(schema.user).values([
      { teamId: teams[0]!.id, email: OP, role: "operator" },
      { teamId: teams[0]!.id, email: HUNTER, role: "hunter" },
    ]);
    const mkSrc = async (teamId: string, name: string): Promise<string> => {
      const [s] = await handle.db
        .insert(schema.source)
        .values({ teamId, kind: "web", platformId: `ex-${name}-${RUN}`, name, url: `https://feeds.example.test/ex-${name}-${RUN}` })
        .returning({ id: schema.source.id });
      return s!.id;
    };
    const mine = await mkSrc(teams[0]!.id, "mine");
    const other = await mkSrc(teams[1]!.id, "other");
    sourceIds.push(mine, other);
    const base = Date.UTC(2026, 9, 1);
    const rows = Array.from({ length: 12_000 }, (_, i) => ({
      sourceId: mine,
      platformPostId: `ex-${i}-${RUN}`,
      url: `https://feeds.example.test/g/posts/ex-${i}-${RUN}`,
      title: i === 0 ? "=1+1" : `t${i}`,
      text: `exportword ${i}`,
      textNormalized: `exportword ${i}`,
      // post 0 is the newest, so it lands inside the 10 000-row window
      postedAt: new Date(base - i * 1000),
    }));
    for (let i = 0; i < rows.length; i += 1000) await handle.db.insert(schema.post).values(rows.slice(i, i + 1000));
    await handle.db.insert(schema.post).values({
      sourceId: other,
      platformPostId: `ex-foreign-${RUN}`,
      url: "https://feeds.example.test/g/posts/foreign",
      title: "foreign",
      text: "exportword foreign",
      textNormalized: "exportword foreign",
    });
  }, 60_000);

  afterAll(async () => {
    // bulk rows must not linger: other suites scan `post` (backfill tests have a 5 s budget)
    await handle.db.delete(schema.post).where(inArray(schema.post.sourceId, sourceIds));
    await handle.close();
  });

  test("Hunter 403; operator gets 10 000 rows + header, truncated, escaped, concurrent 429", async () => {
    expect((await get(HUNTER)).status).toBe(403);

    const first = await get(OP);
    expect(first.status).toBe(200);
    expect(first.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(first.headers.get("Content-Disposition")).toMatch(/^attachment; filename="corpus-\d{8}-\d{4}\.csv"$/);
    expect(first.headers.get("X-Export-Truncated")).toBe("true");
    const second = await get(OP);
    expect(second.status).toBe(429);
    expect(((await second.json()) as { error: string }).error).toBe("export_in_progress");

    const bytes = new Uint8Array(await first.arrayBuffer());
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.slice(3));
    const lines = text.split("\r\n");
    expect(lines.pop()).toBe("");
    expect(lines).toHaveLength(10_001);
    expect(lines[0]).toBe("id,url,source,author,postedAt,firstSeenAt,capture,intent,priceVnd,category,item,confidence,editCount,matchCount,title,text");
    expect(lines[1]).toContain(",'=1+1,");
    expect(text).not.toContain("foreign");

    // the lock is released once the stream ends
    expect((await get(OP, "?q=exportword%20foreign")).status).toBe(200);
  }, 60_000);

  test("small export is not truncated and carries only the team's rows", async () => {
    const res = await get(OP, "?q=exportword&from=2026-09-30T23:59:00.000Z&to=2026-10-02T00:00:00.000Z&sort=newest");
    expect(res.headers.get("X-Export-Truncated")).toBe("false");
    const lines = (await res.text()).split("\r\n");
    expect(lines.length - 2).toBeGreaterThan(0);
    expect(lines.length - 2).toBeLessThan(100);
  });
});
