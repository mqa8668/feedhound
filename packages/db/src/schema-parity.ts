import { getTableName, is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import type { DbHandle } from "./index";
import * as schema from "./schema/index";

// Schema-parity check. Compares the *named* objects (non-constraint indexes, CHECKs,
// UNIQUE constraints, FKs + ON DELETE action) Drizzle declares against what the migrated DB has.
// Triggers, column defaults and generated expressions are out of scope.

export type FkAction = "cascade" | "set null" | "no action" | "restrict" | "set default";

export interface TableObjects {
  indexes: string[];
  checks: string[];
  uniques: string[];
  fks: { name: string; onDelete: FkAction }[];
}

function emptyObjects(): TableObjects {
  return { indexes: [], checks: [], uniques: [], fks: [] };
}

function normalize(o: TableObjects): TableObjects {
  return {
    indexes: [...o.indexes].sort(),
    checks: [...o.checks].sort(),
    uniques: [...o.uniques].sort(),
    fks: [...o.fks].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function drizzleObjects(): Record<string, TableObjects> {
  const out: Record<string, TableObjects> = {};
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const cfg = getTableConfig(value);
    out[getTableName(value)] = normalize({
      indexes: cfg.indexes.map((i) => i.config.name ?? ""),
      checks: cfg.checks.map((c) => c.name),
      uniques: [
        ...cfg.uniqueConstraints.map((u) => u.name ?? u.getName() ?? ""),
        ...cfg.columns.filter((c) => c.isUnique).map((c) => c.uniqueName ?? ""),
      ],
      fks: cfg.foreignKeys.map((f) => ({
        name: f.getName(),
        onDelete: (f.onDelete ?? "no action") as FkAction,
      })),
    });
  }
  return out;
}

const FK_ACTIONS: Record<string, FkAction> = {
  a: "no action",
  r: "restrict",
  c: "cascade",
  n: "set null",
  d: "set default",
};

export async function dbObjects(handle: DbHandle): Promise<Record<string, TableObjects>> {
  const { sql } = handle;
  const out: Record<string, TableObjects> = {};
  const at = (t: string): TableObjects => (out[t] ??= emptyObjects());

  const tables = await sql<{ t: string }[]>`
    select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'`;
  for (const { t } of tables) at(t);

  // Indexes that do not back a pk/unique constraint.
  const idx = await sql<{ t: string; name: string }[]>`
    select t.relname as t, i.relname as name
    from pg_index x join pg_class i on i.oid = x.indexrelid join pg_class t on t.oid = x.indrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and not exists (select 1 from pg_constraint k where k.conindid = x.indexrelid and k.contype in ('p','u'))`;
  for (const r of idx) at(r.t).indexes.push(r.name);

  const cons = await sql<{ t: string; name: string; type: string; action: string }[]>`
    select t.relname as t, k.conname as name, k.contype::text as type, k.confdeltype::text as action
    from pg_constraint k join pg_class t on t.oid = k.conrelid join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and k.contype in ('c','u','f')`;
  for (const r of cons) {
    const o = at(r.t);
    if (r.type === "c") o.checks.push(r.name);
    else if (r.type === "u") o.uniques.push(r.name);
    else o.fks.push({ name: r.name, onDelete: FK_ACTIONS[r.action] ?? "no action" });
  }
  for (const k of Object.keys(out)) out[k] = normalize(at(k));
  return out;
}

/** Human-readable differences between two object maps; empty array = parity. */
export function diffObjects(a: Record<string, TableObjects>, b: Record<string, TableObjects>): string[] {
  const diffs: string[] = [];
  const tables = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const t of tables) {
    const x = a[t];
    const y = b[t];
    if (!x) {
      diffs.push(`table ${t}: only in second`);
      continue;
    }
    if (!y) {
      diffs.push(`table ${t}: only in first`);
      continue;
    }
    for (const kind of ["indexes", "checks", "uniques"] as const) {
      for (const n of x[kind]) if (!y[kind].includes(n)) diffs.push(`${t}.${kind}: ${n} only in first`);
      for (const n of y[kind]) if (!x[kind].includes(n)) diffs.push(`${t}.${kind}: ${n} only in second`);
    }
    for (const f of x.fks) {
      const g = y.fks.find((h) => h.name === f.name);
      if (!g) diffs.push(`${t}.fks: ${f.name} only in first`);
      else if (g.onDelete !== f.onDelete) diffs.push(`${t}.fks: ${f.name} onDelete ${f.onDelete} != ${g.onDelete}`);
    }
    for (const g of y.fks) if (!x.fks.some((f) => f.name === g.name)) diffs.push(`${t}.fks: ${g.name} only in second`);
  }
  return diffs;
}
