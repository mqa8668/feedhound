import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card } from "@/components/layout/Card";
import { EmptyState } from "@/components/layout/EmptyState";
import { ErrorState } from "@/components/layout/ErrorState";
import { PageHeader } from "@/components/layout/PageHeader";
import { StatusBadge } from "@/components/layout/StatusBadge";
import { CompareBar, COMPARE_MAX } from "@/components/deal/CompareBar";
import { filtersFromParams, FILTER_KEYS, MatchFilters, type FilterParams } from "@/components/deal/MatchFilters";
import { ListingCard, type ListingCardRow } from "@/components/ListingCard";
import { useMarkSeen, useMatches, useUnseenMatches, useWatches } from "@/api/queries";
import type { MatchNotifications, MatchRowDto } from "@/api/types";

/** notifications value -> StatusBadge tone key (dot colour only; label comes from the value). */
const NOTIFICATION_TONE: Record<MatchNotifications, string> = {
  none: "disabled",
  pending: "pending",
  partial: "degraded",
  sent: "active",
  failed: "failed",
};

interface CompareSel {
  selected: ReadonlySet<string>;
  toggle: (postId: string, on: boolean) => void;
}

function MatchRow({ match, sel }: { match: MatchRowDto; sel: CompareSel }) {
  const row: ListingCardRow = {
    ...match.post,
    id: match.postId,
    priceVnd: match.priceVnd,
    priceQualifier: match.priceQualifier,
    priceMaxVnd: match.priceMaxVnd,
    dealMedianVnd: match.post.dealMedianVnd,
    dealN: match.post.dealN,
    intent: match.intent,
    firstSeenAt: match.createdAt,
  };
  return (
    <ListingCard
      row={row}
      sourceName={match.post.sourceName}
      compare={{
        checked: sel.selected.has(match.postId),
        disabled: sel.selected.size >= COMPARE_MAX,
        onChange: (on) => sel.toggle(match.postId, on),
      }}
      footer={
        <div className="mt-1 flex flex-wrap items-center gap-2 text-fs-sm text-muted-foreground">
          <span>{match.watch.name}</span>
          {match.matchedTerms.length > 0 ? <span className="truncate">matched: {match.matchedTerms.join(", ")}</span> : null}
          <StatusBadge status={NOTIFICATION_TONE[match.notifications]}>{match.notifications}</StatusBadge>
        </div>
      }
    />
  );
}

/** Matches inbox: watch filter, cursor-paged "Load more", "Mark all read" button. */
export default function Matches() {
  const [searchParams, setSearchParams] = useSearchParams();
  const watchId = searchParams.get("watch") ?? undefined;
  const navigate = useNavigate();
  const filters = filtersFromParams(searchParams);
  const { data: watches } = useWatches();
  const { data, isLoading, isError, hasNextPage, isFetchingNextPage, fetchNextPage } = useMatches(watchId, filters);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const sel: CompareSel = {
    selected,
    toggle: (postId, on) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (on) next.add(postId);
        else next.delete(postId);
        return next;
      }),
  };
  const applyFilters = (next: FilterParams) => {
    const sp = new URLSearchParams(searchParams);
    for (const k of FILTER_KEYS) sp.delete(k);
    for (const [k, v] of Object.entries(next)) sp.set(k, v);
    setSearchParams(sp);
  };
  const { mutate: markSeen, isPending: marking } = useMarkSeen();
  const [loadedAt] = useState(() => new Date().toISOString());
  const { data: unseen } = useUnseenMatches();

  const matches = data?.pages.flatMap((page) => page.matches) ?? [];
  const activeWatch = watches?.find((w) => w.id === watchId);
  // Viewing no longer marks read; the button posts the newest loaded createdAt.
  const newest = matches.reduce<string | null>((acc, m) => (acc === null || m.createdAt > acc ? m.createdAt : acc), null);
  const markAllRead = () => markSeen(newest ?? loadedAt);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Matches"
        description={unseen != null && unseen > 0 ? `${unseen} unread match${unseen === 1 ? "" : "es"}` : "Posts that matched your watches."}
      />
      <MatchFilters value={filters} capabilities={data?.pages[0]?.capabilities} onChange={applyFilters} />
      <Card
        title={activeWatch ? `Watch: ${activeWatch.name}` : "All watches"}
        actions={
          <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={markAllRead} disabled={marking || !unseen}>
            Mark all read
          </Button>
          <Select
            value={watchId ?? "all"}
            onValueChange={(v) => {
              const sp = new URLSearchParams(searchParams);
              if (v === "all") sp.delete("watch");
              else sp.set("watch", v);
              setSearchParams(sp);
            }}
          >
            <SelectTrigger className="w-40 sm:w-48" aria-label="Filter by watch">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All watches</SelectItem>
              {(watches ?? []).map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          </div>
        }
      >
        {isError ? <ErrorState error={new Error("Matches unavailable right now.")} /> : null}
        {isLoading && !isError ? (
          <div className="flex flex-col gap-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded bg-muted" />
            ))}
          </div>
        ) : null}
        {!isLoading && !isError && matches.length === 0 ? (
          <EmptyState
            title="No matches yet"
            description="When a post matches one of your watches it shows up here and the sidebar badge counts it."
          />
        ) : null}
        {!isLoading && !isError && matches.length > 0 ? (
          <>
            <ul className="flex flex-col">
              {matches.map((m) => (
                <MatchRow key={m.id} match={m} sel={sel} />
              ))}
            </ul>
            {hasNextPage ? (
              <div className="flex justify-center pt-4">
                <Button variant="outline" onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
                  {isFetchingNextPage ? "Loading…" : "Load more"}
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </Card>
      <CompareBar count={selected.size} onClear={() => setSelected(new Set())} onOpen={() => navigate(`/matches/compare?ids=${[...selected].join(",")}`)} />
    </div>
  );
}
