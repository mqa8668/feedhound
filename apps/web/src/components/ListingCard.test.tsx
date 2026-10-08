import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EMPTY_LISTING, ListingCard, chipsFor, type ListingCardRow } from "./ListingCard";

// Card content, CTAs, placeholder, grouping label.
const NOW = new Date("2026-10-04T10:00:00Z");

const ROW: ListingCardRow = {
  ...EMPTY_LISTING,
  id: "p1",
  sourceId: "s1",
  url: "https://feeds.example.test/g/posts/1",
  title: "ban xe",
  snippet: null,
  priceVnd: 680_000_000,
  intent: "sell",
  firstSeenAt: "2026-10-04T09:58:00Z",
  displayTitle: "Hyundai Santafe 2019 · 62.000 km",
  thumbUrl: "/api/media/p1/thumb",
  categoryId: "c0c0c0c0-0000-4000-8000-000000000001",
  attributes: { make: "Hyundai", model: "Santafe", year: 2019, odo_km: 62000 },
  dealPct: -8.4,
  hasPhone: true,
};

const calls: { method: string; url: string }[] = [];

function LocationProbe() {
  const loc = useLocation();
  return createElement("pre", { "data-testid": "loc" }, JSON.stringify({ path: loc.pathname, state: loc.state }));
}

function mount(row: ListingCardRow = ROW, client: QueryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })) {
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        { initialEntries: ["/"] },
        createElement(
          Routes,
          null,
          createElement(Route, { path: "/", element: createElement("ul", null, createElement(ListingCard, { row, sourceName: "Hội xe", now: NOW })) }),
          createElement(Route, { path: "*", element: createElement(LocationProbe) }),
        ),
      ),
    ),
  );
}

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url: String(input) });
      return Promise.resolve(new Response(null, { status: 204 }));
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ListingCard", () => {
  test("thumbnail, chips, compact price and the good deal badge", () => {
    mount();
    const img = document.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("/api/media/p1/thumb");
    expect(img.getAttribute("width")).toBe("96");
    expect(img.getAttribute("height")).toBe("72");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect([...document.querySelectorAll("[data-chip]")].map((n) => n.textContent)).toEqual(["Hyundai", "2019", "62.000 km"]);
    expect(screen.getByText("680M").getAttribute("class")).toContain("tabular-nums");
    const badge = screen.getByText("▼8% vs avg");
    expect(badge.getAttribute("class")).toContain("text-good");
    expect(screen.getByText("Hyundai Santafe 2019 · 62.000 km")).toBeTruthy();
  });

  test("priceSuspect shows Price unclear and no number", () => {
    mount({ ...ROW, priceSuspect: true, priceVnd: null });
    expect(screen.getByText("Price unclear")).toBeTruthy();
    expect(screen.queryByText("680M")).toBeNull();
    expect(document.querySelector("[data-deal-badge]")).toBeNull();
  });

  test("null thumbUrl and an image error both show the placeholder", () => {
    const { unmount } = mount({ ...ROW, thumbUrl: null });
    expect(document.querySelector("[data-thumb-placeholder]")).not.toBeNull();
    expect(document.querySelector("img")).toBeNull();
    unmount();
    mount();
    fireEvent.error(document.querySelector("img")!);
    expect(document.querySelector("[data-thumb-placeholder]")).not.toBeNull();
  });

  test("a 3-source row shows 'posted in 3 sources'; a single-source row does not", () => {
    const { unmount } = mount({
      ...ROW,
      alsoIn: [
        { postId: "p2", sourceId: "s2", url: "u2" },
        { postId: "p3", sourceId: "s3", url: "u3" },
      ],
    });
    expect(screen.getByText("posted in 3 sources")).toBeTruthy();
    unmount();
    mount();
    expect(screen.queryByText(/posted in/)).toBeNull();
  });

  test("hasPhone: a link to the post named 'Show phone at original post', no copy button, no clipboard use", () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    mount();
    const link = screen.getByRole("link", { name: "Show phone at original post" });
    expect(link.getAttribute("href")).toBe(ROW.url);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(screen.queryByRole("button", { name: /Copy phone/ })).toBeNull();
    fireEvent.click(link);
    expect(writeText).not.toHaveBeenCalled();
  });

  test("no phone, no phone link", () => {
    mount({ ...ROW, hasPhone: false });
    expect(screen.queryByRole("link", { name: "Show phone at original post" })).toBeNull();
  });

  test("labels follow the generic web platform and the group word is 'source'", () => {
    const base: ListingCardRow = { ...ROW, hasPhone: true, alsoIn: [{ postId: "p2", sourceId: "s2", url: "u2" }, { postId: "p3", sourceId: "s3", url: "u3" }] };
    mount(base);
    expect(screen.getByRole("link", { name: "Open original ↗" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Show phone at original post" })).toBeTruthy();
    expect(screen.getByText("posted in 3 sources")).toBeTruthy();
  });

  test("Open original opens the post in a new tab with noopener", () => {
    mount();
    const a = screen.getByRole("link", { name: /Open original/ });
    expect(a.getAttribute("href")).toBe(ROW.url);
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toContain("noopener");
  });

  test("Save toggles saved with PUT then DELETE", async () => {
    mount();
    const save = screen.getByRole("button", { name: /Save/ });
    expect(save.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(save);
    expect(save.getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(calls).toContainEqual({ method: "PUT", url: "/api/posts/p1/flags/saved" }));
    fireEvent.click(save);
    expect(save.getAttribute("aria-pressed")).toBe("false");
    await waitFor(() => expect(calls).toContainEqual({ method: "DELETE", url: "/api/posts/p1/flags/saved" }));
  });

  test("Not interested PUTs hidden, removes the card, and Undo restores it", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Not interested/ }));
    expect(screen.queryByText("Hyundai Santafe 2019 · 62.000 km")).toBeNull();
    await waitFor(() => expect(calls).toContainEqual({ method: "PUT", url: "/api/posts/p1/flags/hidden" }));
    fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
    await waitFor(() => expect(calls).toContainEqual({ method: "DELETE", url: "/api/posts/p1/flags/hidden" }));
    expect(screen.getByText("Hyundai Santafe 2019 · 62.000 km")).toBeTruthy();
  });

  test("Undo sends DELETE only after the pending PUT has settled", async () => {
    let releasePut: () => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        calls.push({ method, url: String(input) });
        if (method === "PUT") return new Promise<Response>((r) => (releasePut = () => r(new Response(null, { status: 204 }))));
        return Promise.resolve(new Response(null, { status: 204 }));
      }),
    );
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Not interested/ }));
    await waitFor(() => expect(calls.map((c) => c.method)).toEqual(["PUT"]));
    fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.map((c) => c.method)).toEqual(["PUT"]);
    releasePut();
    await waitFor(() => expect(calls.map((c) => c.method)).toEqual(["PUT", "DELETE"]));
  });

  test("hiding drops other cached cards with the same repostKey from feed and matches, keeping the card itself", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const rk = "rk-1";
    const feedRow = (id: string, repostKey: string | null) => ({ ...ROW, id, repostKey });
    client.setQueryData(["feed", 50, {}], [feedRow("p1", rk), feedRow("p2", rk), feedRow("p3", null)]);
    const m = (id: string, repostKey: string | null) => ({ id: `m-${id}`, postId: id, post: { ...feedRow(id, repostKey), sourceName: "x" } });
    client.setQueryData(["matches", "all"], { pageParams: [undefined], pages: [{ matches: [m("p1", rk), m("p2", rk), m("p3", null)], nextCursor: null }] });
    mount({ ...ROW, repostKey: rk }, client);
    fireEvent.click(screen.getByRole("button", { name: /Not interested/ }));
    await waitFor(() => expect(calls).toContainEqual({ method: "PUT", url: "/api/posts/p1/flags/hidden" }));
    expect((client.getQueryData(["feed", 50, {}]) as { id: string }[]).map((r) => r.id)).toEqual(["p1", "p3"]);
    const pages = (client.getQueryData(["matches", "all"]) as { pages: { matches: { postId: string }[] }[] }).pages;
    expect(pages[0]!.matches.map((x) => x.postId)).toEqual(["p1", "p3"]);
  });

  test("the source avatar shows only without a thumbnail or after an image error", () => {
    const { unmount } = mount();
    expect(document.querySelector("[data-avatar-slot]")).toBeNull();
    fireEvent.error(document.querySelector("img")!);
    expect(document.querySelector("[data-avatar-slot]")).not.toBeNull();
    unmount();
    mount({ ...ROW, thumbUrl: null });
    expect(document.querySelector("[data-avatar-slot]")).not.toBeNull();
  });

  test("the CTA row is a primary link plus icon-only buttons with accessible names", () => {
    mount();
    for (const name of ["Save", "Not interested", "Add to watch"]) {
      const b = screen.getByRole("button", { name });
      expect(b.getAttribute("title")).toBe(name);
      expect(b.textContent).toBe("");
    }
  });

  test("the undo bar disappears after 5 s", () => {
    vi.useFakeTimers();
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Not interested/ }));
    expect(screen.getByRole("button", { name: /Undo/ })).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(5100);
    });
    expect(screen.queryByRole("button", { name: /Undo/ })).toBeNull();
    expect(document.querySelector("[data-listing-card]")).toBeNull();
  });

  test("Add to watch navigates to /watches/new with the draft and posts nothing", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Add to watch/ }));
    const loc = JSON.parse(screen.getByTestId("loc").textContent!) as { path: string; state: { draft: { name: string; priceMin: number; priceMax: number; intents: string[] } } };
    expect(loc.path).toBe("/watches/new");
    expect(loc.state.draft).toMatchObject({ name: "Hyundai Santafe 2019", priceMin: 578_000_000, priceMax: 782_000_000, intents: ["sell"] });
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  test("chipsFor keeps CAR_CHIP_KEYS order and appends the region", () => {
    expect(chipsFor({ attributes: { fuel: "ev", transmission: "at", year: 2020, make: "mercedes_benz" }, region: "hcm" })).toEqual(["Mercedes-Benz", "2020", "AT", "EV", "HCMC"]);
    expect(chipsFor({ attributes: null, region: null })).toEqual([]);
  });

  test.each([
    ["floor", null, "> 200M"],
    ["ceiling", null, "< 200M"],
    ["approx", null, "~200M"],
    ["range", 250_000_000, "200–250M"],
    ["exact", null, "200M"],
  ])("price qualifier %s renders %s", (qualifier, max, text) => {
    mount({ ...ROW, priceVnd: 200_000_000, priceQualifier: qualifier as never, priceMaxVnd: max });
    expect(screen.getByText(text)).toBeTruthy();
  });
});
