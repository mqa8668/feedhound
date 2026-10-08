import type { DbHandle } from "@feedhound/db";
import { Hono } from "hono";
import { authMode } from "../middleware/auth-mode";
import { resolveSession } from "../middleware/cf-access";
import {
  allowLoginAttempt,
  buildSessionCookie,
  clientKey,
  passwordConfigured,
  signSessionCookie,
  verifyPassword,
  wantsSecureCookie,
} from "../middleware/local-auth";
import { noPasswordAllowed } from "../middleware/auth-mode";

/** `/api/auth/{status,login,logout}` (local mode); status also works in cf-access mode. */
export function authRoute(handle: DbHandle): Hono {
  const app = new Hono();

  app.get("/api/auth/status", async (c) => {
    const mode = authMode();
    const session = await resolveSession(c.req.raw.headers, handle);
    return c.json({ mode, authenticated: typeof session === "object" });
  });

  app.post("/api/auth/login", async (c) => {
    if (authMode() !== "local") return c.json({ error: "not_available" }, 404);
    if (!allowLoginAttempt(clientKey(c.req.raw.headers))) {
      c.header("Retry-After", "60");
      return c.json({ error: "rate_limited" }, 429);
    }
    const body = (await c.req.json().catch(() => null)) as { password?: unknown } | null;
    const password = typeof body?.password === "string" ? body.password : "";
    if (!passwordConfigured()) {
      if (noPasswordAllowed()) return c.json({ ok: true });
      return c.json({ error: "login_disabled", message: "No password is configured on the server" }, 503);
    }
    if (!password || !(await verifyPassword(password))) return c.json({ error: "invalid_credentials" }, 401);
    c.header("Set-Cookie", buildSessionCookie(signSessionCookie(), { secure: wantsSecureCookie(c.req.url, c.req.raw.headers) }));
    return c.json({ ok: true });
  });

  app.post("/api/auth/logout", (c) => {
    c.header("Set-Cookie", buildSessionCookie("", { secure: wantsSecureCookie(c.req.url, c.req.raw.headers), maxAgeSec: 0 }));
    return c.json({ ok: true });
  });

  return app;
}
