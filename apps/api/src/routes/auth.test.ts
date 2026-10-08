import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../index";
import { isDevBypassEnabled } from "../middleware/cf-access";
import { resetLoginRateLimit, signSessionCookie, SESSION_COOKIE } from "../middleware/local-auth";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL && !new URL(TEST_DATABASE_URL).pathname.replace(/^\//, "").endsWith("_test")) {
  throw new Error("TEST_DATABASE_URL must point at a database whose name ends in '_test'");
}
const PASSWORD = "correct horse battery";
const ENV_KEYS = ["AUTH_MODE", "AUTH_PASSWORD_HASH", "AUTH_PASSWORD", "SESSION_SECRET", "SEED_OPERATOR_EMAIL", "AUTH_COOKIE_SECURE", "DEV_AUTH_BYPASS", "NODE_ENV", "AUTH_ALLOW_NO_PASSWORD"];

describe.skipIf(!TEST_DATABASE_URL)("local auth routes", () => {
  let handle: DbHandle;
  let teamId: string;
  let operatorEmail: string;
  const saved: Record<string, string | undefined> = {};
  const app = () => createApp(handle);
  const login = (password: unknown, headers: Record<string, string> = {}) =>
    app().request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers },
      body: JSON.stringify({ password }),
    });
  const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;

  beforeAll(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    handle = createDb(TEST_DATABASE_URL);
    const [team] = await handle.db.insert(schema.team).values({ name: "local-auth-test" }).returning({ id: schema.team.id });
    teamId = team!.id;
    operatorEmail = `op-${crypto.randomUUID()}@example.com`;
    await handle.db.insert(schema.user).values({ teamId, email: operatorEmail, role: "operator" });
  });
  afterAll(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await handle.db.delete(schema.user).where(eq(schema.user.teamId, teamId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });
  beforeEach(async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.AUTH_PASSWORD_HASH = await Bun.password.hash(PASSWORD, { algorithm: "bcrypt", cost: 4 });
    process.env.SESSION_SECRET = "test-secret";
    process.env.SEED_OPERATOR_EMAIL = operatorEmail;
    resetLoginRateLimit();
  });
  afterEach(() => resetLoginRateLimit());

  test("status is public and reports unauthenticated", async () => {
    const res = await app().request("/api/auth/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mode: "local", authenticated: false });
  });

  test("login success sets a hardened cookie that resolves to the operator", async () => {
    const res = await login(PASSWORD);
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Max-Age=604800");
    expect(setCookie).not.toContain("Secure");

    const me = await app().request("/api/me", { headers: { cookie: cookieOf(res) } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { email: string; role: string }).email).toBe(operatorEmail);
    const status = await app().request("/api/auth/status", { headers: { cookie: cookieOf(res) } });
    expect(await status.json()).toEqual({ mode: "local", authenticated: true });
  });

  test("Secure flag on https requests, x-forwarded-proto and AUTH_COOKIE_SECURE=1", async () => {
    expect((await login(PASSWORD, { "x-forwarded-proto": "https" })).headers.get("set-cookie")).toContain("Secure");
    resetLoginRateLimit();
    process.env.AUTH_COOKIE_SECURE = "1";
    expect((await login(PASSWORD)).headers.get("set-cookie")).toContain("Secure");
  });

  test("wrong or missing password -> 401 without a cookie", async () => {
    for (const bad of ["nope", "", undefined, 42]) {
      const res = await login(bad);
      expect(res.status).toBe(401);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(await res.json()).toEqual({ error: "invalid_credentials" });
    }
  });

  test("rate limit: 6th attempt within a minute -> 429", async () => {
    for (let i = 0; i < 5; i++) expect((await login("bad", { "x-forwarded-for": "9.9.9.9" })).status).toBe(401);
    const res = await login(PASSWORD, { "x-forwarded-for": "9.9.9.9" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect((await login(PASSWORD, { "x-forwarded-for": "8.8.8.8" })).status).toBe(200);
  });

  test("no hash configured -> 503 login_disabled; plaintext works outside production only", async () => {
    delete process.env.AUTH_PASSWORD_HASH;
    expect((await login(PASSWORD)).status).toBe(503);
    process.env.AUTH_PASSWORD = "plain-pass";
    expect((await login("plain-pass")).status).toBe(200);
    resetLoginRateLimit();
    process.env.NODE_ENV = "production";
    expect((await login("plain-pass")).status).toBe(503);
  });

  test("logout clears the cookie", async () => {
    const res = await app().request("/api/auth/logout", { method: "POST", headers: { cookie: "fh_session=x", "sec-fetch-site": "same-origin" } });
    expect(res.status).toBe(200);
    const c = res.headers.get("set-cookie")!;
    expect(c).toContain("Max-Age=0");
    expect(c).toContain("HttpOnly");
  });

  test("no cookie -> 401 unauthenticated; tampered, foreign-secret and expired cookies rejected", async () => {
    expect((await app().request("/api/me")).status).toBe(401);
    const good = signSessionCookie();
    const [payload, sig] = good.split(".");
    const forged = Buffer.from(JSON.stringify({ v: 1, exp: Math.floor(Date.now() / 1000) + 999999 })).toString("base64url");
    const expired = signSessionCookie(Math.floor(Date.now() / 1000) - 8 * 24 * 3600);
    process.env.SESSION_SECRET = "other-secret";
    const otherSecret = signSessionCookie();
    process.env.SESSION_SECRET = "test-secret";
    for (const bad of [`${forged}.${sig}`, `${payload}.${sig}x`, `${payload}`, expired, otherSecret, "garbage"]) {
      const res = await app().request("/api/me", { headers: { cookie: `${SESSION_COOKIE}=${bad}` } });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: string }).error).toBe("unauthenticated");
    }
    expect((await app().request("/api/me", { headers: { cookie: `${SESSION_COOKIE}=${good}` } })).status).toBe(200);
  });

  test("operator falls back to the oldest operator when SEED_OPERATOR_EMAIL is unset", async () => {
    delete process.env.SEED_OPERATOR_EMAIL;
    const res = await app().request("/api/auth/status", { headers: { cookie: `${SESSION_COOKIE}=${signSessionCookie()}` } });
    expect(((await res.json()) as { authenticated: boolean }).authenticated).toBe(true);
  });

  test("CSRF: cookie-authenticated writes need same-origin or the custom header", async () => {
    const cookie = `${SESSION_COOKIE}=${signSessionCookie()}`;
    const post = (headers: Record<string, string>) =>
      app().request("/api/auth/logout", { method: "POST", headers: { cookie, host: "localhost:4823", ...headers } });
    expect((await post({ "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await post({ origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ origin: "https://evil.example", "x-requested-with": "feedhound" })).status).toBe(403);
    expect((await post({})).status).toBe(403);
    expect((await post({ "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect((await post({ origin: "http://localhost:4823" })).status).toBe(200);
    expect((await post({ "x-requested-with": "feedhound" })).status).toBe(200);
    // GET is never blocked
    expect((await app().request("/api/auth/status", { headers: { cookie, "sec-fetch-site": "cross-site" } })).status).toBe(200);
  });

  test("login itself rejects cross-site requests", async () => {
    expect((await login(PASSWORD, { "sec-fetch-site": "cross-site" })).status).toBe(403);
  });

  test("AUTH_MODE=cf-access: login unavailable, cookie ignored", async () => {
    process.env.AUTH_MODE = "cf-access";
    expect((await login(PASSWORD)).status).toBe(404);
    const res = await app().request("/api/me", { headers: { cookie: `${SESSION_COOKIE}=${signSessionCookie()}` } });
    expect(res.status).toBe(401);
    expect(await (await app().request("/api/auth/status")).json()).toEqual({ mode: "cf-access", authenticated: false });
  });

  test("X-Dev-User: honoured only with DEV_AUTH_BYPASS=1 and never in production", async () => {
    const hdr = { "X-Dev-User": operatorEmail };
    expect((await app().request("/api/me", { headers: hdr })).status).toBe(401);
    process.env.DEV_AUTH_BYPASS = "1";
    expect((await app().request("/api/me", { headers: hdr })).status).toBe(200);
    process.env.NODE_ENV = "production";
    expect(isDevBypassEnabled()).toBe(false);
    expect((await app().request("/api/me", { headers: hdr })).status).toBe(401);
  });
});
