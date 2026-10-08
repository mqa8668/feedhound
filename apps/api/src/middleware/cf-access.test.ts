import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../index";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const MUST_RUN = Boolean(process.env.CI) || Boolean(TEST_DATABASE_URL);

function isTestDbUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    return new URL(url).pathname.replace(/^\//, "").endsWith("_test");
  } catch {
    return false;
  }
}

if (TEST_DATABASE_URL && !isTestDbUrl(TEST_DATABASE_URL)) {
  throw new Error("TEST_DATABASE_URL must point at a database whose name ends in '_test'");
}

let canRun = false;
if (TEST_DATABASE_URL) {
  const probe = createDb(TEST_DATABASE_URL);
  let reachable = true;
  try {
    await probe.sql`select 1`;
  } catch (err) {
    reachable = false;
    if (MUST_RUN) {
      await probe.close();
      throw err;
    }
    console.warn(`cf-access.test.ts: skipped — TEST_DATABASE_URL unreachable: ${String(err)}`);
  }
  if (reachable) {
    const rows = await probe.sql<{ name: string }[]>`select current_database() as name`;
    const name = rows[0]?.name;
    if (!name || !name.endsWith("_test")) {
      await probe.close();
      throw new Error(`refusing to run against non-test database: ${name ?? "unknown"}`);
    }
    canRun = true;
  }
  await probe.close();
} else if (MUST_RUN) {
  throw new Error("cf-access.test.ts: TEST_DATABASE_URL is required (CI is set)");
} else {
  console.warn("cf-access.test.ts: skipped — TEST_DATABASE_URL is unset");
}

const AUD = "test-aud";
const TEAM_DOMAIN = "example.cloudflareaccess.com";
const KID = "test-kid-1";

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlJson(obj: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(obj)));
}

async function generateKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, [
    "sign",
    "verify",
  ]) as Promise<CryptoKeyPair>;
}

async function signJwt(privateKey: CryptoKey, payload: Record<string, unknown>, kid = KID): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", kid };
  const signedInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(signedInput));
  return `${signedInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

describe.skipIf(!canRun)("cf-access middleware", () => {
  let handle: DbHandle;
  let teamId: string;
  let provisionedEmail: string;
  let keyPair: CryptoKeyPair;
  let jwk: { kty: string; n: string; e: string };
  let originalEnv: Record<string, string | undefined>;

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL);
    keyPair = await generateKeyPair();
    jwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as unknown as { kty: string; n: string; e: string };

    const [team] = await handle.db.insert(schema.team).values({ name: "cf-access-test-team" }).returning({ id: schema.team.id });
    teamId = team!.id;
    provisionedEmail = `cf-access-${crypto.randomUUID()}@example.com`;
    await handle.db.insert(schema.user).values({ teamId, email: provisionedEmail, role: "hunter" });

    originalEnv = {
      NODE_ENV: process.env.NODE_ENV,
      CF_ACCESS_AUD: process.env.CF_ACCESS_AUD,
      CF_ACCESS_TEAM_DOMAIN: process.env.CF_ACCESS_TEAM_DOMAIN,
      DEV_USER_EMAIL: process.env.DEV_USER_EMAIL,
      DEV_AUTH_BYPASS: process.env.DEV_AUTH_BYPASS,
      AUTH_MODE: process.env.AUTH_MODE,
    };
    delete process.env.DEV_AUTH_BYPASS;
    process.env.AUTH_MODE = "cf-access";
    process.env.CF_ACCESS_AUD = AUD;
    process.env.CF_ACCESS_TEAM_DOMAIN = TEAM_DOMAIN;

    // Serve the JWKS from a real local HTTP server (undici's global fetch,
    // used internally by cf-access.ts, does not honour `globalThis.fetch`
    // overrides in every Bun version) so `fetchJwks` reaches actual keys.
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/cdn-cgi/access/certs")) {
        return Promise.resolve(
          new Response(JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: "RS256" }] }), { headers: { "content-type": "application/json" } }),
        );
      }
      return originalFetch(input, init);
    }) as typeof fetch;
  });

  const originalFetch = fetch;

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(originalEnv)) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await handle.db.delete(schema.user).where(eq(schema.user.teamId, teamId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await handle.close();
  });

  function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      email: provisionedEmail,
      aud: AUD,
      iss: `https://${TEAM_DOMAIN}`,
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...overrides,
    };
  }

  test("no JWT -> 401", async () => {
    const app = createApp(handle);
    const res = await app.request("/api/me");
    expect(res.status).toBe(401);
  });

  test("JWT signed by an unknown key -> 401", async () => {
    const otherKeyPair = await generateKeyPair();
    const token = await signJwt(otherKeyPair.privateKey, validPayload(), "unknown-kid");
    const app = createApp(handle);
    const res = await app.request("/api/me", { headers: { "Cf-Access-Jwt-Assertion": token } });
    expect(res.status).toBe(401);
  });

  test("wrong aud -> 401", async () => {
    const token = await signJwt(keyPair.privateKey, validPayload({ aud: "someone-else" }));
    const app = createApp(handle);
    const res = await app.request("/api/me", { headers: { "Cf-Access-Jwt-Assertion": token } });
    expect(res.status).toBe(401);
  });

  test("expired -> 401", async () => {
    const token = await signJwt(keyPair.privateKey, validPayload({ exp: Math.floor(Date.now() / 1000) - 10 }));
    const app = createApp(handle);
    const res = await app.request("/api/me", { headers: { "Cf-Access-Jwt-Assertion": token } });
    expect(res.status).toBe(401);
  });

  test("valid JWT with email not in User -> 403 not_provisioned", async () => {
    const token = await signJwt(keyPair.privateKey, validPayload({ email: `unknown-${crypto.randomUUID()}@example.com` }));
    const app = createApp(handle);
    const res = await app.request("/api/me", { headers: { "Cf-Access-Jwt-Assertion": token } });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_provisioned");
  });

  test("valid JWT with a provisioned email -> 200", async () => {
    const token = await signJwt(keyPair.privateKey, validPayload());
    const app = createApp(handle);
    const res = await app.request("/api/me", { headers: { "Cf-Access-Jwt-Assertion": token } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { email: string };
    expect(body.email).toBe(provisionedEmail);
  });

  // The bypass used to be inferred from `NODE_ENV === "development"` alone —
  // exactly the variable a misconfigured deploy is most likely to omit/misset. It is now
  // gated on the explicit `DEV_AUTH_BYPASS=1` opt-in instead, decoupled from `NODE_ENV`.
  test("X-Dev-User with NODE_ENV=development but DEV_AUTH_BYPASS unset -> 401 (header ignored)", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.DEV_AUTH_BYPASS;
    try {
      const app = createApp(handle);
      const res = await app.request("/api/me", { headers: { "X-Dev-User": provisionedEmail } });
      expect(res.status).toBe(401);
    } finally {
      process.env.NODE_ENV = originalEnv.NODE_ENV;
    }
  });

  test("X-Dev-User with DEV_AUTH_BYPASS=1 -> 200, regardless of NODE_ENV", async () => {
    process.env.DEV_AUTH_BYPASS = "1";
    try {
      const app = createApp(handle);
      const res = await app.request("/api/me", { headers: { "X-Dev-User": provisionedEmail } });
      expect(res.status).toBe(200);
    } finally {
      process.env.DEV_AUTH_BYPASS = originalEnv.DEV_AUTH_BYPASS;
    }
  });

  test("X-Dev-User with DEV_AUTH_BYPASS unset -> 401, even with NODE_ENV=production", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.DEV_AUTH_BYPASS;
    try {
      const app = createApp(handle);
      const res = await app.request("/api/me", { headers: { "X-Dev-User": provisionedEmail } });
      expect(res.status).toBe(401);
    } finally {
      process.env.NODE_ENV = originalEnv.NODE_ENV;
    }
  });

  // the headerless `DEV_USER_EMAIL` bypass granted
  // a full session with zero credentials whenever it was set. It has been
  // removed — only the explicit `X-Dev-User` header may
  // authenticate in dev.
  test("DEV_USER_EMAIL env var alone (no X-Dev-User header) -> 401, even with DEV_AUTH_BYPASS=1", async () => {
    process.env.DEV_AUTH_BYPASS = "1";
    process.env.DEV_USER_EMAIL = provisionedEmail;
    try {
      const app = createApp(handle);
      const res = await app.request("/api/me");
      expect(res.status).toBe(401);
    } finally {
      process.env.DEV_AUTH_BYPASS = originalEnv.DEV_AUTH_BYPASS;
      if (originalEnv.DEV_USER_EMAIL === undefined) delete process.env.DEV_USER_EMAIL;
      else process.env.DEV_USER_EMAIL = originalEnv.DEV_USER_EMAIL;
    }
  });
});
