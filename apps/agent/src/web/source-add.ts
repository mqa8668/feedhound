import { schema, type DbHandle } from "@feedhound/db";
import { and, eq } from "drizzle-orm";
import { CONNECTORS } from "./registry";

export interface AddWebSourceInput {
  connector: string;
  url: string;
  name: string;
  category?: string | undefined;
  team?: string | undefined;
}

export type AddWebSourceResult = { ok: true; id: string; created: boolean } | { ok: false; error: string };

/** Create (idempotently) a server-polled web source. Never assigns an ingest key. */
export async function addWebSource(handle: DbHandle, input: AddWebSourceInput): Promise<AddWebSourceResult> {
  const connector = CONNECTORS.get(input.connector);
  if (!connector) return { ok: false, error: `unknown connector ${input.connector}` };
  const parsed = connector.parseSourceUrl(input.url);
  if (!parsed.ok) return { ok: false, error: parsed.reason };
  if (input.name.trim() === "") return { ok: false, error: "name required" };
  if (!parsed.platformId.startsWith(`${connector.id}:`)) return { ok: false, error: "connector platformId mismatch" };

  let teamId = input.team;
  if (teamId === undefined) {
    const teams = await handle.db.select({ id: schema.team.id }).from(schema.team).limit(2);
    if (teams.length !== 1) return { ok: false, error: teams.length === 0 ? "no team exists" : "several teams: pass --team" };
    teamId = teams[0]!.id;
  } else {
    const [t] = await handle.db.select({ id: schema.team.id }).from(schema.team).where(eq(schema.team.id, teamId)).limit(1);
    if (!t) return { ok: false, error: `team ${teamId} not found` };
  }

  const defaults: Record<string, string | number> = {};
  if (input.category !== undefined) {
    const [cat] = await handle.db.select({ id: schema.category.id }).from(schema.category).where(eq(schema.category.slug, input.category)).limit(1);
    if (!cat) return { ok: false, error: `category ${input.category} not found` };
    defaults.categoryId = cat.id;
  }

  const [existing] = await handle.db
    .select({ id: schema.source.id })
    .from(schema.source)
    .where(and(eq(schema.source.teamId, teamId), eq(schema.source.platformId, parsed.platformId)))
    .limit(1);
  if (existing) return { ok: true, id: existing.id, created: false };

  const [row] = await handle.db
    .insert(schema.source)
    .values({ teamId, kind: "web", platformId: parsed.platformId, name: input.name, url: parsed.url, defaults, assignedKeyId: null })
    .returning({ id: schema.source.id });
  return { ok: true, id: row!.id, created: true };
}
