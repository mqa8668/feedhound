import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { authMode } from "./auth-mode";
import { resolveLocalSession } from "./local-auth";

export type Role = "hunter" | "operator";

export interface Session {
  userId: string;
  teamId: string;
  email: string;
  role: Role;
}

interface Jwk {
  kid?: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

const JWKS_TTL_MS = 60 * 60 * 1000;

// The bypass used to be inferred from `NODE_ENV === "development"` alone —
// exactly the variable a misconfigured deploy is most likely to omit/misset. A missing
// `CF_ACCESS_AUD` (e.g. an operator forgot to configure Cloudflare Access for a new
// environment) then silently enabled a full `X-Dev-User: <email>` bypass, since the old
// startup guard only tripped when `CF_ACCESS_AUD` was *also* set. Gating on this explicit
// opt-in — a variable a real deployment would never set — means a misconfigured deploy
// fails closed (real Cloudflare Access JWTs required) instead of failing open. Read fresh
// (not cached at module load) so tests can flip it per-case, matching the previous
// `NODE_ENV` matrix test style.
// Defence in depth: never honoured when NODE_ENV=production, even if the boot guard is bypassed.
export function isDevBypassEnabled(): boolean {
  return process.env.DEV_AUTH_BYPASS === "1" && process.env.NODE_ENV !== "production";
}

/**
 * Fail-fast startup guard: `DEV_AUTH_BYPASS=1`
 * enables the `X-Dev-User` bypass. If this looks like a real
 * deployment — `CF_ACCESS_AUD` set, or `NODE_ENV=production` (the compose default) — the
 * bypass being live would let anyone skip authentication entirely by sending the header.
 * Runs once at module load (process boot), not per-request, so it can't fire mid-test when
 * a test suite flips env vars after import.
 */
function assertDevBypassSafe(): void {
  if (process.env.DEV_AUTH_BYPASS === "1" && (process.env.CF_ACCESS_AUD || process.env.NODE_ENV === "production")) {
    throw new Error(
      "cf-access: refusing to start with DEV_AUTH_BYPASS=1 (X-Dev-User bypass live) while this looks like a real " +
        "deployment (CF_ACCESS_AUD is set and/or NODE_ENV=production) — unset DEV_AUTH_BYPASS for that environment.",
    );
  }
}
assertDevBypassSafe();

interface JwksCacheEntry {
  fetchedAt: number;
  keys: Map<string, Jwk>;
}

const jwksCache = new Map<string, JwksCacheEntry>();

function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson(segment: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(segment))) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function fetchJwks(teamDomain: string, fetchImpl: typeof fetch): Promise<Map<string, Jwk>> {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`jwks fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = new Map<string, Jwk>();
  for (const key of body.keys ?? []) {
    if (key.kid) keys.set(key.kid, key);
  }
  return keys;
}

async function getJwks(teamDomain: string, fetchImpl: typeof fetch, forceRefresh = false): Promise<Map<string, Jwk>> {
  const cached = jwksCache.get(teamDomain);
  const now = Date.now();
  if (!forceRefresh && cached && now - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;
  const keys = await fetchJwks(teamDomain, fetchImpl);
  jwksCache.set(teamDomain, { fetchedAt: now, keys });
  return keys;
}

async function importRsaKey(jwk: Jwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

interface VerifyOptions {
  aud: string;
  teamDomain: string;
  fetchImpl: typeof fetch;
}

type VerifyResult =
  | { ok: true; email: string }
  | { ok: false; reason: "invalid" | "expired" | "aud" | "iss" | "no-key" };

/** Verifies a Cloudflare Access RS256 JWT against the team's JWKS. */
async function verifyAccessJwt(token: string, opts: VerifyOptions): Promise<VerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "invalid" };
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
  const header = decodeJson(headerB64);
  const payload = decodeJson(payloadB64);
  if (!header || !payload || typeof header.kid !== "string") return { ok: false, reason: "invalid" };

  let jwks = await getJwks(opts.teamDomain, opts.fetchImpl);
  let jwk = jwks.get(header.kid);
  if (!jwk) {
    // Refetch once on an unknown kid (key rotation).
    jwks = await getJwks(opts.teamDomain, opts.fetchImpl, true);
    jwk = jwks.get(header.kid);
  }
  if (!jwk) return { ok: false, reason: "no-key" };

  let key: CryptoKey;
  try {
    key = await importRsaKey(jwk);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const signature = base64UrlDecode(sigB64);
  const signedInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signedInput);
  if (!valid) return { ok: false, reason: "invalid" };

  const aud = payload.aud;
  const audList = Array.isArray(aud) ? aud : typeof aud === "string" ? [aud] : [];
  if (!audList.includes(opts.aud)) return { ok: false, reason: "aud" };
  if (payload.iss !== `https://${opts.teamDomain}`) return { ok: false, reason: "iss" };
  const exp = typeof payload.exp === "number" ? payload.exp : 0;
  if (exp <= Math.floor(Date.now() / 1000)) return { ok: false, reason: "expired" };
  const email = typeof payload.email === "string" ? payload.email : undefined;
  if (!email) return { ok: false, reason: "invalid" };
  return { ok: true, email };
}

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return undefined;
}

export interface CfAccessOptions {
  fetchImpl?: typeof fetch;
}

/**
 * Looks up the session for the current request without writing a response —
 * `undefined` means "no valid credentials", distinct from "credentials present
 * but email not provisioned" (`'not_provisioned'`). Used both by the hard
 * `cfAccessAuth` middleware and by routes that also accept an api key.
 */
export async function resolveSession(
  headers: { get(name: string): string | null },
  handle: DbHandle,
  opts: CfAccessOptions = {},
): Promise<Session | "not_provisioned" | undefined> {
  const fetchImpl = opts.fetchImpl ?? fetch;

  let email: string | undefined;

  const devHeader = headers.get("X-Dev-User");
  if (isDevBypassEnabled() && devHeader) {
    email = devHeader.toLowerCase();
  } else if (authMode() === "local") {
    return resolveLocalSession(headers, handle);
  } else {
    const jwtHeader = headers.get("Cf-Access-Jwt-Assertion");
    const cookieToken = parseCookie(headers.get("cookie") ?? undefined, "CF_Authorization");
    const token = jwtHeader ?? cookieToken;
    if (token) {
      const aud = process.env.CF_ACCESS_AUD;
      const teamDomain = process.env.CF_ACCESS_TEAM_DOMAIN;
      if (!aud || !teamDomain) return undefined;
      const result = await verifyAccessJwt(token, { aud, teamDomain, fetchImpl });
      if (!result.ok) return undefined;
      email = result.email.toLowerCase();
    }
  }

  if (!email) return undefined;

  const [user] = await handle.db.select().from(schema.user).where(eq(schema.user.email, email)).limit(1);
  if (!user) return "not_provisioned";
  const role: Role = user.role === "operator" ? "operator" : "hunter";
  return { userId: user.id, teamId: user.teamId, email: user.email, role };
}

/**
 * Hard auth middleware for `/api/*` (session-based routes) and the `/ws`
 * upgrade. 401 on missing/invalid credentials, 403 `not_provisioned` on a
 * valid identity with no matching `User` row.
 */
export function cfAccessAuth(handle: DbHandle, opts: CfAccessOptions = {}) {
  return createMiddleware<{ Variables: { session: Session } }>(async (c, next) => {
    const result = await resolveSession(c.req.raw.headers, handle, opts);
    if (result === undefined) return c.json({ error: "unauthenticated", message: "missing or invalid credentials" }, 401);
    if (result === "not_provisioned") {
      return c.json({ error: "not_provisioned", message: "Ask an operator to add you" }, 403);
    }
    c.set("session", result);
    await next();
  });
}
