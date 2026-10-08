import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { cfAccessAuth, type Session } from "../middleware/cf-access";

/** `GET /api/me`. */
export function meRoute(handle: DbHandle): Hono<{ Variables: { session: Session } }> {
  const app = new Hono<{ Variables: { session: Session } }>();

  app.get("/api/me", cfAccessAuth(handle), async (c) => {
    const session = c.get("session");
    const [user] = await handle.db.select().from(schema.user).where(eq(schema.user.id, session.userId)).limit(1);
    if (!user) return c.json({ error: "not_provisioned", message: "Ask an operator to add you" }, 403);
    return c.json({ id: user.id, email: user.email, role: user.role, teamId: user.teamId, telegramChatId: user.telegramChatId });
  });

  return app;
}
