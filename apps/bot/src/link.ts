import { createLogger } from "@feedhound/core/logger";
import type { DbHandle } from "@feedhound/db";
import { clearNoEnabledNotifierMarkers, schema } from "@feedhound/db";
import { and, eq, gt } from "drizzle-orm";

const logger = createLogger({ service: "bot" });

export interface LinkResult {
  reply: string;
  linked: boolean;
}

// Simple per-chat throttle so a chat cannot brute-force the 8-char link
// code space by hammering `/link <guess>`. In-memory is sufficient: the bot
// is a single long-polling process.
const LINK_ATTEMPT_WINDOW_MS = 10 * 60_000;
const MAX_LINK_ATTEMPTS_PER_WINDOW = 5;
const linkAttempts = new Map<number, number[]>();

function isLinkThrottled(chatId: number, now: Date): boolean {
  const cutoff = now.getTime() - LINK_ATTEMPT_WINDOW_MS;
  const attempts = (linkAttempts.get(chatId) ?? []).filter((t) => t > cutoff);
  const overLimit = attempts.length >= MAX_LINK_ATTEMPTS_PER_WINDOW;
  if (!overLimit) attempts.push(now.getTime());
  linkAttempts.set(chatId, attempts);
  return overLimit;
}

/** Test-only: clears the in-memory throttle state between test cases. */
export function resetLinkThrottleForTest(): void {
  linkAttempts.clear();
}

/** Resolves the `User` already linked to `chatId`, if any. */
export async function findLinkedUser(handle: DbHandle, chatId: number): Promise<typeof schema.user.$inferSelect | undefined> {
  const [row] = await handle.db
    .select()
    .from(schema.user)
    .where(eq(schema.user.telegramChatId, String(chatId)))
    .limit(1);
  return row;
}

/**
 * `/link <code>` flow: sets `User.telegramChatId`,
 * clears the code, and upserts a telegram `Notifier` for the chat.
 */
export async function linkChat(handle: DbHandle, chatId: number, code: string, now: Date): Promise<LinkResult> {
  const already = await findLinkedUser(handle, chatId);
  if (already) return { reply: `This chat is already linked to ${already.email}`, linked: false };

  if (isLinkThrottled(chatId, now)) {
    return { reply: "Too many attempts, please try again in a few minutes", linked: false };
  }

  const [candidate] = await handle.db
    .select()
    .from(schema.user)
    .where(and(eq(schema.user.linkCode, code), gt(schema.user.linkCodeExpiresAt, now)))
    .limit(1);

  if (!candidate) return { reply: "Code is invalid or has expired", linked: false };

  await handle.db
    .update(schema.user)
    .set({ telegramChatId: String(chatId), linkCode: null, linkCodeExpiresAt: null })
    .where(eq(schema.user.id, candidate.id));

  const [existingNotifier] = await handle.db
    .select()
    .from(schema.notifier)
    .where(and(eq(schema.notifier.userId, candidate.id), eq(schema.notifier.kind, "telegram")))
    .limit(1);

  if (existingNotifier) {
    // Re-linking (e.g. after `/link` on a previously-unlinked chat whose
    // notifier config was tweaked, or a code re-issued for the same user) must not
    // clobber an existing `mode: 'digest'`/`digestEveryMin` back to `instant` — only
    // `chatId` changes here, every other config field is preserved.
    const existingConfig = existingNotifier.config as { chatId?: number; mode?: "instant" | "digest"; digestEveryMin?: number };
    await handle.db
      .update(schema.notifier)
      .set({ config: { ...existingConfig, chatId }, enabled: true })
      .where(eq(schema.notifier.id, existingNotifier.id));
  } else {
    await handle.db.insert(schema.notifier).values({
      userId: candidate.id,
      kind: "telegram",
      config: { chatId, mode: "instant" },
      enabled: true,
    });
  }

  // `notify.ts`'s `markNoTarget("no enabled notifier")` marker is
  // permanent once written (matches the CR-1 sweeper's `not exists` check forever). A match
  // arriving before `/link` writes one of these for the candidate user; clear them now so
  // the next sweeper tick re-arms the match for a fresh `notify` run against the
  // just-linked notifier. Bounded by age + count so linking a chat with a
  // long history of unlinked matches cannot flood-reenqueue all of them at once.
  const { cleared, droppedOutsideBound } = await clearNoEnabledNotifierMarkers(handle, candidate.id, now);
  // Markers outside the age/count bound were previously dropped silently.
  // Log and tell the user so a re-link after a long outage doesn't look like alerts
  // simply vanished.
  if (droppedOutsideBound > 0) {
    logger.warn({ userId: candidate.id, cleared, droppedOutsideBound }, "clearNoEnabledNotifierMarkers: some markers left outside the age/count bound");
  }

  const reply =
    droppedOutsideBound > 0
      ? `Linked to ${candidate.email}. ${droppedOutsideBound} alerts older than the limit (24h/200) were not restored.`
      : `Linked to ${candidate.email}`;
  return { reply, linked: true };
}

/** Whether `chatId` has no linked user yet (used to gate all commands except `/start`/`/link`). */
export async function isChatUnlinked(handle: DbHandle, chatId: number): Promise<boolean> {
  const user = await findLinkedUser(handle, chatId);
  return user === undefined;
}
