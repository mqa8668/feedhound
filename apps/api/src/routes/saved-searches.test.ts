import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "../index";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL && process.env.CI) throw new Error("saved-searches.test.ts: TEST_DATABASE_URL is required (CI is set)");
if (TEST_DATABASE_URL && !new URL(TEST_DATABASE_URL).pathname.replace(/^\//, "").endsWith("_test")) {
  throw new Error("TEST_DATABASE_URL must point at a database whose name ends in '_test'");
}
const canRun = Boolean(TEST_DATABASE_URL);

describe.skipIf(!canRun)("/api/saved-searches", () => {
  const RUN = crypto.randomUUID().slice(0, 8);
  const A = `ss-a-${RUN}@example.com`;
  const B = `ss-b-${RUN}@example.com`;
  const O = `ss-o-${RUN}@example.com`;
  const C = `ss-c-${RUN}@example.com`;
  let handle: DbHandle;

  const call = (method: string, path: string, who: string, body?: unknown): Response | Promise<Response> =>
    createApp(handle).request(path, {
      method,
      headers: { "X-Dev-User": who, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  beforeAll(async () => {
    process.env.NODE_ENV = "development";
    process.env.DEV_AUTH_BYPASS = "1";
    handle = createDb(TEST_DATABASE_URL!);
    const [t] = await handle.db.insert(schema.team).values({ name: `ss-${RUN}` }).returning({ id: schema.team.id });
    const [t2] = await handle.db.insert(schema.team).values({ name: `ss2-${RUN}` }).returning({ id: schema.team.id });
    await handle.db.insert(schema.user).values([
      { teamId: t!.id, email: A, role: "hunter" },
      { teamId: t!.id, email: B, role: "hunter" },
      { teamId: t!.id, email: O, role: "operator" },
      { teamId: t2!.id, email: C, role: "hunter" },
    ]);
  });

  afterAll(async () => {
    await handle.close();
  });

  test("team-visible CRUD, 403 not_owner for a teammate, 404 across teams, duplicate name 409, 51st 409", async () => {
    const params = { q: "ip15 -seal", priceMax: 20000000, sort: "newest" };
    const created = await call("POST", "/api/saved-searches", A, { name: "first", params });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const list = (await (await call("GET", "/api/saved-searches", A)).json()) as { items: { id: string; name: string; params: unknown }[] };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ id, name: "first", params });
    expect(list.items[0]).toMatchObject({ mine: true });
    // a teammate sees it (mine: false); another team does not
    const listB = (await (await call("GET", "/api/saved-searches", B)).json()) as { items: { id: string; mine: boolean }[] };
    expect(listB.items).toHaveLength(1);
    expect(listB.items[0]).toMatchObject({ id, mine: false });
    expect(((await (await call("GET", "/api/saved-searches", C)).json()) as { items: unknown[] }).items).toHaveLength(0);

    const hijack = await call("PATCH", `/api/saved-searches/${id}`, B, { name: "hijack" });
    expect(hijack.status).toBe(403);
    expect(((await hijack.json()) as { error: string }).error).toBe("not_owner");
    expect((await call("DELETE", `/api/saved-searches/${id}`, B)).status).toBe(403);
    expect((await call("PATCH", `/api/saved-searches/${id}`, C, { name: "hijack" })).status).toBe(404);
    expect((await call("DELETE", `/api/saved-searches/${id}`, C)).status).toBe(404);
    expect((await call("PATCH", `/api/saved-searches/${id}`, O, { name: "first" })).status).toBe(200); // operator of the team
    expect((await call("PATCH", `/api/saved-searches/not-a-uuid`, A, { name: "x" })).status).toBe(404);

    const dup = await call("POST", "/api/saved-searches", A, { name: "first", params: {} });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: string }).error).toBe("duplicate_name");

    const patched = await call("PATCH", `/api/saved-searches/${id}`, A, { name: "renamed", params: { q: "iphone" } });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ id, name: "renamed", params: { q: "iphone" } });
    expect((await call("PATCH", `/api/saved-searches/${id}`, A, { name: "x".repeat(61) })).status).toBe(400);
    // paging state is not storable
    expect((await call("POST", "/api/saved-searches", A, { name: "paged", params: { cursor: "abc" } })).status).toBe(400);

    for (let i = 2; i <= 50; i++) expect((await call("POST", "/api/saved-searches", A, { name: `s${i}`, params: { q: `term${i}` } })).status).toBe(201);
    const over = await call("POST", "/api/saved-searches", A, { name: "s51", params: {} });
    expect(over.status).toBe(409);
    expect(((await over.json()) as { error: string }).error).toBe("limit_reached");

    expect((await call("DELETE", `/api/saved-searches/${id}`, A)).status).toBe(204);
    expect((await call("DELETE", `/api/saved-searches/${id}`, A)).status).toBe(404);
  }, 30_000);
});
