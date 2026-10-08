import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { Icon } from "@/components/ui/Icon";
import { Input } from "@/components/ui/input";
import type { CategoryDto } from "@/api/types";

function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/đ/g, "d");
}

export interface CategoryTreePickerProps {
  categories: CategoryDto[];
  selectedIds: string[];
  /** Checking a node selects that node's id only (the matcher covers descendants). */
  onToggle: (id: string) => void;
}

/** Searchable, collapsible category tree. Search keeps ancestors of every hit visible. */
export function CategoryTreePicker({ categories, selectedIds, onToggle }: CategoryTreePickerProps) {
  const [query, setQuery] = useState("");
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map());

  const { children, byId } = useMemo(() => {
    const kids = new Map<string | null, CategoryDto[]>();
    const map = new Map<string, CategoryDto>();
    for (const c of categories) {
      map.set(c.id, c);
      const arr = kids.get(c.parentId) ?? [];
      arr.push(c);
      kids.set(c.parentId, arr);
    }
    for (const arr of kids.values()) arr.sort((a, b) => a.name.localeCompare(b.name, "vi"));
    return { children: kids, byId: map };
  }, [categories]);

  const q = fold(query.trim());
  const visible = useMemo(() => {
    if (!q) return null;
    const keep = new Set<string>();
    for (const c of categories) {
      if (fold(c.name).includes(q) || fold(c.slug).includes(q)) {
        let cur: CategoryDto | undefined = c;
        while (cur && !keep.has(cur.id)) {
          keep.add(cur.id);
          cur = cur.parentId ? byId.get(cur.parentId) : undefined;
        }
      }
    }
    return keep;
  }, [q, categories, byId]);

  // Ancestors of selected nodes start open so a chosen category is never hidden.
  const forcedOpen = useMemo(() => {
    const open = new Set<string>();
    for (const id of selectedIds) {
      let cur = byId.get(id)?.parentId ?? null;
      while (cur && !open.has(cur)) {
        open.add(cur);
        cur = byId.get(cur)?.parentId ?? null;
      }
    }
    return open;
  }, [selectedIds, byId]);

  const isOpen = (id: string) => visible !== null || (overrides.get(id) ?? forcedOpen.has(id));
  const toggleOpen = (id: string) =>
    setOverrides((prev) => {
      const next = new Map(prev);
      next.set(id, !(prev.get(id) ?? forcedOpen.has(id)));
      return next;
    });

  const renderLevel = (parent: string | null, depth: number) => {
    const nodes = (children.get(parent) ?? []).filter((c) => !visible || visible.has(c.id));
    if (nodes.length === 0) return null;
    return (
      <ul className={depth === 0 ? "flex flex-col" : "ml-4 flex flex-col border-l border-line pl-2"}>
        {nodes.map((c) => {
          const hasKids = (children.get(c.id) ?? []).some((k) => !visible || visible.has(k.id));
          const open = isOpen(c.id);
          const checkId = `cat-${c.id}`;
          return (
            <li key={c.id}>
              <div className="flex min-h-8 items-center gap-1">
                {hasKids ? (
                  <button
                    type="button"
                    aria-label={open ? `Collapse ${c.name}` : `Expand ${c.name}`}
                    aria-expanded={open}
                    onClick={() => toggleOpen(c.id)}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Icon icon={open ? ChevronDown : ChevronRight} />
                  </button>
                ) : (
                  <span className="inline-block h-8 w-8 shrink-0" aria-hidden="true" />
                )}
                <input id={checkId} type="checkbox" checked={selectedIds.includes(c.id)} onChange={() => onToggle(c.id)} />
                <label htmlFor={checkId} className="min-w-0 flex-1 cursor-pointer truncate text-sm">
                  {c.name}
                </label>
              </div>
              {hasKids && open ? renderLevel(c.id, depth + 1) : null}
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2">
          <Icon icon={Search} />
        </span>
        <Input aria-label="Search categories" placeholder="Search categories…" className="pl-9" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="max-h-64 overflow-y-auto rounded-md border border-line p-1">
        {categories.length === 0 ? (
          <p className="p-2 text-sm text-muted-foreground">No categories yet.</p>
        ) : visible && visible.size === 0 ? (
          <p className="p-2 text-sm text-muted-foreground">No categories found.</p>
        ) : (
          renderLevel(null, 0)
        )}
      </div>
    </div>
  );
}
