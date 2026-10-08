import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import { parse } from "yaml";
import { createDb } from "./index";
import { catalogItem, category, config, team, user } from "./schema/index";
import type * as schema from "./schema/index";
import { z } from "zod";

// Structural check of a taxonomy node's `attributes` (the full contract is `AttributeDef` in packages/core/src/attributes.ts;
// db must not import core, which depends on db).
const attributeNodeZ = z.array(
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("enum"), key: z.string().min(1), label: z.string(), values: z.array(z.string()).min(1) }).loose(),
    z.object({ kind: z.literal("ordered"), key: z.string().min(1), label: z.string(), values: z.array(z.string()).min(1) }).loose(),
    z.object({ kind: z.literal("text"), key: z.string().min(1), label: z.string(), maxLen: z.number().int().min(1) }).loose(),
    z.object({ kind: z.literal("number"), key: z.string().min(1), label: z.string(), unit: z.string(), min: z.number(), max: z.number() }).loose(),
  ]),
);

interface TaxonomyNode {
  slug: string;
  name: string;
  /** AttributeDef[] declared on this node (validated, then stored in `category.attribute_schema`). */
  attributes?: unknown;
  priceBounds?: { min?: number; max?: number };
  children?: TaxonomyNode[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = PgTransaction<any, typeof schema, any>;

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Idempotent: running this twice leaves row counts (config, category, team,
 * user) unchanged. Everything runs in a single transaction so a failure
 * midway does not leave a partially-seeded database.
 */
export async function seed(databaseUrl?: string, configDir: string = `${REPO_ROOT}config`): Promise<void> {
  const handle = createDb(databaseUrl);
  try {
    await handle.db.transaction(async (tx) => {
      await seedConfig(tx, configDir);
      await seedTaxonomy(tx, configDir);
      await seedCatalogue(tx, configDir);
      const teamId = await seedTeam(tx);
      await seedOperator(tx, teamId);
    });
  } finally {
    await handle.close();
  }
}

/**
 * Taxonomy (+ attribute schemas, price bounds) and catalogue items only: no config, team or operator rows.
 * Same upserts as `seed()`; used by integration tests that need the real taxonomy in a shared test database.
 */
export async function seedTaxonomyAndCatalogue(databaseUrl?: string, configDir: string = `${REPO_ROOT}config`): Promise<void> {
  const handle = createDb(databaseUrl);
  try {
    await handle.db.transaction(async (tx) => {
      await seedTaxonomy(tx, configDir);
      await seedCatalogue(tx, configDir);
    });
  } finally {
    await handle.close();
  }
}

async function seedConfig(tx: Tx, configDir: string): Promise<void> {
  const raw = readFileSync(`${configDir}/defaults.yaml`, "utf8");
  const defaults = parse(raw) as Record<string, unknown>;
  const rows = Object.entries(defaults).map(([key, value]) => ({
    key,
    version: 1,
    // A YAML `null` must land as JSON null, not SQL NULL (value is jsonb NOT NULL).
    value: value === null ? sql`'null'::jsonb` : value,
    updatedBy: "seed",
  }));
  if (rows.length === 0) return;
  // PK is (key, version); re-running with the same defaults is a no-op.
  await tx.insert(config).values(rows).onConflictDoNothing();
}

async function seedTaxonomy(tx: Tx, configDir: string): Promise<void> {
  const raw = readFileSync(`${configDir}/taxonomy.yaml`, "utf8");
  const nodes = parse(raw) as TaxonomyNode[];

  async function insertNode(
    node: TaxonomyNode,
    parentId: string | null,
    parentPath: string,
  ): Promise<void> {
    const path = parentPath ? `${parentPath}.${node.slug.replaceAll("-", "_")}` : node.slug.replaceAll("-", "_");
    const [inserted] = await tx
      .insert(category)
      .values({ parentId, slug: node.slug, name: node.name, path })
      .onConflictDoNothing({ target: category.path })
      .returning({ id: category.id });
    let id: string;
    if (inserted) {
      id = inserted.id;
    } else {
      const [existing] = await tx
        .select({ id: category.id })
        .from(category)
        .where(eq(category.path, path))
        .limit(1);
      if (!existing) throw new Error(`failed to insert or find category ${node.slug}`);
      id = existing.id;
    }
    // Attribute schema + price bounds are upserted from YAML on every run.
    const parsed = attributeNodeZ.safeParse(node.attributes ?? []);
    if (!parsed.success) {
      throw new Error(`seed: invalid attributes for category "${node.slug}": ${parsed.error.issues[0]?.message ?? "invalid"} at ${parsed.error.issues[0]?.path.join(".") ?? ""}`);
    }
    await tx
      .update(category)
      .set({ attributeSchema: parsed.data, priceMinVnd: node.priceBounds?.min ?? null, priceMaxVnd: node.priceBounds?.max ?? null })
      .where(eq(category.id, id));
    for (const child of node.children ?? []) {
      await insertNode(child, id, path);
    }
  }

  for (const node of nodes) {
    await insertNode(node, null, "");
  }
}

interface CatalogueEntry {
  categorySlug: string;
  name: string;
  aliases?: string[];
  attributes?: Record<string, string | number>;
}

/** Items are keyed by `(categoryId, name)`; aliases and attributes are replaced on every run. */
async function seedCatalogue(tx: Tx, configDir: string): Promise<void> {
  const raw = readFileSync(`${configDir}/catalogue.seed.yaml`, "utf8");
  const entries = (parse(raw) as CatalogueEntry[] | null) ?? [];
  const cats = await tx.select({ id: category.id, slug: category.slug }).from(category);
  const bySlug = new Map<string, string>();
  for (const c of cats) if (!bySlug.has(c.slug)) bySlug.set(c.slug, c.id);
  for (const e of entries) {
    const categoryId = bySlug.get(e.categorySlug);
    if (!categoryId) throw new Error(`seed: catalogue item "${e.name}" references unknown category "${e.categorySlug}"`);
    const values = { aliases: e.aliases ?? [], attributes: e.attributes ?? {} };
    const [existing] = await tx
      .select({ id: catalogItem.id })
      .from(catalogItem)
      .where(and(eq(catalogItem.categoryId, categoryId), eq(catalogItem.name, e.name)))
      .limit(1);
    if (existing) await tx.update(catalogItem).set(values).where(eq(catalogItem.id, existing.id));
    else await tx.insert(catalogItem).values({ categoryId, name: e.name, ...values });
  }
}

async function seedTeam(tx: Tx): Promise<string> {
  const NAME = "Default Team";
  const [existing] = await tx.select({ id: team.id }).from(team).where(eq(team.name, NAME)).limit(1);
  if (existing) return existing.id;
  const [row] = await tx.insert(team).values({ name: NAME, settings: {} }).returning({ id: team.id });
  if (!row) throw new Error("failed to insert default team");
  return row.id;
}

const LINK_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const LINK_CODE_LEN = 8;
const LINK_CODE_TTL_MS = 24 * 60 * 60 * 1000;

/** CSPRNG code generation (`crypto.getRandomValues`), rejection-sampled to avoid modulo bias. */
export function randomLinkCode(): string {
  let out = "";
  const rejectAt = 256 - (256 % LINK_CODE_ALPHABET.length);
  const buf = new Uint8Array(1);
  while (out.length < LINK_CODE_LEN) {
    crypto.getRandomValues(buf);
    const b = buf[0]!;
    if (b >= rejectAt) continue;
    out += LINK_CODE_ALPHABET[b % LINK_CODE_ALPHABET.length];
  }
  return out;
}

/**
 * `/link` flow: the seeded operator gets a fresh `linkCode`
 * (8 chars [A-Z0-9], 24h TTL) printed to stdout so it can be used with
 * `/link <code>` in the Telegram bot without needing the dashboard (005).
 */
async function seedOperator(tx: Tx, teamId: string): Promise<void> {
  const email = process.env.SEED_OPERATOR_EMAIL;
  if (!email) {
    console.warn("seed: SEED_OPERATOR_EMAIL not set, skipping operator user");
    return;
  }
  await tx.insert(user).values({ teamId, email, role: "operator" }).onConflictDoNothing({ target: user.email });

  const linkCode = randomLinkCode();
  const linkCodeExpiresAt = new Date(Date.now() + LINK_CODE_TTL_MS);
  await tx.update(user).set({ linkCode, linkCodeExpiresAt }).where(eq(user.email, email));
  console.log(`seed: telegram link code for ${email}: ${linkCode} (expires ${linkCodeExpiresAt.toISOString()})`);
}

if (import.meta.main) {
  await seed();
  console.log("seed: done");
}
