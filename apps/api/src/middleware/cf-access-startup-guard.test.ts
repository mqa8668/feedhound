import { describe, expect, test } from "bun:test";

/**
 * `cf-access.ts` throws at module load if
 * `DEV_AUTH_BYPASS=1` (X-Dev-User bypass live) while this looks like a real deployment
 * (`CF_ACCESS_AUD` set and/or `NODE_ENV=production`) — this must happen once at process
 * boot, not per-request, so it has to be exercised in a fresh process rather than the
 * shared test runner (where other suites legitimately flip these vars after `cf-access.ts`
 * is already loaded and cached).
 */
describe("cf-access startup guard", () => {
  test("throws at import time when DEV_AUTH_BYPASS=1 and CF_ACCESS_AUD is set", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "-e", "await import('./cf-access.ts')"],
      cwd: import.meta.dir,
      env: { ...process.env, NODE_ENV: "development", DEV_AUTH_BYPASS: "1", CF_ACCESS_AUD: "some-aud", CF_ACCESS_TEAM_DOMAIN: "", DEV_USER_EMAIL: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("refusing to start");
  });

  test("throws at import time when DEV_AUTH_BYPASS=1 and NODE_ENV=production (compose default), even with CF_ACCESS_AUD unset", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "-e", "await import('./cf-access.ts')"],
      cwd: import.meta.dir,
      env: { ...process.env, NODE_ENV: "production", DEV_AUTH_BYPASS: "1", CF_ACCESS_AUD: "", CF_ACCESS_TEAM_DOMAIN: "", DEV_USER_EMAIL: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("refusing to start");
  });

  test("does not throw when NODE_ENV=development and CF_ACCESS_AUD is set but DEV_AUTH_BYPASS is unset", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "-e", "await import('./cf-access.ts')"],
      cwd: import.meta.dir,
      env: { ...process.env, NODE_ENV: "development", DEV_AUTH_BYPASS: "", CF_ACCESS_AUD: "some-aud", CF_ACCESS_TEAM_DOMAIN: "", DEV_USER_EMAIL: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  });

  test("does not throw when NODE_ENV=development and DEV_AUTH_BYPASS=1 and CF_ACCESS_AUD is unset (normal local dev)", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "-e", "await import('./cf-access.ts')"],
      cwd: import.meta.dir,
      env: { ...process.env, NODE_ENV: "development", DEV_AUTH_BYPASS: "1", CF_ACCESS_AUD: "", CF_ACCESS_TEAM_DOMAIN: "", DEV_USER_EMAIL: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  });
});
