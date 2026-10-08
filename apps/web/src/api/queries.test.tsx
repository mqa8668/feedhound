import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useCatalogItemsByIds, useMarkSeen, useUnseenMatches, useWatchPreview } from "./queries";

// Seen -> refetch -> 0 without a reload, and
// the badge query refetching when the WS layer invalidates (load/reconnect).
// Fetch is mocked; WS status is irrelevant because invalidation is the hook
// point `ws.tsx` uses on reconnect.

const seenCalls: string[] = [];
const unseenCalls: string[] = [];
let unseenCount = 0;

function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const method = init?.method ?? "GET";
  if (url.endsWith("/matches/unseen")) {
    unseenCalls.push(url);
    return Promise.resolve(Response.json({ count: unseenCount }));
  }
  if (url.endsWith("/matches/seen") && method === "POST") {
    seenCalls.push(url);
    unseenCount = 0;
    return Promise.resolve(Response.json({ lastSeenMatchesAt: "2026-09-21T00:00:00Z" }));
  }
  return Promise.reject(new Error(`unexpected fetch: ${method} ${url}`));
}

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

describe("badge reconciliation", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(mockFetch));
    unseenCalls.length = 0;
    seenCalls.length = 0;
    unseenCount = 3;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("loads the count, marks seen, and drops to 0 without a reload", async () => {
    const { result } = renderHook(() => ({ unseen: useUnseenMatches(), markSeen: useMarkSeen() }), { wrapper });

    await waitFor(() => expect(result.current.unseen.data).toBe(3));
    expect(unseenCalls).toHaveLength(1);

    act(() => result.current.markSeen.mutate());

    await waitFor(() => expect(result.current.unseen.data).toBe(0));
    expect(seenCalls).toHaveLength(1);
    // markSeen invalidated the unseen query -> refetched, same page, no reload.
    expect(unseenCalls).toHaveLength(2);
  });

  test("refetches when the query is invalidated (the WS reconnect hook point)", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const mounted = renderHook(() => useUnseenMatches(), {
      wrapper: ({ children }) => createElement(QueryClientProvider, { client }, children),
    });

    await waitFor(() => expect(mounted.result.current.data).toBe(3));
    expect(unseenCalls).toHaveLength(1);

    unseenCount = 5;
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["unseen-matches"] });
    });

    await waitFor(() => expect(mounted.result.current.data).toBe(5));
    expect(unseenCalls).toHaveLength(2);
  });
});

describe("match burst flush", () => {
  test("invalidates matches and overview once each", async () => {
    const { QueryClient: QC } = await import("@tanstack/react-query");
    const { invalidateAfterMatchBurst } = await import("./queries");
    const qc = new QC();
    const spy = vi.spyOn(qc, "invalidateQueries");
    invalidateAfterMatchBurst(qc);
    const keys = spy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
    expect(keys.sort()).toEqual([JSON.stringify(["dashboard", "overview"]), JSON.stringify(["matches"])].sort());
  });
});

describe("", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test("useWatchPreview passes an AbortSignal to fetch", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    vi.stubGlobal("fetch", (_u: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal);
      return Promise.resolve(Response.json({ posts: [], total: 0, daily: [], truncated: false }));
    });
    renderHook(() => useWatchPreview({ name: "x", include: ["a"] }), { wrapper });
    await waitFor(() => expect(signals.length).toBe(1), { timeout: 3000 });
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  test("useCatalogItemsByIds requests exactly the ids; no fetch when empty", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", (u: RequestInfo | URL) => {
      urls.push(String(u));
      return Promise.resolve(Response.json({ items: [] }));
    });
    renderHook(() => useCatalogItemsByIds([]), { wrapper });
    const { result } = renderHook(() => useCatalogItemsByIds(["b", "a", "b"]), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(urls).toEqual(["/api/catalog-items?ids=a,b&limit=100"]);
  });
});
