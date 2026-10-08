import { createLogger } from "@feedhound/core/logger";
import { maskPii } from "@feedhound/core/pii";
import { deriveSnippet } from "@feedhound/core/snippet";
import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Session } from "../middleware/cf-access";

const logger = createLogger({ service: "api" });

export type LiveFrame =
  | { type: "post.new"; ts: string; data: { postId: string; sourceId: string; title: string | null; priceVnd: number | null; intent: string | null; url: string; snippet: string | null; priceSuspect: boolean; displayTitle: string | null } }
  | { type: "post.updated"; ts: string; data: { postId: string; sourceId: string; title: string | null; priceVnd: number | null; intent: string | null; url: string; snippet: string | null; priceSuspect: boolean; displayTitle: string | null } }
  | { type: "match.new"; ts: string; data: { matchId: string; watchId: string; postId: string; title: string | null } }
  | { type: "source.health"; ts: string; data: { sourceId: string; status: string; reason?: string | null } }
  | { type: "config.changed"; ts: string; data: { key: string; version: number } }
  | { type: "thumb.ready"; ts: string; data: { postIds: string[] } };

/** Payload of the agent's `thumb_ready` NOTIFY (apps/agent/src/jobs/thumbs.ts). */
export const thumbReadyPayloadSchema = z.object({ postIds: z.array(z.string().uuid()).min(1).max(100) });

export interface LiveClient {
  session: Session;
  send(frame: LiveFrame): void;
}

/**
 * `/ws` live feed: LISTENs on the four post/match/source
 * channels backed by `packages/db/src/triggers/live-notify.sql`, plus the
 * existing `config_changed` channel, and fans each out to
 * connected clients. `match.new` is filtered per-client to watches the
 * client's session may read; `post.new`/`post.updated`/
 * `source.health` are filtered per-client by the post's/source's `teamId`
 * since sources — and therefore posts — belong
 * to exactly one team. `config.changed` is global (Config has no team).
 */
export class LiveFeed {
  private readonly handle: DbHandle;
  private readonly clients = new Set<LiveClient>();
  private listening: Promise<void> | undefined;

  constructor(handle: DbHandle) {
    this.handle = handle;
  }

  addClient(client: LiveClient): () => void {
    this.clients.add(client);
    this.ensureListening().catch((err) => {
      logger.error({ err }, "live feed: failed to start LISTEN");
    });
    return () => this.clients.delete(client);
  }

  private async ensureListening(): Promise<void> {
    if (this.listening) return this.listening;
    const started = (async () => {
      await this.handle.sql.listen("post_new", (payload) => void this.onPostNew(payload));
      await this.handle.sql.listen("post_updated", (payload) => void this.onPostUpdated(payload));
      await this.handle.sql.listen("match_new", (payload) => void this.onMatchNew(payload));
      await this.handle.sql.listen("source_health", (payload) => void this.onSourceHealth(payload));
      await this.handle.sql.listen("thumb_ready", (payload) =>
        this.onThumbReady(payload).catch((err) => logger.error({ err }, "live feed: thumb_ready fan-out failed")),
      );
      await this.handle.sql.listen("config_changed", (payload) => void this.onConfigChanged(payload));
    })();
    this.listening = started;
    try {
      await started;
    } catch (err) {
      // don't leave `this.listening` a permanently
      // rejected promise — clear it so the *next* `addClient` (e.g. after a
      // DB restart) retries the LISTEN instead of the feed staying dead for
      // the rest of the process.
      if (this.listening === started) this.listening = undefined;
      throw err;
    }
  }

  private broadcast(frame: LiveFrame, predicate?: (client: LiveClient) => boolean): void {
    for (const client of this.clients) {
      if (predicate && !predicate(client)) continue;
      try {
        client.send(frame);
      } catch (err) {
        logger.error({ err }, "live feed: failed to send frame to client");
      }
    }
  }

  private async onPostNew(postId: string): Promise<void> {
    const row = await this.loadPost(postId);
    if (!row) return;
    const { teamId, ...data } = row;
    this.broadcast(
      { type: "post.new", ts: new Date().toISOString(), data },
      (client) => client.session.teamId === teamId,
    );
  }

  private async onPostUpdated(postId: string): Promise<void> {
    const row = await this.loadPost(postId);
    if (!row) return;
    const { teamId, ...data } = row;
    this.broadcast(
      { type: "post.updated", ts: new Date().toISOString(), data },
      (client) => client.session.teamId === teamId,
    );
  }

  private async loadPost(postId: string) {
    const [row] = await this.handle.db
      .select({
        id: schema.post.id,
        sourceId: schema.post.sourceId,
        title: schema.post.title,
        url: schema.post.url,
        textNormalized: schema.post.textNormalized,
        teamId: schema.source.teamId,
      })
      .from(schema.post)
      .innerJoin(schema.source, eq(schema.source.id, schema.post.sourceId))
      .where(eq(schema.post.id, postId))
      .limit(1);
    if (!row) return undefined;
    const [enrichment] = await this.handle.db
      .select({ priceVnd: schema.enrichment.priceVnd, priceRaw: schema.enrichment.priceRaw, intent: schema.enrichment.intent, displayTitle: schema.enrichment.displayTitle })
      .from(schema.enrichment)
      .where(eq(schema.enrichment.postId, postId))
      .orderBy(desc(schema.enrichment.revision))
      .limit(1);
    const snippet = deriveSnippet(row.textNormalized, maskPii);
    return {
      postId: row.id,
      sourceId: row.sourceId,
      title: row.title === null ? null : maskPii(row.title),
      url: row.url,
      priceVnd: enrichment?.priceVnd ?? null,
      intent: enrichment?.intent ?? null,
      snippet: snippet === null ? null : maskPii(snippet),
      priceSuspect: enrichment !== undefined && enrichment.priceVnd === null && enrichment.priceRaw !== null && enrichment.priceRaw.trim() !== "",
      displayTitle: enrichment?.displayTitle ? maskPii(enrichment.displayTitle) : null,
      teamId: row.teamId,
    };
  }

  private async onThumbReady(raw: string): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = thumbReadyPayloadSchema.safeParse(json);
    if (!parsed.success) {
      logger.warn("live feed: ignoring malformed thumb_ready payload");
      return;
    }
    const rows = await this.handle.db
      .select({ id: schema.post.id, teamId: schema.source.teamId })
      .from(schema.post)
      .innerJoin(schema.source, eq(schema.source.id, schema.post.sourceId))
      .where(inArray(schema.post.id, parsed.data.postIds));
    const byTeam = new Map<string, string[]>();
    for (const r of rows) byTeam.set(r.teamId, [...(byTeam.get(r.teamId) ?? []), r.id]);
    for (const [teamId, postIds] of byTeam) {
      this.broadcast({ type: "thumb.ready", ts: new Date().toISOString(), data: { postIds } }, (client) => client.session.teamId === teamId);
    }
  }

  private async onMatchNew(matchId: string): Promise<void> {
    const [row] = await this.handle.db
      .select({
        id: schema.match.id,
        watchId: schema.match.watchId,
        postId: schema.match.postId,
        title: schema.post.title,
        watchUserId: schema.watch.userId,
        // `client.session.teamId` is set at ws-upgrade time from the verified
        // session (`apps/api/src/index.ts`), never client-supplied, so it's safe to trust
        // here — but the old `role === "operator"` short-circuit let *any* team's operator
        // through regardless of which team the match's watch actually belongs to.
        watchTeamId: schema.user.teamId,
      })
      .from(schema.match)
      .innerJoin(schema.post, eq(schema.post.id, schema.match.postId))
      .innerJoin(schema.watch, eq(schema.watch.id, schema.match.watchId))
      .innerJoin(schema.user, eq(schema.user.id, schema.watch.userId))
      .where(eq(schema.match.id, matchId))
      .limit(1);
    if (!row) return;
    this.broadcast(
      { type: "match.new", ts: new Date().toISOString(), data: { matchId: row.id, watchId: row.watchId, postId: row.postId, title: row.title === null ? null : maskPii(row.title) } },
      (client) => client.session.userId === row.watchUserId || (client.session.role === "operator" && client.session.teamId === row.watchTeamId),
    );
  }

  private async onSourceHealth(sourceId: string): Promise<void> {
    const [row] = await this.handle.db
      .select({ id: schema.source.id, status: schema.source.status, health: schema.source.health, teamId: schema.source.teamId })
      .from(schema.source)
      .where(eq(schema.source.id, sourceId))
      .limit(1);
    if (!row) return;
    const health = typeof row.health === "object" && row.health !== null ? (row.health as { reason?: string | null }) : {};
    this.broadcast(
      { type: "source.health", ts: new Date().toISOString(), data: { sourceId: row.id, status: row.status, reason: health.reason ?? null } },
      (client) => client.session.teamId === row.teamId,
    );
  }

  private onConfigChanged(key: string): void {
    void (async () => {
      const [row] = await this.handle.db
        .select({ version: schema.config.version })
        .from(schema.config)
        .where(eq(schema.config.key, key))
        .orderBy(desc(schema.config.version))
        .limit(1);
      if (!row) return;
      this.broadcast({ type: "config.changed", ts: new Date().toISOString(), data: { key, version: row.version } });
    })();
  }
}
