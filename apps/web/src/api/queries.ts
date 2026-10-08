import { useEffect, useState } from "react";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import { api, ApiError } from "./client";
import type { SourceTreeResponse } from "@feedhound/core/source-classify";
import type {
  ApiKeyDto,
  CatalogItemDto,
  CategoryDto,
  NotifierDto,
  FeedPostDto,
  MarkSeenDto,
  MatchesPageDto,
  MeDto,
  OpsHealthDto,
  OpsSloDto,
  PostDetailDto,
  InsightsPageDto,
  SourceDto,
  UserDto,
  WatchDto,
  WatchParseResponseDto,
  WatchTestResultDto,
} from "./types";

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: () => api.get<MeDto>("/me"),
    retry: false,
  });
}

export function useUsers(enabled = true) {
  return useQuery({ queryKey: ["users"], queryFn: async () => (await api.get<{ users: UserDto[] }>("/members")).users, enabled });
}

/** Notifiers of the caller, or of a same-team user when an operator passes `userId`. */
export function useNotifiers(userId?: string) {
  return useQuery({
    queryKey: ["notifiers", userId ?? "me"],
    queryFn: async () => (await api.get<{ notifiers?: NotifierDto[] }>(`/notifiers${userId ? `?userId=${userId}` : ""}`)).notifiers ?? [],
  });
}

export function useKeys() {
  return useQuery({ queryKey: ["keys"], queryFn: async () => (await api.get<{ keys: ApiKeyDto[] }>("/keys")).keys });
}

export function useSources() {
  return useQuery({ queryKey: ["sources"], queryFn: async () => (await api.get<{ sources: SourceDto[] }>("/sources")).sources });
}

export interface FeedPreviewItemDto {
  title: string;
  url: string;
  postedAt: string | null;
}

export interface FeedPreviewDto {
  title: string;
  url: string;
  items: FeedPreviewItemDto[];
}

/** Fetches a feed url once on the server and returns its first items; nothing is stored. */
export function usePreviewFeed() {
  return useMutation({
    mutationFn: (input: { url: string }) => api.post<FeedPreviewDto>("/sources/preview", input),
  });
}

export function useAddSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { url: string; name?: string; schedule?: unknown }) =>
      api.post<SourceDto & { preview?: FeedPreviewItemDto[] }>("/sources", input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sources"] });
      qc.invalidateQueries({ queryKey: ["source-tree"] });
    },
  });
}

export function usePatchSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string } & Record<string, unknown>) => api.patch<SourceDto>(`/sources/${id}`, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sources"] });
      qc.invalidateQueries({ queryKey: ["source-tree"] });
    },
  });
}

export function useSourceAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: "pause" | "resume" }) => api.post(`/sources/${id}/${action}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sources"] });
      qc.invalidateQueries({ queryKey: ["source-tree"] });
    },
  });
}

export function useWatches(userId?: string) {
  return useQuery({
    queryKey: ["watches", userId ?? "all"],
    queryFn: async () => (await api.get<{ watches: WatchDto[] }>(`/watches${userId ? `?userId=${userId}` : ""}`)).watches,
  });
}

/** Watches with per-card stats. Shares the `["watches"]` invalidation prefix. */
export function useWatchesWithStats(userId?: string) {
  return useQuery({
    queryKey: ["watches", "stats", userId ?? "me"],
    queryFn: async () => (await api.get<{ watches: WatchDto[] }>(`/watches?stats=1${userId ? `&userId=${userId}` : ""}`)).watches,
  });
}

export function useWatch(id: string | undefined) {
  return useQuery({
    queryKey: ["watch", id],
    queryFn: () => api.get<WatchDto>(`/watches/${id}`),
    enabled: !!id && id !== "new",
  });
}

export function useCreateWatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<WatchDto>) => api.post<WatchDto>("/watches", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["watches"] }),
  });
}

export function useUpdateWatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string } & Partial<WatchDto>) => api.patch<WatchDto>(`/watches/${id}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["watches"] }),
  });
}

export function useDeleteWatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/watches/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["watches"] }),
  });
}

export const PREVIEW_DEBOUNCE_MS = 600;
export const PREVIEW_HOURS = 168;

export class PreviewAborted extends Error {}

/**
 * Live preview. `draft` changes are debounced by PREVIEW_DEBOUNCE_MS; the query key is the debounced
 * draft, so only the latest draft's response is ever rendered and a superseded in-flight request is rejected
 * (react-query passes an AbortSignal that fires when the key changes).
 */
export function useWatchPreview(draft: Record<string, unknown> | null) {
  const serialized = draft ? JSON.stringify(draft) : null;
  const [settled, setSettled] = useState<string | null>(null);
  useEffect(() => {
    if (serialized === null) return;
    const t = setTimeout(() => setSettled(serialized), PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [serialized]);
  const active = serialized === null ? null : settled;
  const query = useQuery({
    queryKey: ["watch-preview", active],
    enabled: active !== null,
    staleTime: 30_000,
    queryFn: async ({ signal }) => {
      const body = JSON.parse(active ?? "{}") as Record<string, unknown>;
      const res = await api.post<WatchTestResultDto>(`/watches/test?hours=${PREVIEW_HOURS}`, body, { signal });
      if (signal.aborted) throw new PreviewAborted();
      return res;
    },
  });
  return { ...query, pending: serialized !== null && serialized !== settled };
}

export function useParseWatch() {
  return useMutation({
    mutationFn: (text: string) => api.post<WatchParseResponseDto>("/watches/parse", { text }),
  });
}

export function useCategories() {
  return useQuery({ queryKey: ["categories"], queryFn: async () => (await api.get<{ categories: CategoryDto[] }>("/categories")).categories });
}

/** Resolves catalog items for exactly the ids in use (<= 100), so chips can show names. */
export function useCatalogItemsByIds(ids: readonly string[]) {
  const key = [...new Set(ids)].sort().slice(0, 100);
  return useQuery({
    queryKey: ["catalog-items", "ids", key],
    enabled: key.length > 0,
    // Keep the previous names while a changed id list refetches, so chips do not flash to bare ids.
    placeholderData: keepPreviousData,
    queryFn: async () => (await api.get<{ items: CatalogItemDto[] }>(`/catalog-items?ids=${key.join(",")}&limit=100`)).items,
  });
}

export function useOpsHealth() {
  return useQuery({ queryKey: ["ops-health"], queryFn: () => api.get<OpsHealthDto>("/ops/health"), refetchInterval: 15000 });
}

export function useOpsSlo() {
  return useQuery({ queryKey: ["ops", "slo"], queryFn: () => api.get<OpsSloDto>("/ops/slo"), refetchInterval: 60000 });
}

export function usePost(id: string | undefined) {
  return useQuery({
    queryKey: ["post", id],
    queryFn: () => api.get<PostDetailDto>(`/posts/${id}`),
    enabled: Boolean(id),
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
  });
}

/** Once per `match.new` burst window: the matches inbox and the Overview KPI row. */
export function invalidateAfterMatchBurst(qc: QueryClient): void {
  qc.invalidateQueries({ queryKey: ["matches"] });
  qc.invalidateQueries({ queryKey: ["dashboard", "overview"] });
}

/** Live feed quick filters; every field maps 1:1 to a `/api/posts` query parameter. */
/**
 * `PUT`/`DELETE /api/posts/:id/flags/:kind`; 204 either way.
 * Hiding also drops every other cached card sharing the post's `repostKey` (the server hides the whole
 * repost group), from both the feed and the matches inbox. Undoing refetches them.
 */
export function usePostFlag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, kind, on }: { id: string; kind: "saved" | "hidden"; on: boolean; repostKey?: string | null }) =>
      on ? api.put<void>(`/posts/${id}/flags/${kind}`) : api.delete<void>(`/posts/${id}/flags/${kind}`),
    onMutate: ({ id, kind, on, repostKey }) => {
      if (kind !== "hidden" || !on || !repostKey) return;
      const sibling = (postId: string, key: string | null): boolean => key === repostKey && postId !== id;
      qc.setQueriesData<FeedPostDto[]>({ queryKey: ["feed"] }, (rows) => rows?.filter((r) => !sibling(r.id, r.repostKey)));
      qc.setQueriesData<InfiniteData<MatchesPageDto>>({ queryKey: ["matches"] }, (data) =>
        data && { ...data, pages: data.pages.map((p) => ({ ...p, matches: p.matches.filter((m) => !sibling(m.post.id, m.post.repostKey)) })) },
      );
    },
    onSuccess: (_d, { kind, on }) => {
      if (kind === "hidden" && !on) {
        void qc.invalidateQueries({ queryKey: ["feed"] });
        void qc.invalidateQueries({ queryKey: ["matches"] });
      }
    },
  });
}

/** Matches inbox, cursor-paged. "Load more" appends via `fetchNextPage` — page 1 is never refetched. */
export function useMatches(watchId?: string, filters?: Record<string, string>) {
  const filterKey = JSON.stringify(filters ?? {});
  return useInfiniteQuery({
    queryKey: ["matches", watchId ?? "all", filterKey],
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams({ limit: "50" });
      for (const [k, v] of Object.entries(filters ?? {})) params.set(k, v);
      if (watchId) params.set("watch", watchId);
      if (pageParam) params.set("cursor", pageParam);
      return api.get<MatchesPageDto>(`/dashboard/matches?${params.toString()}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

/**
 * Unread badge count. `refetchOnMount: "always"` covers app load; a WS
 * reconnect re-runs it via `invalidateAfterReconnect` (same hook point).
 */
export function useUnseenMatches() {
  return useQuery({
    queryKey: ["unseen-matches"],
    queryFn: async () => (await api.get<{ count: number }>("/dashboard/matches/unseen")).count,
    refetchOnMount: "always",
  });
}

/**
 * Mark every match as seen (`users.lastSeenMatchesAt = now`), then refresh the
 * badge. Does not invalidate `["matches"]` — the rows themselves did not
 * change, only the unseen watermark did.
 */
export function useMarkSeen() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (until?: string) => api.post<MarkSeenDto>("/dashboard/matches/seen", until ? { until } : undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["unseen-matches"] });
    },
  });
}

/** Corpus search, cursor-paged. `qs` is the filter query string without `cursor`/`limit`. */
/** Save the current search as a watch; `dropped` lists filters a watch cannot express. */
/** Operator CSV export: streams `/api/search/export.csv` into a download; resolves to `{ truncated }`. */
// Start a hunt.
/** Polls every 5 s while a group search is pending or running. */
// Topics + insights.
/** Daily series for sparklines / the detail chart. `days` back from now (UTC range sent as ISO). */
/** Unread count for the nav badge (cheap: limit=1). */
export function useInsightsUnread() {
  return useQuery({
    queryKey: ["insights-unread"],
    queryFn: async () => (await api.get<InsightsPageDto>("/insights?limit=1")).unread,
    refetchOnMount: "always",
  });
}

// Source library tree.
export function useSourceTree() {
  return useQuery({ queryKey: ["source-tree"], queryFn: () => api.get<SourceTreeResponse>("/source-groups/tree") });
}

export function useSetSourceOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; topicCategoryId?: string | null; region?: string | null }) =>
      api.put(`/source-groups/${id}/override`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["source-tree"] }),
  });
}

export function useClearSourceOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/source-groups/${id}/override`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["source-tree"] }),
  });
}

export function useReclassifySources() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post("/source-groups/reclassify"),
    onSuccess: () => setTimeout(() => qc.invalidateQueries({ queryKey: ["source-tree"] }), 3000),
  });
}

// Watch-driven source discovery.
