export type AuthMode = "local" | "cf-access";

/** `AUTH_MODE` (default `local`). Read fresh on every call so tests can flip it. Throws on an unknown value. */
export function authMode(env: Record<string, string | undefined> = process.env): AuthMode {
  const raw = (env.AUTH_MODE ?? "").trim().toLowerCase();
  if (raw === "" || raw === "local") return "local";
  if (raw === "cf-access") return "cf-access";
  throw new Error(`AUTH_MODE must be "local" or "cf-access" (got "${env.AUTH_MODE}")`);
}

export function isProduction(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV === "production";
}

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1") return true;
  return /^127(\.\d{1,3}){3}$/.test(h);
}

function publicHost(env: Record<string, string | undefined>): string | undefined {
  const url = env.PUBLIC_URL?.trim();
  if (url) {
    try {
      return new URL(url.includes("://") ? url : `https://${url}`).hostname;
    } catch {
      return url;
    }
  }
  const hostname = env.PUBLIC_HOSTNAME?.trim();
  if (!hostname) return undefined;
  try {
    return new URL(hostname.includes("://") ? hostname : `https://${hostname}`).hostname;
  } catch {
    return hostname;
  }
}

export interface LocalAuthConfig {
  passwordHash: string | undefined;
  /** Plaintext password; only honoured outside production. */
  passwordPlain: string | undefined;
  allowNoPassword: boolean;
}

export function localAuthConfig(env: Record<string, string | undefined> = process.env): LocalAuthConfig {
  const hash = env.AUTH_PASSWORD_HASH?.trim() || undefined;
  const plain = !isProduction(env) ? env.AUTH_PASSWORD || undefined : undefined;
  return { passwordHash: hash, passwordPlain: plain, allowNoPassword: env.AUTH_ALLOW_NO_PASSWORD === "1" };
}

/** True when local mode runs with no password configured and the operator explicitly allowed it. */
export function noPasswordAllowed(env: Record<string, string | undefined> = process.env): boolean {
  const cfg = localAuthConfig(env);
  return authMode(env) === "local" && !cfg.passwordHash && !cfg.passwordPlain && cfg.allowNoPassword;
}

/**
 * Boot-time auth configuration check. Throws with a clear message when the
 * configuration would leave the dashboard unprotected. Returns warnings to log.
 */
export function assertAuthConfig(env: Record<string, string | undefined> = process.env): string[] {
  const mode = authMode(env);
  const warnings: string[] = [];
  if (env.DEV_AUTH_BYPASS === "1" && (isProduction(env) || env.CF_ACCESS_AUD)) {
    throw new Error("auth: refusing to start with DEV_AUTH_BYPASS=1 while NODE_ENV=production or CF_ACCESS_AUD is set");
  }
  if (mode === "cf-access") return warnings;

  const host = publicHost(env);
  if (host && !isLoopbackHost(host) && env.AUTH_MODE_LOCAL_I_KNOW !== "1") {
    throw new Error(
      `auth: AUTH_MODE=local but PUBLIC_URL/PUBLIC_HOSTNAME points at a non-loopback host (${host}). ` +
        "Single-user local auth is meant for loopback use. Use AUTH_MODE=cf-access, or set AUTH_MODE_LOCAL_I_KNOW=1 to accept the risk.",
    );
  }
  const cfg = localAuthConfig(env);
  const hasPassword = Boolean(cfg.passwordHash || cfg.passwordPlain);
  if (isProduction(env) && !cfg.passwordHash && !cfg.allowNoPassword) {
    throw new Error(
      "auth: AUTH_MODE=local in production requires AUTH_PASSWORD_HASH (AUTH_PASSWORD plaintext is ignored in production). " +
        "Generate one with: bun -e 'console.log(await Bun.password.hash(\"your-password\"))'. " +
        "Loopback-only setups can set AUTH_ALLOW_NO_PASSWORD=1 instead.",
    );
  }
  if (cfg.passwordPlain && !cfg.passwordHash) warnings.push("auth: using plaintext AUTH_PASSWORD (development only); set AUTH_PASSWORD_HASH instead");
  if (!hasPassword && cfg.allowNoPassword) warnings.push("auth: AUTH_ALLOW_NO_PASSWORD=1, the dashboard has NO password; keep it bound to loopback");
  if (!hasPassword && !cfg.allowNoPassword) warnings.push("auth: no AUTH_PASSWORD_HASH set, login is disabled until one is configured");
  if (!env.SESSION_SECRET) warnings.push("auth: SESSION_SECRET is unset, using a random secret; sessions reset on every restart");
  return warnings;
}

/** Password of the demo hash published in docker-compose.yml. */
export const DEMO_PASSWORD = "demo";

/** True when `hash` verifies the published demo password. A malformed hash is not the demo hash. */
export async function isDemoPasswordHash(hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(DEMO_PASSWORD, hash);
  } catch {
    return false;
  }
}

/**
 * Boot-time guard against running with the published demo hash. In local mode, a configured hash that verifies
 * the password "demo" is refused when NODE_ENV=production unless one of these holds:
 *   - AUTH_ALLOW_DEMO_PASSWORD=1, or
 *   - the database has config `demo.enabled=true` (written only by the demo seed; `demoEnabled` reads it).
 * Outside production the demo hash is always accepted.
 */
export async function assertNotDemoHash(
  env: Record<string, string | undefined> = process.env,
  demoEnabled: () => Promise<boolean> = async () => false,
): Promise<void> {
  if (authMode(env) !== "local" || !isProduction(env) || env.AUTH_ALLOW_DEMO_PASSWORD === "1") return;
  const hash = localAuthConfig(env).passwordHash;
  if (!hash || !(await isDemoPasswordHash(hash))) return;
  if (await demoEnabled().catch(() => false)) return;
  throw new Error(
    "auth: refusing to start: AUTH_PASSWORD_HASH is the published demo hash (password 'demo'); " +
      "set your own hash (bun -e \"console.log(await Bun.password.hash('...'))\")",
  );
}
