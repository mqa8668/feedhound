import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/layout/EmptyState";
import { useKeys, useReclassifySources, useSourceAction, useSources, useSourceTree } from "@/api/queries";
import { isOperator, useSession } from "@/lib/session";
import type { SourceLeaf, SourceTreeResponse as Tree } from "@feedhound/core/source-classify";
import { SourceLeafRow } from "./SourceLeafRow";
import { TreeNodeRow } from "./TreeNodeRow";
import { OverrideDialog } from "./OverrideDialog";
import { EditSourceDialog } from "./EditSourceDialog";

function filterTree(tree: Tree, q: string): Tree {
  if (!q) return tree;
  const match = (l: SourceLeaf) => `${l.name} ${l.url}`.toLowerCase().includes(q);
  return {
    ...tree,
    platforms: tree.platforms
      .map((p) => ({
        ...p,
        topics: p.topics
          .map((t) => ({ ...t, regions: t.regions.map((r) => ({ ...r, sources: r.sources.filter(match) })).filter((r) => r.sources.length > 0) }))
          .filter((t) => t.regions.length > 0),
      }))
      .filter((p) => p.topics.length > 0),
  };
}

export function SourceTree() {
  const { me } = useSession();
  const operator = isOperator(me);
  const { data: tree, isLoading, isError, refetch } = useSourceTree();
  const { data: sources } = useSources();
  const { data: keys, isError: keysError } = useKeys();
  const sourceAction = useSourceAction();
  const reclassify = useReclassifySources();
  const [query, setQuery] = useState("");
  // Ids the user flipped away from their default (regions default to collapsed under a topic with > 5 regions).
  const [flipped, setFlipped] = useState<Set<string>>(new Set());
  const [overriding, setOverriding] = useState<SourceLeaf | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const q = query.trim().toLowerCase();
  const view = useMemo(() => (tree ? filterTree(tree, q) : undefined), [tree, q]);
  const details = useMemo(() => new Map((sources ?? []).map((s) => [s.id, s])), [sources]);
  const editing = editingId ? details.get(editingId) : undefined;

  const toggle = (id: string) =>
    setFlipped((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const isOpen = (id: string, defaultOpen = true) => q !== "" || (flipped.has(id) ? !defaultOpen : defaultOpen);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
        <Input
          type="search"
          aria-label="Search sources"
          placeholder="Search sources"
          className="min-w-0 flex-1 sm:max-w-xs"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {operator ? (
          <Button variant="outline" size="sm" disabled={reclassify.isPending} onClick={() => reclassify.mutate()}>
            {reclassify.isPending ? "Queuing…" : reclassify.isSuccess ? "Reclassify queued" : "Reclassify"}
          </Button>
        ) : null}
      </div>
      {isLoading ? (
        <p className="p-4 text-sm text-muted-foreground">Loading sources…</p>
      ) : isError ? (
        <div className="p-4">
          <p className="text-sm text-destructive">Sources unavailable</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      ) : !view || view.platforms.length === 0 ? (
        <EmptyState title={q ? "No sources match" : "No sources yet"} description={q ? "Try another search." : "Add one to get started."} />
      ) : (
        view.platforms.map((p) => (
          <section key={p.key} aria-label={p.label}>
            <TreeNodeRow label={p.label} depth={0} rollup={p.rollup} open={isOpen(p.key)} onToggle={() => toggle(p.key)} />
            {isOpen(p.key)
              ? p.topics.map((t) => {
                  const tid = `${p.key}/${t.key}`;
                  return (
                    <div key={tid}>
                      <TreeNodeRow label={t.label} depth={1} rollup={t.rollup} open={isOpen(tid)} onToggle={() => toggle(tid)} />
                      {isOpen(tid)
                        ? t.regions.map((r) => {
                            const rid = `${tid}/${r.key}`;
                            return (
                              <div key={rid}>
                                <TreeNodeRow label={r.label} depth={2} rollup={r.rollup} open={isOpen(rid, t.regions.length <= 5)} onToggle={() => toggle(rid)} />
                                {isOpen(rid, t.regions.length <= 5) ? (
                                  <ul>
                                    {r.sources.map((l) => (
                                      <SourceLeafRow
                                        key={l.id}
                                        leaf={l}
                                        minPosts={tree?.minPosts ?? 20}
                                        detail={details.get(l.id)}
                                        keys={keys}
                                        keysError={keysError}
                                        operator={operator}
                                        onEdit={() => setEditingId(l.id)}
                                        onToggle={() => sourceAction.mutate({ id: l.id, action: l.status === "active" ? "pause" : "resume" })}
                                        onOverride={() => setOverriding(l)}
                                      />
                                    ))}
                                  </ul>
                                ) : null}
                              </div>
                            );
                          })
                        : null}
                    </div>
                  );
                })
              : null}
          </section>
        ))
      )}
      {overriding && <OverrideDialog key={overriding.id} leaf={overriding} regions={tree?.regionOptions ?? []} onClose={() => setOverriding(null)} />}
      {editing && <EditSourceDialog key={editing.id} source={editing} onClose={() => setEditingId(null)} />}
    </div>
  );
}
