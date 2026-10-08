import { createDb, schema, type DbHandle } from "@feedhound/db";
import { createLogger } from "./logger";
import { desc, eq } from "drizzle-orm";
import type { ZodType } from "zod";

const CHANNEL = "config_changed";
const logger = createLogger({ service: "config" });

type ChangeCallback = (value: unknown) => void;

export interface ConfigServiceOptions {
  databaseUrl?: string;
}

/**
 * DB-backed, versioned config service with an in-memory cache invalidated by
 * `NOTIFY config_changed, '<key>'`. One instance per process; call `close()` on shutdown.
 */
export class ConfigService {
  private readonly handle: DbHandle;
  private readonly cache = new Map<string, unknown>();
  private readonly listeners = new Map<string, Set<ChangeCallback>>();
  // Bumped on every invalidation (NOTIFY-triggered or from our own setConfig).
  // getConfig only caches a freshly-parsed value if the generation is still
  // the one it started with, so a NOTIFY that lands mid-fetch can't cause a
  // stale value to be cached after the invalidation that raced it.
  private readonly generations = new Map<string, number>();
  private listenReady: Promise<void> | undefined;

  constructor(options: ConfigServiceOptions = {}) {
    this.handle = createDb(options.databaseUrl);
  }

  async getConfig<T>(key: string, valueSchema: ZodType<T>): Promise<T> {
    await this.ensureListening();
    if (this.cache.has(key)) return this.cache.get(key) as T;
    const generation = this.generations.get(key) ?? 0;
    const row = await this.fetchLatest(key);
    if (!row) throw new Error(`config key not found: ${key}`);
    const parsed = valueSchema.parse(row.value);
    if ((this.generations.get(key) ?? 0) === generation) {
      this.cache.set(key, parsed);
    }
    return parsed;
  }

  async setConfig<T>(key: string, value: T, updatedBy: string): Promise<void> {
    const current = await this.fetchLatest(key);
    const nextVersion = (current?.version ?? 0) + 1;
    await this.handle.db.insert(schema.config).values({
      key,
      version: nextVersion,
      value: value as unknown,
      updatedBy,
    });
    // Invalidate rather than cache the raw value: a same-process getConfig()
    // for this key may use a different schema than T, and the cache must
    // only ever hold schema-parsed values (see the NOTIFY handler below).
    this.cache.delete(key);
    this.bumpGeneration(key);
    await this.handle.sql.notify(CHANNEL, key);
  }

  /** Subscribe to changes for `key`. Returns an unsubscribe function. */
  onChange(key: string, cb: ChangeCallback): () => void {
    this.ensureListening().catch((err: unknown) => {
      logger.error({ err, key }, "config: failed to start listening for onChange");
    });
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(cb);
    return () => set?.delete(cb);
  }

  async close(): Promise<void> {
    await this.handle.close();
  }

  private bumpGeneration(key: string): number {
    const next = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, next);
    return next;
  }

  private async fetchLatest(key: string): Promise<{ version: number; value: unknown } | undefined> {
    const rows = await this.handle.db
      .select({ version: schema.config.version, value: schema.config.value })
      .from(schema.config)
      .where(eq(schema.config.key, key))
      .orderBy(desc(schema.config.version))
      .limit(1);
    return rows[0];
  }

  private ensureListening(): Promise<void> {
    if (!this.listenReady) {
      this.listenReady = this.handle.sql
        .listen(
          CHANNEL,
          (changedKey: string) => {
            // Invalidate rather than repopulate: the cache must only ever hold
            // schema-parsed values, and this handler has no schema for the key.
            // `getConfig` re-fetches and parses on next call.
            this.cache.delete(changedKey);
            this.bumpGeneration(changedKey);
            const set = this.listeners.get(changedKey);
            if (!set || set.size === 0) return;
            this.fetchLatest(changedKey)
              .then((row) => {
                if (!row) return;
                for (const cb of set) {
                  try {
                    cb(row.value);
                  } catch (err) {
                    logger.error({ err, key: changedKey }, "config onChange callback threw");
                  }
                }
              })
              .catch((err: unknown) => {
                logger.error({ err, key: changedKey }, "config: failed to refresh key after NOTIFY");
              });
          },
          () => {
            // Reconnect: the cache may be stale relative to whatever changed
            // while disconnected. Clear it and bump every known key's
            // generation so any fetch already in flight is not cached.
            this.cache.clear();
            for (const key of this.generations.keys()) this.bumpGeneration(key);
          },
        )
        .then(() => undefined)
        .catch((err: unknown) => {
          this.listenReady = undefined;
          throw err;
        });
    }
    return this.listenReady;
  }
}
