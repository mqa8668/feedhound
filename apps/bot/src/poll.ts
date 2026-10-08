import { escapeHtml } from "./format";
import { parseCommand, type ParsedCommand } from "./commands";
import { findLinkedUser, isChatUnlinked, linkChat } from "./link";
import { createLogger } from "@feedhound/core/logger";
import { validateRegex } from "@feedhound/core/regex-safe";
import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { and, desc, eq, gte, inArray, ne, or, sql } from "drizzle-orm";
import type { TelegramApiClient, TelegramUpdate } from "./telegram-api";

const logger = createLogger({ service: "bot" });
const DEFAULT_REGEX_MAX_LEN = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `match.regexMaxLen` (config) — same validation path as `apps/api/src/routes/watches.ts`. */
async function fetchRegexMaxLen(handle: DbHandle): Promise<number> {
  const [row] = await handle.db
    .select({ value: schema.config.value })
    .from(schema.config)
    .where(eq(schema.config.key, "match.regexMaxLen"))
    .orderBy(desc(schema.config.version))
    .limit(1);
  return (row?.value as number | undefined) ?? DEFAULT_REGEX_MAX_LEN;
}

const START_TEXT = [
  "Hi! Get started with:",
  "/link &lt;code&gt; — link your account",
  "/watch add|list|del|mute — manage watches",
  "/search &lt;q&gt; — search posts",
  "/status — account status",
].join("\n");

const COMMANDS = [
  { command: "start", description: "Help" },
  { command: "link", description: "Link your account" },
  { command: "watch", description: "Manage watches" },
  { command: "search", description: "Search posts" },
  { command: "status", description: "Status" },
];

export interface PollDeps {
  handle: DbHandle;
  api: TelegramApiClient;
}

/** One long-poll cycle: fetch updates since `offset`, process them, return the next offset. */
export async function pollOnce(deps: PollDeps, offset: number, timeoutSec = 30): Promise<number> {
  const updates = await deps.api.getUpdates(offset, timeoutSec);
  let nextOffset = offset;
  for (const update of updates) {
    try {
      await processUpdate(deps, update);
    } catch (err) {
      logger.error({ err, update }, "bot: error processing update");
    }
    nextOffset = update.update_id + 1;
  }
  return nextOffset;
}

async function processUpdate(deps: PollDeps, update: TelegramUpdate): Promise<void> {
  if (update.callback_query) return handleCallback(deps, update.callback_query);
  if (update.message) return handleMessage(deps, update.message);
}

async function reply(deps: PollDeps, chatId: number, text: string): Promise<void> {
  // Bot command replies bypass the rate limiter.
  await deps.api.sendMessage(chatId, text);
}

async function handleMessage(deps: PollDeps, message: NonNullable<TelegramUpdate["message"]>): Promise<void> {
  const chatId = message.chat.id;
  const parsed = parseCommand(message.text ?? "");

  if (parsed.kind === "start") return reply(deps, chatId, START_TEXT);
  if (parsed.kind === "link") {
    const result = await linkChat(deps.handle, chatId, parsed.code, new Date());
    return reply(deps, chatId, result.reply);
  }

  if (await isChatUnlinked(deps.handle, chatId)) {
    return reply(deps, chatId, START_TEXT);
  }

  const user = await findLinkedUser(deps.handle, chatId);
  if (!user) return reply(deps, chatId, START_TEXT); // race guard, should not happen

  if (parsed.kind === "error") return reply(deps, chatId, escapeHtml(parsed.usage));
  if (parsed.kind === "unknown") return reply(deps, chatId, START_TEXT);

  const text = await dispatch(deps, user, parsed);
  if (text !== undefined) await reply(deps, chatId, text);
}

async function dispatch(deps: PollDeps, user: typeof schema.user.$inferSelect, cmd: ParsedCommand): Promise<string | undefined> {
  switch (cmd.kind) {
    case "watch_add":
      return watchAdd(deps, user, cmd);
    case "watch_list":
      return watchList(deps, user);
    case "watch_del":
      return watchDel(deps, user, cmd.sel);
    case "watch_mute":
      return watchMute(deps, user, cmd.sel, cmd.durationMs);
    case "search":
      return search(deps, user.teamId, cmd.q, cmd.n);
    case "status":
      return status(deps, user);
    default:
      return START_TEXT;
  }
}

async function findOwnNotifier(deps: PollDeps, userId: string): Promise<string | undefined> {
  const [row] = await deps.handle.db
    .select({ id: schema.notifier.id })
    .from(schema.notifier)
    .where(and(eq(schema.notifier.userId, userId), eq(schema.notifier.kind, "telegram")))
    .limit(1);
  return row?.id;
}

async function watchAdd(deps: PollDeps, user: typeof schema.user.$inferSelect, cmd: Extract<ParsedCommand, { kind: "watch_add" }>): Promise<string> {
  const [existing] = await deps.handle.db
    .select({ id: schema.watch.id })
    .from(schema.watch)
    .where(and(eq(schema.watch.userId, user.id), eq(schema.watch.name, cmd.name)))
    .limit(1);
  if (existing) return `Watch "${escapeHtml(cmd.name)}" already exists`;

  if (cmd.regex) {
    const maxLen = await fetchRegexMaxLen(deps.handle);
    const validated = validateRegex(cmd.regex, maxLen);
    if (!validated.ok) return `Invalid regex: ${escapeHtml(validated.reason)}`;
  }

  let categoryIds: string[] = [];
  if (cmd.categorySlugs.length > 0) {
    const rows = await deps.handle.db.select({ id: schema.category.id, slug: schema.category.slug }).from(schema.category).where(inArray(schema.category.slug, cmd.categorySlugs));
    if (rows.length !== new Set(cmd.categorySlugs).size) return "Some categories do not exist";
    categoryIds = rows.map((r) => r.id);
  }

  const notifierId = await findOwnNotifier(deps, user.id);

  const [row] = await deps.handle.db
    .insert(schema.watch)
    .values({
      userId: user.id,
      name: cmd.name,
      include: cmd.include,
      includeAll: cmd.includeAll,
      exclude: cmd.exclude,
      regex: cmd.regex ?? null,
      categoryIds,
      priceMin: cmd.priceMin ?? null,
      priceMax: cmd.priceMax ?? null,
      intents: cmd.intent ? [cmd.intent] : [],
      notifierIds: notifierId ? [notifierId] : [],
      enabled: true,
    })
    .returning({ id: schema.watch.id });

  return `Created watch "${escapeHtml(cmd.name)}" (id: ${row?.id})`;
}

async function resolveWatch(deps: PollDeps, userId: string, sel: string): Promise<typeof schema.watch.$inferSelect | undefined> {
  const byId = /^[0-9a-f-]{36}$/i.test(sel)
    ? (await deps.handle.db.select().from(schema.watch).where(and(eq(schema.watch.id, sel), eq(schema.watch.userId, userId))).limit(1))[0]
    : undefined;
  if (byId) return byId;
  const [byName] = await deps.handle.db.select().from(schema.watch).where(and(eq(schema.watch.userId, userId), eq(schema.watch.name, sel))).limit(1);
  return byName;
}

/** `app.tz` (default `Asia/Ho_Chi_Minh`) — mute/watch-list replies must show local wall-clock time, not UTC. */
async function fetchAppTz(handle: DbHandle): Promise<string> {
  const [row] = await handle.db
    .select({ value: schema.config.value })
    .from(schema.config)
    .where(eq(schema.config.key, "app.tz"))
    .orderBy(desc(schema.config.version))
    .limit(1);
  return (row?.value as string | undefined) ?? "Asia/Ho_Chi_Minh";
}

function fmtHHMM(d: Date, tz: string): string {
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
  const parts = fmt.formatToParts(d);
  const hh = parts.find((p) => p.type === "hour")?.value ?? "00";
  const mm = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${hh}:${mm}`;
}

async function watchList(deps: PollDeps, user: typeof schema.user.$inferSelect): Promise<string> {
  const rows = await deps.handle.db.select().from(schema.watch).where(eq(schema.watch.userId, user.id)).limit(20);
  if (rows.length === 0) return "No watches yet";
  const now = new Date();
  const tz = await fetchAppTz(deps.handle);
  const lines = rows.map((w) => {
    const state = w.mutedUntil && w.mutedUntil > now ? `muted until ${fmtHHMM(w.mutedUntil, tz)}` : w.enabled ? "on" : "off";
    const terms = [...w.include, ...w.includeAll].slice(0, 5).join(", ") || "(no terms)";
    return `${w.id.slice(0, 8)} · ${escapeHtml(w.name)} · ${state} · ${escapeHtml(terms)}`;
  });
  return lines.join("\n");
}

async function watchDel(deps: PollDeps, user: typeof schema.user.$inferSelect, sel: string): Promise<string> {
  const watch = await resolveWatch(deps, user.id, sel);
  if (!watch) return "Watch not found";
  await deps.handle.db.delete(schema.watch).where(eq(schema.watch.id, watch.id));
  return `Deleted watch "${escapeHtml(watch.name)}"`;
}

async function watchMute(deps: PollDeps, user: typeof schema.user.$inferSelect, sel: string, durationMs: number | "off"): Promise<string> {
  const watch = await resolveWatch(deps, user.id, sel);
  if (!watch) return "Watch not found";
  if (durationMs === "off") {
    await deps.handle.db.update(schema.watch).set({ mutedUntil: null }).where(eq(schema.watch.id, watch.id));
    return `Re-enabled watch "${escapeHtml(watch.name)}"`;
  }
  const mutedUntil = new Date(Date.now() + durationMs);
  await deps.handle.db.update(schema.watch).set({ mutedUntil }).where(eq(schema.watch.id, watch.id));
  const tz = await fetchAppTz(deps.handle);
  return `Muted watch "${escapeHtml(watch.name)}" until ${fmtHHMM(mutedUntil, tz)}`;
}

async function search(deps: PollDeps, teamId: string, q: string, n: number): Promise<string> {
  const rows = await deps.handle.db.execute(sql`
    select p.title, p.url, e.price_vnd as "priceVnd", s.name as "sourceName"
    from post p
    join source s on s.id = p.source_id and s.team_id = ${teamId}::uuid
    left join lateral (
      select price_vnd from enrichment where post_id = p.id order by revision desc limit 1
    ) e on true
    where p.tsv @@ websearch_to_tsquery('simple', unaccent(${q}))
    order by p.first_seen_at desc
    limit ${n}
  `);
  const posts = rows as unknown as { title: string | null; url: string; priceVnd: number | null; sourceName: string | null }[];
  if (posts.length === 0) return "No results found";
  return posts
    .map((p, i) => `${i + 1}. <a href="${escapeHtml(p.url)}">${escapeHtml(p.title ?? "")}</a> · ${p.priceVnd ?? "—"} · ${escapeHtml(p.sourceName ?? "?")}`)
    .join("\n");
}

async function status(deps: PollDeps, user: typeof schema.user.$inferSelect): Promise<string> {
  const watches = await deps.handle.db.select({ enabled: schema.watch.enabled }).from(schema.watch).where(eq(schema.watch.userId, user.id));
  const enabled = watches.filter((w) => w.enabled).length;
  const disabled = watches.length - enabled;

  const since = new Date(Date.now() - 24 * 60 * 60_000);
  // `sentAt` is only set on success and `failedAt` only on failure — a single `sentAt >= since` filter silently drops every
  // failed row, so `/status` always reported 0 errors.
  const notifs = await deps.handle.db
    .select({ status: schema.notification.status })
    .from(schema.notification)
    .where(and(eq(schema.notification.userId, user.id), or(gte(schema.notification.sentAt, since), gte(schema.notification.failedAt, since))));
  const sent = notifs.filter((n) => n.status === "sent").length;
  const failed = notifs.filter((n) => n.status === "failed").length;

  const [latestPost] = await deps.handle.db.select({ firstSeenAt: schema.post.firstSeenAt }).from(schema.post).orderBy(desc(schema.post.firstSeenAt)).limit(1);

  const lines = [
    `Watches: ${enabled} on, ${disabled} off`,
    `Notifications (24h): ${sent} sent, ${failed} failed`,
    `Latest post: ${latestPost?.firstSeenAt?.toISOString() ?? "?"}`,
  ];

  if (user.role === "operator") {
    // `status <> 'active'` counts both `paused` and `paused_by_health`.
    const [paused] = await deps.handle.db.select({ n: sql<number>`count(*)` }).from(schema.source).where(ne(schema.source.status, "active"));
    lines.push(`Paused sources: ${paused?.n ?? 0}`);
  }

  return lines.join("\n");
}

async function handleCallback(deps: PollDeps, cb: NonNullable<TelegramUpdate["callback_query"]>): Promise<void> {
  const [action, notificationId] = cb.data.split(":");
  const chatId = cb.message.chat.id;

  // A garbage `m1:<not-a-uuid>` callback (stale button, tampered client) must
  // be answered like any other invalid callback, not let an invalid-uuid literal reach
  // Postgres and throw — `pollOnce`'s try/catch would swallow that, but then the user's
  // Telegram client is left with a spinning callback that never resolves.
  if (!notificationId || !UUID_RE.test(notificationId)) {
    await deps.api.answerCallbackQuery(cb.id, "Invalid");
    return;
  }

  const [row] = await deps.handle.db.select().from(schema.notification).where(eq(schema.notification.id, notificationId)).limit(1);
  if (!row) {
    await deps.api.answerCallbackQuery(cb.id, "Invalid");
    return;
  }

  const notifier = row.notifierId ? (await deps.handle.db.select().from(schema.notifier).where(eq(schema.notifier.id, row.notifierId)).limit(1))[0] : undefined;
  const notifierConfig = notifier?.config as { chatId?: number } | undefined;
  if (!notifier || notifierConfig?.chatId !== chatId) {
    await deps.api.answerCallbackQuery(cb.id, "Not allowed");
    return;
  }

  const watchIds = row.payload.watchIds ?? [];
  const ownWatches = watchIds.length > 0 ? await deps.handle.db.select().from(schema.watch).where(and(inArray(schema.watch.id, watchIds), eq(schema.watch.userId, row.userId))) : [];
  if (ownWatches.length !== watchIds.length) {
    await deps.api.answerCallbackQuery(cb.id, "Not allowed");
    return;
  }

  if (action === "m1") {
    const until = new Date(Date.now() + 3_600_000);
    await deps.handle.db.update(schema.watch).set({ mutedUntil: until }).where(inArray(schema.watch.id, watchIds));
    const tz = await fetchAppTz(deps.handle);
    await deps.api.answerCallbackQuery(cb.id, `Muted until ${fmtHHMM(until, tz)}`);
  } else if (action === "mw") {
    await deps.handle.db.update(schema.watch).set({ enabled: false }).where(inArray(schema.watch.id, watchIds));
    const names = ownWatches.map((w) => w.name).join(", ");
    await deps.api.answerCallbackQuery(cb.id, `Muted watch ${names}`);
  } else {
    await deps.api.answerCallbackQuery(cb.id, "Invalid");
    return;
  }

  const postId = row.payload.postId;
  const [post] = postId ? await deps.handle.db.select({ url: schema.post.url }).from(schema.post).where(eq(schema.post.id, postId)).limit(1) : [undefined];
  await deps.api.editMessageReplyMarkup(chatId, cb.message.message_id, [[{ text: "Open post", url: post?.url }]]);
}

export async function setupCommands(api: TelegramApiClient): Promise<void> {
  await api.setMyCommands(COMMANDS);
}
