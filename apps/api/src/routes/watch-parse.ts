import { createLogger } from "@feedhound/core/logger";
import { declaredSchemas, resolveAllSchemas } from "@feedhound/core/attributes";
import { DEFAULT_MIN_PEERS } from "@feedhound/core/deal";
import { normalizeText } from "@feedhound/core/normalize";
import { priceStats } from "@feedhound/core/price-stats";
import { resolveDraft, type WatchDraft } from "@feedhound/core/watch-parse";
import { resolveSuggestExclude } from "@feedhound/core/weak-terms";
import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { createBudget, WatchParseOutput, watchParseV1, type LlmClient, type LlmUsage } from "@feedhound/llm";
import { Hono } from "hono";
import { z } from "zod";
import { envLlmProvider, readConfigNumber, readConfigString, readConfigValue, type LlmProvider } from "../services/llm";
import { loadAppTz } from "../services/watch-stats";
import { resolveWatchActor } from "./watches";

const logger = createLogger({ service: "api" });

const bodySchema = z.object({ text: z.string().min(3).max(300) });
const MAX_ALIAS_SUGGESTIONS = 10;
const PRICE_WINDOW_DAYS = 30;

export interface WatchParseSuggestions {
  aliases: string[];
  exclude: string[];
  priceRange: { p25: number; median: number; p75: number; n: number } | null;
}

export interface WatchParseResponse {
  draft: WatchDraft;
  warnings: string[];
  suggestions: WatchParseSuggestions;
}

export interface WatchParseDeps {
  llm?: LlmProvider;
  now?: () => Date;
}

function fold(s: string): string {
  return normalizeText(s).folded;
}

async function loadCatalogue(handle: DbHandle) {
  const categories = await handle.db
    .select({ id: schema.category.id, slug: schema.category.slug, name: schema.category.name, path: schema.category.path, attributeSchema: schema.category.attributeSchema })
    .from(schema.category);
  const items = await handle.db
    .select({ id: schema.catalogItem.id, name: schema.catalogItem.name, aliases: schema.catalogItem.aliases, categoryId: schema.catalogItem.categoryId })
    .from(schema.catalogItem);
  return { categories, items };
}

/** 007 `priceStats` over 30 d of non-suspect sell prices of the draft's items (else its category subtrees); team-scoped. */
async function peerPriceRange(handle: DbHandle, teamId: string, draft: WatchDraft, now: Date): Promise<WatchParseSuggestions["priceRange"]> {
  if (draft.itemIds.length === 0 && draft.categoryIds.length === 0) return null;
  const since = new Date(now.getTime() - PRICE_WINDOW_DAYS * 86_400_000).toISOString();
  const rows =
    draft.itemIds.length > 0
      ? await handle.sql<{ price: number }[]>`
          select e.price_vnd as price from post p
          join source s on s.id = p.source_id
          join lateral (select * from enrichment x where x.post_id = p.id order by x.revision desc limit 1) e on true
          where s.team_id = ${teamId}::uuid and e.intent = 'sell' and e.price_vnd is not null and not e.price_suspect
            and p.first_seen_at >= ${since}::timestamptz and e.item_id = any(${draft.itemIds}::uuid[])`
      : await handle.sql<{ price: number }[]>`
          select e.price_vnd as price from post p
          join source s on s.id = p.source_id
          join lateral (select * from enrichment x where x.post_id = p.id order by x.revision desc limit 1) e on true
          where s.team_id = ${teamId}::uuid and e.intent = 'sell' and e.price_vnd is not null and not e.price_suspect
            and p.first_seen_at >= ${since}::timestamptz
            and e.category_id in (select c.id from category c join category r on r.id = any(${draft.categoryIds}::uuid[]) where c.path <@ r.path)`;
  const stats = priceStats(rows.map((r) => Number(r.price)));
  if (!stats || stats.n < DEFAULT_MIN_PEERS) return null;
  return { p25: stats.p25, median: stats.median, p75: stats.p75, n: stats.n };
}

/**
 * `POST /api/watches/parse`: natural language -> editable watch draft + suggestions. Never writes.
 * Cheap model first; a schema failure retries once on the strong model.
 */
export function watchParseRoute(handle: DbHandle, deps: WatchParseDeps = {}): Hono {
  const app = new Hono();
  const provider = deps.llm ?? envLlmProvider(handle);
  const clock = deps.now ?? (() => new Date());
  // per-user call timestamps within the last minute (in-memory, single API process)
  const calls = new Map<string, number[]>();

  app.post("/api/watches/parse", async (c) => {
    const actor = await resolveWatchActor(c, handle, ["watches:write"]);
    if (actor instanceof Response) return actor;

    const json: unknown = await c.req.json().catch(() => undefined);
    const body = bodySchema.safeParse(json);
    if (!body.success) return c.json({ error: "validation" }, 422);

    const now = clock();
    const limit = await readConfigNumber(handle, "watch.parseRatePerMin", 20);
    const recent = (calls.get(actor.userId) ?? []).filter((t) => now.getTime() - t < 60_000);
    if (recent.length >= limit) {
      calls.set(actor.userId, recent);
      return c.json({ error: "rate_limited" }, 429);
    }
    recent.push(now.getTime());
    calls.set(actor.userId, recent);

    const client: LlmClient | null = await provider();
    const cheap = await readConfigString(handle, "llm.model.cheap", "");
    const strong = await readConfigString(handle, "llm.model.strong", "");
    if (!client || !cheap || !strong) return c.json({ error: "llm_unavailable" }, 503);

    const budget = createBudget({
      handle,
      tz: await loadAppTz(handle),
      dailyTokenBudget: await readConfigNumber(handle, "llm.dailyTokenBudget", 2_000_000),
      budgetAlertPct: await readConfigNumber(handle, "llm.budgetAlertPct", 80),
      now: clock,
    });
    if (await budget.isExhausted()) return c.json({ error: "llm_budget" }, 503);

    const { categories, items } = await loadCatalogue(handle);
    const declared = declaredSchemas(categories);
    const slugById = new Map(categories.map((cat) => [cat.id, cat.slug]));
    const prompt = watchParseV1.render({
      text: body.data.text,
      categories: categories.map((cat) => ({ slug: cat.slug, name: cat.name })),
      attributeSchemas: [...declared].flatMap(([id, schemaDefs]) => {
        const categorySlug = slugById.get(id);
        return categorySlug ? [{ categorySlug, schema: schemaDefs }] : [];
      }),
    });

    const record = async (usage: LlmUsage | undefined): Promise<void> => {
      if (usage) await budget.recordUsage(usage);
    };

    let result = await client.complete({ model: cheap, prompt, schema: WatchParseOutput });
    await record(result.usage);
    if (!result.ok && result.reason === "schema") {
      result = await client.complete({ model: strong, prompt, schema: WatchParseOutput });
      await record(result.usage);
    }
    if (!result.ok && result.reason !== "schema") logger.warn({ reason: result.reason, status: result.status }, "watch-parse: llm unavailable");
    if (!result.ok) return result.reason === "schema" ? c.json({ error: "parse_failed" }, 422) : c.json({ error: "llm_unavailable" }, 503);

    const { draft, warnings } = resolveDraft(result.data, {
      categories: categories.map((cat) => ({ id: cat.id, slug: cat.slug })),
      items,
      schemas: resolveAllSchemas(categories),
    });

    const includeFolded = new Set(draft.include.map(fold));
    const aliasSeen = new Set<string>();
    const aliases: string[] = [];
    for (const item of items.filter((i) => draft.itemIds.includes(i.id))) {
      for (const alias of item.aliases) {
        const key = fold(alias);
        if (includeFolded.has(key) || aliasSeen.has(key)) continue;
        aliasSeen.add(key);
        aliases.push(alias);
      }
    }

    let exclude: string[] = [];
    if (draft.intents.includes("sell")) {
      const configured = await readConfigValue(handle, "watch.suggestExcludeSell");
      const list = resolveSuggestExclude({
        preset: await readConfigValue(handle, "watch.suggestExcludePreset"),
        custom: Array.isArray(configured) ? configured.filter((t): t is string => typeof t === "string") : [],
      });
      const existing = new Set(draft.exclude.map(fold));
      exclude = list.filter((t) => !existing.has(fold(t)));
    }

    const response: WatchParseResponse = {
      draft,
      warnings,
      suggestions: { aliases: aliases.slice(0, MAX_ALIAS_SUGGESTIONS), exclude, priceRange: await peerPriceRange(handle, actor.teamId, draft, now) },
    };
    return c.json(response);
  });

  return app;
}
