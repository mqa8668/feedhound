import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { asc, eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { localAuthConfig, noPasswordAllowed } from "./auth-mode";
import type { Session } from "./cf-access";

export const SESSION_COOKIE = "fh_session";
export const SESSION_TTL_SEC = 7 * 24 * 60 * 60;
export const CSRF_HEADER = "x-requested-with";

let randomSecret: string | undefined;

function sessionSecret(): string {
  const configured = process.env.SESSION_SECRET;
  if (configured) return configured;
  randomSecret ??= randomBytes(32).toString("hex");
  return randomSecret;
}

function mac(payload: string): string {
  return createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
}

/** Cookie value: `<base64url(json{exp})>.<hmac>`. `nowSec` is injectable for tests. */
export function signSessionCookie(nowSec = Math.floor(Date.now() / 1000), ttlSec = SESSION_TTL_SEC): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, exp: nowSec + ttlSec })).toString("base64url");
  return `${payload}.${mac(payload)}`;
}

export function verifySessionCookie(value: string | undefined, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (!value) return false;
  const [payload, sig, extra] = value.split(".");
  if (!payload || !sig || extra !== undefined) return false;
  const expected = Buffer.from(mac(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { v?: number; exp?: number };
    return parsed.v === 1 && typeof parsed.exp === "number" && parsed.exp > nowSec;
  } catch {
    return false;
  }
}

export function readCookie(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return undefined;
}

export function hasSessionCookie(headers: { get(name: string): string | null }): boolean {
  return readCookie(headers.get("cookie"), SESSION_COOKIE) !== undefined;
}

function digest(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

/** Constant-time password check against AUTH_PASSWORD_HASH (or dev-only AUTH_PASSWORD). */
export async function verifyPassword(password: string): Promise<boolean> {
  const cfg = localAuthConfig();
  if (cfg.passwordHash) {
    try {
      return await Bun.password.verify(password, cfg.passwordHash);
    } catch {
      return false;
    }
  }
  if (cfg.passwordPlain) return timingSafeEqual(digest(password), digest(cfg.passwordPlain));
  return false;
}

export function passwordConfigured(): boolean {
  const cfg = localAuthConfig();
  return Boolean(cfg.passwordHash || cfg.passwordPlain);
}

export function buildSessionCookie(value: string, opts: { secure: boolean; maxAgeSec?: number }): string {
  const parts = [`${SESSION_COOKIE}=${value}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${opts.maxAgeSec ?? SESSION_TTL_SEC}`];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function wantsSecureCookie(url: string, headers: { get(name: string): string | null }): boolean {
  if (process.env.AUTH_COOKIE_SECURE === "1") return true;
  if (headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https") return true;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/** The single operator: SEED_OPERATOR_EMAIL if it matches an operator, else the oldest operator. */
export async function findOperator(handle: DbHandle): Promise<Session | undefined> {
  const email = process.env.SEED_OPERATOR_EMAIL?.trim().toLowerCase();
  let row: typeof schema.user.$inferSelect | undefined;
  if (email) {
    [row] = await handle.db.select().from(schema.user).where(eq(schema.user.email, email)).limit(1);
    if (row && row.role !== "operator") row = undefined;
  }
  if (!row) {
    [row] = await handle.db.select().from(schema.user).where(eq(schema.user.role, "operator")).orderBy(asc(schema.user.createdAt)).limit(1);
  }
  return row ? { userId: row.id, teamId: row.teamId, email: row.email, role: "operator" } : undefined;
}

/** Local-mode session: valid signed cookie (or explicit no-password mode) -> operator. */
export async function resolveLocalSession(
  headers: { get(name: string): string | null },
  handle: DbHandle,
): Promise<Session | "not_provisioned" | undefined> {
  const ok = noPasswordAllowed() || verifySessionCookie(readCookie(headers.get("cookie"), SESSION_COOKIE));
  if (!ok) return undefined;
  return (await findOperator(handle)) ?? "not_provisioned";
}

// ---- login rate limit (in-memory): 5 attempts/min per client, 25/min overall ----
const WINDOW_MS = 60_000;
const PER_CLIENT = 5;
const OVERALL = 25;
const attempts = new Map<string, number[]>();

export function resetLoginRateLimit(): void {
  attempts.clear();
}

function hit(key: string, limit: number, now: number): boolean {
  const recent = (attempts.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  attempts.set(key, recent);
  return recent.length <= limit;
}

/** Records an attempt; returns false when over the limit. */
export function allowLoginAttempt(clientKey: string, now = Date.now()): boolean {
  const a = hit(`ip:${clientKey}`, PER_CLIENT, now);
  const b = hit("*", OVERALL, now);
  return a && b;
}

export function clientKey(headers: { get(name: string): string | null }): string {
  return (
    headers.get("cf-connecting-ip") ?? headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? headers.get("x-real-ip") ?? "local"
  );
}

// ---- CSRF ----
function originMatches(origin: string, headers: { get(name: string): string | null }): boolean {
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  const allowed = (process.env.AUTH_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.includes(o.origin)) return true;
  const host = headers.get("x-forwarded-host")?.split(",")[0]?.trim() ?? headers.get("host");
  return host !== null && host !== undefined && o.host === host;
}

/** True when a cookie-authenticated request looks same-origin (used for /ws upgrades too). */
export function isSameOrigin(headers: { get(name: string): string | null }): boolean {
  const site = headers.get("sec-fetch-site");
  if (site === "same-origin" || site === "none") return true;
  if (site) return false;
  const origin = headers.get("origin");
  return origin ? originMatches(origin, headers) : false;
}

/**
 * CSRF guard for cookie-authenticated state-changing `/api` requests (and login):
 * requires same-origin (`Sec-Fetch-Site` / `Origin`) or the custom `X-Requested-With`
 * header, which a cross-site page cannot add without a CORS preflight. Requests
 * authenticated by a bearer key or the dev header carry no cookie and are untouched.
 */
export function csrfGuard() {
  return createMiddleware(async (c, next) => {
    const m = c.req.method;
    if (m === "GET" || m === "HEAD" || m === "OPTIONS") return next();
    const h = c.req.raw.headers;
    if (!hasSessionCookie(h) && c.req.path !== "/api/auth/login") return next();
    const origin = h.get("origin");
    const site = h.get("sec-fetch-site");
    const crossSite = (site !== null && site !== "same-origin" && site !== "none") || (origin !== null && !originMatches(origin, h));
    if (crossSite) return c.json({ error: "csrf", message: "cross-origin request rejected" }, 403);
    if (isSameOrigin(h) || h.get(CSRF_HEADER)) return next();
    return c.json({ error: "csrf", message: "same-origin request required" }, 403);
  });
}
