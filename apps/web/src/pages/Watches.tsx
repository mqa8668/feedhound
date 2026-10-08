import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/PageHeader";
import { EmptyState } from "@/components/layout/EmptyState";
import { ErrorState } from "@/components/layout/ErrorState";
import { OwnerSelect } from "@/components/watches/OwnerSelect";
import { WatchCard } from "@/components/watches/WatchCard";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/api/client";
import { useCatalogItemsByIds, useCategories, useCreateWatch, useDeleteWatch, useMe, useUpdateWatch, useUsers, useWatchesWithStats } from "@/api/queries";
import { copyName, nextSevenAm, summarizeWatch } from "@/lib/watch-summary";
import type { WatchDto } from "@/api/types";

const HOUR_MS = 3_600_000;

/** Fields of a watch that make up a create payload (no id, owner, stats, snooze). */
function copyPayload(w: WatchDto): Partial<WatchDto> {
  return {
    name: copyName(w.name),
    enabled: false,
    include: w.include,
    includeAll: w.includeAll,
    exclude: w.exclude,
    ...(w.regex ? { regex: w.regex } : {}),
    categoryIds: w.categoryIds,
    itemIds: w.itemIds,
    ...(w.priceMin !== null ? { priceMin: w.priceMin } : {}),
    ...(w.priceMax !== null ? { priceMax: w.priceMax } : {}),
    intents: w.intents,
    attributeFilters: w.attributeFilters ?? [],
    sourceIds: w.sourceIds,
    notifierIds: w.notifierIds,
    ...(w.quietHours ? { quietHours: w.quietHours } : {}),
  };
}

export default function Watches() {
  const { data: me } = useMe();
  const isOperator = me?.role === "operator";
  const { data: users } = useUsers(isOperator);
  const [searchParams, setSearchParams] = useSearchParams();
  // Operators can view (and create for) another team user's watches via `?owner=`.
  const ownerParam = searchParams.get("owner");
  const owner = isOperator && ownerParam && ownerParam !== me?.id ? ownerParam : undefined;
  const { data: watches, isLoading, isError, refetch } = useWatchesWithStats(owner);
  const { data: categories } = useCategories();
  const { data: items } = useCatalogItemsByIds((watches ?? []).flatMap((w) => w.itemIds));
  const createWatch = useCreateWatch();
  const updateWatch = useUpdateWatch();
  const deleteWatch = useDeleteWatch();
  const navigate = useNavigate();
  const { toast } = useToast();

  const fail = (title: string) => (err: unknown) =>
    toast({ title, description: err instanceof ApiError ? err.message : "Unknown error", variant: "destructive" });
  const patch = (id: string, body: Partial<WatchDto>) => updateWatch.mutate({ id, ...body }, { onError: fail("Could not update the watch") });

  const duplicate = (w: WatchDto) =>
    createWatch.mutate(owner ? { ...copyPayload(w), userId: owner } : copyPayload(w), {
      onSuccess: (created) => navigate(`/watches/${created.id}`),
      onError: fail("Could not duplicate the watch"),
    });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Watches"
        actions={
          <div className="flex flex-wrap items-center gap-3">
            {isOperator && me ? (
              <OwnerSelect
                id="watches-owner"
                users={users ?? []}
                value={owner ?? me.id}
                onChange={(id) => setSearchParams(id === me.id ? {} : { owner: id }, { replace: true })}
              />
            ) : null}
            <Button asChild>
              <Link to={owner ? `/watches/new?owner=${owner}` : "/watches/new"}>New watch</Link>
            </Button>
          </div>
        }
      />

      {isLoading ? (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-28 animate-pulse rounded-lg border bg-muted" />
          ))}
        </div>
      ) : null}
      {isError ? <ErrorState error={new Error("Watches unavailable right now.")} onRetry={() => refetch()} /> : null}
      {!isLoading && !isError && (!watches || watches.length === 0) ? (
        <EmptyState title="No watches yet" description="Create one to start matching posts." />
      ) : null}

      <ul className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {watches?.map((w) => (
          <WatchCard
            key={w.id}
            watch={w}
            summary={summarizeWatch(w, { categories: categories ?? [], items: items ?? [] })}
            onToggle={(enabled) => patch(w.id, { enabled })}
            onEdit={() => navigate(`/watches/${w.id}${owner ? `?owner=${owner}` : ""}`)}
            onDuplicate={() => duplicate(w)}
            onSnooze1h={() => patch(w.id, { mutedUntil: new Date(Date.now() + HOUR_MS).toISOString() })}
            onSnoozeTomorrow={() => patch(w.id, { mutedUntil: nextSevenAm(new Date()).toISOString() })}
            onUnsnooze={() => patch(w.id, { mutedUntil: null })}
            onDelete={() => deleteWatch.mutate(w.id, { onError: fail("Could not delete the watch") })}
          />
        ))}
      </ul>
    </div>
  );
}
