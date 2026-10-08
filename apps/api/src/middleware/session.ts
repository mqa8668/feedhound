import { createMiddleware } from "hono/factory";
import type { Role, Session } from "./cf-access";

/** Fails closed with 401 if `cfAccessAuth` did not run (defensive; normally unreachable). */
export function requireSession() {
  return createMiddleware<{ Variables: { session: Session } }>(async (c, next) => {
    if (!c.get("session")) return c.json({ error: "unauthenticated", message: "no session" }, 401);
    await next();
  });
}

/** 403 `forbidden` unless the session's role is `role`. */
export function requireRole(role: Role) {
  return createMiddleware<{ Variables: { session: Session } }>(async (c, next) => {
    const session = c.get("session");
    if (!session) return c.json({ error: "unauthenticated", message: "no session" }, 401);
    if (session.role !== role) return c.json({ error: "forbidden", message: `${role} role required` }, 403);
    await next();
  });
}

/** `true` if `session` may act on a row owned by `ownerUserId` (owner or any operator). */
export function ownerOrOperator(session: Session, ownerUserId: string): boolean {
  return session.role === "operator" || session.userId === ownerUserId;
}
