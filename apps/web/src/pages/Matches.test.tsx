import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import Matches from "./Matches";
import { EMPTY_LISTING } from "@/components/ListingCard";
import { INTENT_VARIANT } from "@/lib/format";
import type { MatchRowDto, MatchesPageDto } from "@/api/types";

// Same intent variant map + price formatter as LiveFeed, `?watch=`
// pre-filters, and "Load more" appends the next cursor page without
// refetching page 1 (fetch call counts asserted). Fetch is mocked.

const watchIds = { w1: "11111111-1111-1111-1111-111111111111", w2: "22222222-2222-2222-2222-222222222222" };

function row(id: string, watchId: string, title: string): MatchRowDto {
  return {
    id,
    postId: `post-${id}`,
    watchId,
    score: 0.8,
    matchedTerms: ["iphone"],
    createdAt: "2026-09-20T10:00:00Z",
    post: { id: `post-${id}`, title, url: `https://example.com/${id}`, sourceId: "s1", sourceName: "Group A", ...EMPTY_LISTING },
    intent: "sell",
    priceVnd: 15000000,
    watch: { id: watchId, name: watchId === watchIds.w1 ? "iPhones" : "Bikes" },
    notifications: "sent",
  };
}

const page1: MatchesPageDto = { matches: [row("m1", watchIds.w1, "iPhone 15 pro max"), row("m2", watchIds.w2, "Bike for sale")], nextCursor: "cur-2" };
const page2: MatchesPageDto = { matches: [row("m3", watchIds.w1, "iPhone 14 cheap")], nextCursor: null };

const matchesCalls: string[] = [];

function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const method = init?.method ?? "GET";
  if (url.startsWith("/api/dashboard/matches?")) {
    matchesCalls.push(url);
    const isPage2 = url.includes("cursor=cur-2");
    const filtered = url.includes(`watch=${watchIds.w1}`);
    if (isPage2) return Promise.resolve(Response.json(page2));
    if (filtered) return Promise.resolve(Response.json({ matches: page1.matches.filter((m) => m.watchId === watchIds.w1), nextCursor: null }));
    return Promise.resolve(Response.json(page1));
  }
  if (url === "/api/watches") {
    return Promise.resolve(
      Response.json({
        watches: [
          { id: watchIds.w1, name: "iPhones" },
          { id: watchIds.w2, name: "Bikes" },
        ],
      }),
    );
  }
  if (url.endsWith("/matches/seen") && method === "POST") return Promise.resolve(Response.json({ lastSeenMatchesAt: "2026-09-21T00:00:00Z" }));
  if (url.endsWith("/matches/unseen")) return Promise.resolve(Response.json({ count: 3 }));
  return Promise.reject(new Error(`unexpected fetch: ${method} ${url}`));
}

function renderMatches(initialUrl = "/matches") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(MemoryRouter, { initialEntries: [initialUrl] }, createElement(Matches)),
    ),
  );
}

describe("Matches page", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(mockFetch));
    matchesCalls.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("uses the same intent variant map as LiveFeed", () => {
    expect(INTENT_VARIANT.sell).toBe("success-subtle");
    expect(INTENT_VARIANT.buy).toBe("info-subtle");
  });

  test("renders ListingCard rows with the compact price, intent dot, watch name and notification state", async () => {
    renderMatches();
    const item = await screen.findByText("iPhone 15 pro max");
    const rowEl = item.closest("li")!;
    expect(rowEl.hasAttribute("data-listing-card")).toBe(true);
    expect(within(rowEl).getByText("15M")).toBeTruthy();
    expect(within(rowEl).getByText("sell")).toBeTruthy();
    expect(rowEl.querySelector("[data-intent-dot='sell']")).not.toBeNull();
    expect(within(rowEl).getByText("iPhones")).toBeTruthy();
    expect(within(rowEl).getByText("sent")).toBeTruthy();
  });

  test("No /seen call on load; Mark all read posts {until} = newest loaded createdAt", async () => {
    renderMatches();
    await screen.findByText("iPhone 15 pro max");
    const seenCalls = () => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => String(c[0]).endsWith("/matches/seen"));
    expect(seenCalls().length).toBe(0);
    const btn = await screen.findByRole("button", { name: "Mark all read" });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(btn);
    await waitFor(() => expect(seenCalls().length).toBe(1));
    expect(JSON.parse(String((seenCalls()[0]![1] as RequestInit).body))).toEqual({ until: "2026-09-20T10:00:00Z" });
  });

  test("`?watch=` pre-filters the list", async () => {
    renderMatches("/matches?watch=11111111-1111-1111-1111-111111111111");
    await screen.findByText("iPhone 15 pro max");
    expect(screen.queryByText("Bike for sale")).toBeNull();
    expect(matchesCalls[0]).toContain(`watch=${watchIds.w1}`);
  });

  test("'Load more' appends the next cursor page without refetching page 1", async () => {
    renderMatches();
    await screen.findByText("iPhone 15 pro max");
    expect(matchesCalls).toHaveLength(1);

    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));

    await waitFor(() => expect(screen.getByText("iPhone 14 cheap")).toBeTruthy());
    // Page 1 fetched exactly once; page 2 appended by cursor.
    expect(matchesCalls).toHaveLength(2);
    expect(matchesCalls.filter((u) => u.includes("cursor=cur-2"))).toHaveLength(1);
    expect(matchesCalls[0]).not.toContain("cursor=");
    // Rows from both pages stay mounted.
    expect(screen.getByText("iPhone 15 pro max")).toBeTruthy();
    expect(screen.getByText("Bike for sale")).toBeTruthy();
    // Exhausted cursor -> no further button.
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  test("Title links to the post permalink, a separate external link keeps post.url", async () => {
    renderMatches();
    const title = await screen.findByText("iPhone 15 pro max");
    expect(title.closest("a")?.getAttribute("href")).toBe("/posts/post-m1");
    const rowEl = title.closest("li")!;
    const external = within(rowEl).getByRole("link", { name: /Open original/ });
    expect(external.getAttribute("href")).toBe("https://example.com/m1");
    expect(external.getAttribute("target")).toBe("_blank");
    expect(external.getAttribute("rel")).toBe("noopener noreferrer");
  });

  test("shows the empty state when no matches exist", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/dashboard/matches?")) return Promise.resolve(Response.json({ matches: [], nextCursor: null }));
        if (url === "/api/watches") return Promise.resolve(Response.json({ watches: [] }));
        if (url.endsWith("/matches/seen")) return Promise.resolve(Response.json({ lastSeenMatchesAt: "2026-09-21T00:00:00Z" }));
        if (url.endsWith("/matches/unseen")) return Promise.resolve(Response.json({ count: 0 }));
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      }),
    );
    renderMatches();
    await screen.findByText("No matches yet");
  });
});

// Market strip, floor price, filters in the URL, dismiss, compare selection.
describe("Matches page decision UI", () => {
  const ids = ["a", "b", "c", "d", "e"];
  const calls: { method: string; url: string }[] = [];
  const mk = (id: string, floor: boolean): MatchRowDto => ({
    ...row(`m-${id}`, watchIds.w1, `Kia Morning ${id}`),
    postId: id,
    post: { ...row(`m-${id}`, watchIds.w1, `Kia Morning ${id}`).post, id, dealMedianVnd: 203_000_000, dealN: 13 },
    priceVnd: 200_000_000,
    priceQualifier: floor ? "floor" : "exact",
  });
  function fetch052(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    if (url.startsWith("/api/dashboard/matches?")) {
      return Promise.resolve(Response.json({ matches: ids.map((id, i) => mk(id, i === 0)), nextCursor: null, capabilities: { listing: false, dealV2: false, risk: false, seller: false } }));
    }
    if (url === "/api/watches") return Promise.resolve(Response.json({ watches: [] }));
    if (url.endsWith("/matches/unseen")) return Promise.resolve(Response.json({ count: 0 }));
    if (method === "PUT" && url.includes("/flags/")) return Promise.resolve(new Response(null, { status: 204 }));
    return Promise.reject(new Error(`unexpected fetch: ${method} ${url}`));
  }
  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal("fetch", vi.fn(fetch052));
  });
  afterEach(() => vi.unstubAllGlobals());

  test("shows the market strip and floor price; hides drop sort when listing capability is off", async () => {
    renderMatches();
    await screen.findByText("Kia Morning a");
    expect(screen.getAllByText("Avg 203M · 13 listings")).toHaveLength(5);
    expect(screen.getByText("> 200M")).toBeTruthy();
    expect(screen.queryByText("Price drop")).toBeNull();
  });

  test("Price to 200 + Enter sets priceMax=200000000 in the query", async () => {
    renderMatches();
    await screen.findByText("Kia Morning a");
    const input = screen.getByLabelText("Price to (M)");
    fireEvent.change(input, { target: { value: "200" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(calls.some((c) => c.url.includes("priceMax=200000000"))).toBe(true));
  });

  test("Not interested PUTs hidden and removes the card", async () => {
    renderMatches();
    const card = (await screen.findByText("Kia Morning b")).closest("li")!;
    fireEvent.click(within(card).getByRole("button", { name: /Not interested/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.url === "/api/posts/b/flags/hidden")).toBe(true));
    await waitFor(() => expect(screen.queryByText("Kia Morning b")).toBeNull());
  });

  test("the 5th compare checkbox is disabled after 4 are ticked", async () => {
    renderMatches();
    await screen.findByText("Kia Morning a");
    const boxes = () => screen.getAllByRole("checkbox", { name: /Compare/ }) as HTMLInputElement[];
    for (const b of boxes().slice(0, 4)) fireEvent.click(b);
    await waitFor(() => expect(boxes()[4]!.disabled).toBe(true));
    expect(screen.getByRole("button", { name: "Compare (4)" })).toBeTruthy();
  });
});
