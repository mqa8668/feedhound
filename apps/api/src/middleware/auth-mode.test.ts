import { beforeAll, describe, expect, test } from "bun:test";
import { assertAuthConfig, assertNotDemoHash, authMode, isLoopbackHost, noPasswordAllowed } from "./auth-mode";

const HASH = "$argon2id$stub";

describe("authMode", () => {
  test("defaults to local; accepts cf-access; rejects junk", () => {
    expect(authMode({})).toBe("local");
    expect(authMode({ AUTH_MODE: "" })).toBe("local");
    expect(authMode({ AUTH_MODE: "CF-Access" })).toBe("cf-access");
    expect(() => authMode({ AUTH_MODE: "nope" })).toThrow();
  });
});

describe("isLoopbackHost", () => {
  test.each(["localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]", "app.localhost"])("%s is loopback", (h) => {
    expect(isLoopbackHost(h)).toBe(true);
  });
  test.each(["example.com", "10.0.0.5", "0.0.0.0", "127.0.0.1.evil.com"])("%s is not loopback", (h) => {
    expect(isLoopbackHost(h)).toBe(false);
  });
});

describe("assertAuthConfig", () => {
  test("local + loopback PUBLIC_URL passes", () => {
    expect(() => assertAuthConfig({ PUBLIC_URL: "http://localhost:4823", AUTH_PASSWORD_HASH: HASH, SESSION_SECRET: "s" })).not.toThrow();
  });
  test("local + public hostname refuses unless AUTH_MODE_LOCAL_I_KNOW=1", () => {
    expect(() => assertAuthConfig({ PUBLIC_HOSTNAME: "hound.example.com", AUTH_PASSWORD_HASH: HASH })).toThrow(/non-loopback/);
    expect(() => assertAuthConfig({ PUBLIC_URL: "https://hound.example.com", AUTH_PASSWORD_HASH: HASH })).toThrow(/non-loopback/);
    expect(() => assertAuthConfig({ PUBLIC_HOSTNAME: "hound.example.com", AUTH_PASSWORD_HASH: HASH, AUTH_MODE_LOCAL_I_KNOW: "1" })).not.toThrow();
  });
  test("cf-access mode ignores the public host check", () => {
    expect(() => assertAuthConfig({ AUTH_MODE: "cf-access", PUBLIC_HOSTNAME: "hound.example.com" })).not.toThrow();
  });
  test("production without a hash refuses; plaintext does not count", () => {
    expect(() => assertAuthConfig({ NODE_ENV: "production" })).toThrow(/AUTH_PASSWORD_HASH/);
    expect(() => assertAuthConfig({ NODE_ENV: "production", AUTH_PASSWORD: "hunter2" })).toThrow(/AUTH_PASSWORD_HASH/);
    expect(() => assertAuthConfig({ NODE_ENV: "production", AUTH_PASSWORD_HASH: HASH })).not.toThrow();
    expect(() => assertAuthConfig({ NODE_ENV: "production", AUTH_ALLOW_NO_PASSWORD: "1" })).not.toThrow();
  });
  test("plaintext password warns outside production", () => {
    expect(assertAuthConfig({ AUTH_PASSWORD: "x", SESSION_SECRET: "s" }).join(" ")).toContain("plaintext");
  });
  test("DEV_AUTH_BYPASS is refused in production in either mode", () => {
    expect(() => assertAuthConfig({ NODE_ENV: "production", DEV_AUTH_BYPASS: "1", AUTH_PASSWORD_HASH: HASH })).toThrow(/DEV_AUTH_BYPASS/);
    expect(() => assertAuthConfig({ NODE_ENV: "production", AUTH_MODE: "cf-access", DEV_AUTH_BYPASS: "1" })).toThrow(/DEV_AUTH_BYPASS/);
  });
  test("noPasswordAllowed needs the explicit flag and no password", () => {
    expect(noPasswordAllowed({ AUTH_ALLOW_NO_PASSWORD: "1" })).toBe(true);
    expect(noPasswordAllowed({ AUTH_ALLOW_NO_PASSWORD: "1", AUTH_PASSWORD_HASH: HASH })).toBe(false);
    expect(noPasswordAllowed({})).toBe(false);
  });
});

describe("assertNotDemoHash", () => {
  let demoHash: string;
  beforeAll(async () => {
    demoHash = await Bun.password.hash("demo");
  });
  const prod = (extra: Record<string, string> = {}) => ({ NODE_ENV: "production", ...extra });

  test("refuses the demo hash in production", async () => {
    await expect(assertNotDemoHash(prod({ AUTH_PASSWORD_HASH: demoHash }))).rejects.toThrow(/published demo hash/);
  });
  test("accepts a different hash in production", async () => {
    await expect(assertNotDemoHash(prod({ AUTH_PASSWORD_HASH: await Bun.password.hash("other") }))).resolves.toBeUndefined();
  });
  test("accepts the demo hash with AUTH_ALLOW_DEMO_PASSWORD=1, outside production, or when the demo seed marker exists", async () => {
    await expect(assertNotDemoHash(prod({ AUTH_PASSWORD_HASH: demoHash, AUTH_ALLOW_DEMO_PASSWORD: "1" }))).resolves.toBeUndefined();
    await expect(assertNotDemoHash({ NODE_ENV: "development", AUTH_PASSWORD_HASH: demoHash })).resolves.toBeUndefined();
    await expect(assertNotDemoHash(prod({ AUTH_PASSWORD_HASH: demoHash }), async () => true)).resolves.toBeUndefined();
  });
  test("a failing marker lookup does not whitelist the demo hash", async () => {
    await expect(assertNotDemoHash(prod({ AUTH_PASSWORD_HASH: demoHash }), async () => Promise.reject(new Error("db down")))).rejects.toThrow(/demo hash/);
  });
  test("ignored in cf-access mode and for malformed hashes", async () => {
    await expect(assertNotDemoHash(prod({ AUTH_MODE: "cf-access", AUTH_PASSWORD_HASH: demoHash }))).resolves.toBeUndefined();
    await expect(assertNotDemoHash(prod({ AUTH_PASSWORD_HASH: "$argon2id$stub" }))).resolves.toBeUndefined();
  });
});
