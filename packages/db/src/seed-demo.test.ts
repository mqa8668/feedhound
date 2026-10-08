import { describe, expect, test } from "bun:test";
import { createDb } from "./index";
import { DEMO_CONFIG, DEMO_WATCHES, HN_FEED_URL, seedDemo } from "./seed-demo";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const dbDescribe = TEST_DATABASE_URL ? describe : describe.skip;

dbDescribe("seedDemo", () => {
  test("is idempotent, and offline mode skips the internet source", async () => {
    const h = createDb(TEST_DATABASE_URL);
    try {
      const count = async () => {
        const [r] = await h.sql<{ s: number; w: number; c: number; u: number }[]>`
          select (select count(*)::int from source where platform_id like 'feed:%') as s,
                 (select count(*)::int from watch) as w,
                 (select count(*)::int from config where updated_by = 'demo-seed') as c,
                 (select count(*)::int from "user") as u`;
        return r!;
      };
      const a = await seedDemo(TEST_DATABASE_URL, { offline: true });
      const first = await count();
      const b = await seedDemo(TEST_DATABASE_URL, { offline: true });
      expect(b).toEqual(a);
      expect(await count()).toEqual(first);
      expect(a.sources).toBe(2);
      expect(a.watches).toBe(DEMO_WATCHES.length);
      const hn = await h.sql`select 1 from source where platform_id = ${`feed:${HN_FEED_URL}`}`;
      expect(hn.length).toBe(0);

      const online = await seedDemo(TEST_DATABASE_URL, { offline: false });
      expect(online.sources).toBe(3);
      const [cfg] = await h.sql<{ value: unknown }[]>`select value from config where key = 'web.allowPrivateHosts' order by version desc limit 1`;
      expect(cfg?.value).toBe(DEMO_CONFIG["web.allowPrivateHosts"]);
    } finally {
      await h.close();
    }
  }, 60_000);
});
