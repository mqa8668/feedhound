import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "../index";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL && process.env.CI) throw new Error("insights.test.ts: TEST_DATABASE_URL is required (CI is set)");
if (TEST_DATABASE_URL && !new URL(TEST_DATABASE_URL).pathname.replace(/^\//, "").endsWith("_test")) {
  throw new Error("TEST_DATABASE_URL must point at a database whose name ends in '_test'");
}
const canRun = Boolean(TEST_DATABASE_URL);

type Page = { items: { id: string; readAt: string | null; delivery: string; mine: boolean }[]; nextCursor: string | null; unread: number };

describe.skipIf(!canRun)("/api/insights", () => {
  const RUN = crypto.randomUUID().slice(0, 8);
  const A = `in-a-${RUN}@example.com`;
  const B = `in-b-${RUN}@example.com`;
  const D = `in-d-${RUN}@example.com`;
  let handle: DbHandle;
  let ids: string[] = [];

  const call = (method: string, path: string, who: string): Response | Promise<Response> =>
    createApp(handle).request(path, { method, headers: { "X-Dev-User": who } });

  beforeAll(async () => {
    process.env.NODE_ENV = "development";
    process.env.DEV_AUTH_BYPASS = "1";
    handle = createDb(TEST_DATABASE_URL!);
    const [t] = await handle.db.insert(schema.team).values({ name: `in-${RUN}` }).returning({ id: schema.team.id });
    const [t2] = await handle.db.insert(schema.team).values({ name: `in2-${RUN}` }).returning({ id: schema.team.id });
    const users = await handle.db
      .insert(schema.user)
      .values([
        { teamId: t!.id, email: A, role: "hunter" },
        { teamId: t2!.id, email: B, role: "hunter" }, // another team
        { teamId: t!.id, email: D, role: "hunter" }, // teammate of A
      ])
      .returning({ id: schema.user.id, email: schema.user.email });
    const a = users.find((u) => u.email === A)!.id;
    const b = users.find((u) => u.email === B)!.id;
    const mk = (userId: string, i: number, delivery: string, teamId: string = t!.id) => ({
      teamId,
      userId,
      kind: "digest",
      day: `2026-10-0${i + 1}`,
      dedupeKey: `in-${RUN}-${userId}-${i}`,
      payload: {},
      text: `insight ${i}`,
      delivery,
      createdAt: new Date(Date.UTC(2026, 9, 1 + i)),
    });
    const rows = await handle.db
      .insert(schema.insight)
      .values([mk(a, 0, "inbox"), mk(a, 1, "sent"), mk(a, 2, "failed"), mk(b, 0, "inbox", t2!.id)])
      .returning({ id: schema.insight.id, userId: schema.insight.userId, text: schema.insight.text });
    ids = rows.filter((r) => r.userId === a).sort((x, y) => y.text.localeCompare(x.text)).map((r) => r.id);
  });

  afterAll(async () => {
    await handle.close();
  });

  test("lists the team's rows newest first with keyset cursor and unread count", async () => {
    const p1 = (await (await call("GET", "/api/insights?limit=2", A)).json()) as Page;
    expect(p1.items.map((i) => i.id)).toEqual(ids.slice(0, 2));
    expect(p1.unread).toBe(3);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = (await (await call("GET", `/api/insights?limit=2&cursor=${p1.nextCursor}`, A)).json()) as Page;
    expect(p2.items.map((i) => i.id)).toEqual(ids.slice(2));
    expect(p2.nextCursor).toBeNull();
    expect((await call("GET", "/api/insights?cursor=garbage", A)).status).toBe(400);
    expect(((await (await call("GET", "/api/insights", B)).json()) as Page).items).toHaveLength(1);
  });

  test("POST /read marks a row read (idempotent); another team's row is 404", async () => {
    expect((await call("POST", `/api/insights/${ids[0]}/read`, B)).status).toBe(404);
    expect((await call("POST", `/api/insights/${ids[0]}/read`, A)).status).toBe(204);
    expect((await call("POST", `/api/insights/${ids[0]}/read`, A)).status).toBe(204);
    const page = (await (await call("GET", "/api/insights", A)).json()) as Page;
    expect(page.unread).toBe(2);
    expect(page.items[0]!.readAt).not.toBeNull();
    expect((await call("POST", "/api/insights/nope/read", A)).status).toBe(404);
  });

  test("A teammate sees the creator's insights (mine false) and may mark them read; read state is shared", async () => {
    const page = (await (await call("GET", "/api/insights", D)).json()) as Page & { items: { id: string; mine: boolean }[] };
    expect(page.items.map((i) => i.id)).toEqual(ids);
    expect(page.items.every((i) => i.mine === false)).toBe(true);
    const aPage = (await (await call("GET", "/api/insights", A)).json()) as { items: { mine: boolean }[] };
    expect(aPage.items.every((i) => i.mine)).toBe(true);
    expect((await call("POST", `/api/insights/${ids[2]}/read`, D)).status).toBe(204);
    const after = (await (await call("GET", "/api/insights", A)).json()) as Page;
    expect(after.items.find((i) => i.id === ids[2])?.readAt).not.toBeNull();
  });
});
