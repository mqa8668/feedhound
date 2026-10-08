import { buildAliasDict, type AliasDict, type CatalogItem, type Category } from "@feedhound/core/classify";
import { declaredSchemas, type Attributes } from "@feedhound/core/attributes";
import { createLogger } from "@feedhound/core/logger";
import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import type { CatalogueAttrs } from "../jobs/enrich";

const logger = createLogger({ service: "agent" });

const CATALOGUE_CHANGED_CHANNEL = "catalogue_changed";
const DEFAULT_REFRESH_SEC = 600;
const EMPTY_RELOAD_MIN_MS = 30_000;

export interface AliasCacheOptions {
  handle: DbHandle;
  refreshSec?: number;
}

/**
 * In-process alias dictionary: built from Category +
 * CatalogItem, rebuilt on `NOTIFY catalogue_changed` and every
 * `refreshSec` as a fallback. `enrich` always reads `get()`.
 */
export class AliasCache {
  private readonly handle: DbHandle;
  private refreshSec: number;
  private dict: AliasDict = { entries: [] };
  private categories: Category[] = [];
  private items: CatalogItem[] = [];
  private attrs: CatalogueAttrs = { tree: new Map(), schemas: new Map(), bounds: new Map(), itemAttributes: new Map() };
  private lastEmptyReload = 0;
  private unlisten: (() => Promise<void>) | undefined;
  private intervalHandle: ReturnType<typeof setInterval> | undefined;

  constructor(options: AliasCacheOptions) {
    this.handle = options.handle;
    this.refreshSec = options.refreshSec ?? DEFAULT_REFRESH_SEC;
  }

  get(): AliasDict {
    return this.dict;
  }

  /**
   * Minor: `enrich.aliasRefreshSec` was read into the
   * Config schema but never applied here -- the periodic reload always used
   * the 600 s default. Call before `start()` so `setInterval` picks it up.
   */
  setRefreshSec(refreshSec: number): void {
    this.refreshSec = refreshSec;
  }

  getCategories(): Category[] {
    return this.categories;
  }

  getItems(): CatalogItem[] {
    return this.items;
  }

  /** Attribute schemas, price bounds and item-level fixed attributes. */
  getAttrs(): CatalogueAttrs {
    // Seeded after start without a NOTIFY: self-heal (throttled) instead of waiting for the periodic reload.
    if (this.attrs.schemas.size === 0 && Date.now() - this.lastEmptyReload > EMPTY_RELOAD_MIN_MS) {
      this.lastEmptyReload = Date.now();
      this.reload().catch((err: unknown) => {
        logger.error({ err }, "alias-cache: empty-schema reload failed");
      });
    }
    return this.attrs;
  }

  async start(): Promise<void> {
    await this.reload();
    const { unlisten } = await this.handle.sql.listen(CATALOGUE_CHANGED_CHANNEL, () => {
      this.reload().catch((err: unknown) => {
        logger.error({ err }, "alias-cache: reload after catalogue_changed failed");
      });
    });
    this.unlisten = unlisten;
    this.intervalHandle = setInterval(() => {
      this.reload().catch((err: unknown) => {
        logger.error({ err }, "alias-cache: periodic reload failed");
      });
    }, this.refreshSec * 1000);
  }

  async stop(): Promise<void> {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    if (this.unlisten) await this.unlisten();
  }

  private async reload(): Promise<void> {
    const categoryRows = await this.handle.db
      .select({
        id: schema.category.id,
        parentId: schema.category.parentId,
        slug: schema.category.slug,
        name: schema.category.name,
        path: schema.category.path,
        attributeSchema: schema.category.attributeSchema,
        priceMinVnd: schema.category.priceMinVnd,
        priceMaxVnd: schema.category.priceMaxVnd,
      })
      .from(schema.category);
    const itemRows = await this.handle.db
      .select({
        id: schema.catalogItem.id,
        categoryId: schema.catalogItem.categoryId,
        name: schema.catalogItem.name,
        aliases: schema.catalogItem.aliases,
        attributes: schema.catalogItem.attributes,
      })
      .from(schema.catalogItem);

    const categories: Category[] = categoryRows.map((c) => ({ id: c.id, parentId: c.parentId, slug: c.slug, name: c.name }));
    const items: CatalogItem[] = itemRows.map((i) => ({ id: i.id, categoryId: i.categoryId, name: i.name, aliases: i.aliases }));

    this.dict = buildAliasDict(categories, items);
    this.categories = categories;
    this.items = items;
    this.attrs = {
      tree: new Map(categoryRows.map((c) => [c.id, c.path])),
      schemas: declaredSchemas(categoryRows),
      bounds: new Map(categoryRows.map((c) => [c.id, { min: c.priceMinVnd, max: c.priceMaxVnd }])),
      itemAttributes: new Map(itemRows.map((i) => [i.id, (i.attributes ?? {}) as Attributes])),
    };
    logger.info({ categories: categories.length, items: items.length }, "alias-cache: reloaded");
  }
}
