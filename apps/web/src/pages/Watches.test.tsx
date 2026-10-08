import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import Watches from "./Watches";
import { ToastProvider } from "@/components/ui/toast";
import type { WatchDto } from "@/api/types";

// Card summary + deal, switch PATCH, snooze, duplicate, in-card delete confirm, "No route".
const M = "00000000-0000-4000-8000-0000000000a2";
const IT = ["00000000-0000-4000-8000-0000000000b1", "00000000-0000-4000-8000-0000000000b2", "00000000-0000-4000-8000-0000000000b3"];
const W1 = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";

const BASE: WatchDto = {
  id: W1,
  userId: "u",
  name: "MacBook M2+",
  enabled: true,
  include: [],
  includeAll: [],
  exclude: [],
  regex: null,
  categoryIds: [M],
  itemIds: IT,
  priceMin: null,
  priceMax: 25_000_000,
  intents: ["sell"],
  attributeFilters: [{ key: "chip", op: "gte", value: "m2" }],
  sourceIds: [],
  notifierIds: [],
  quietHours: null,
  mutedUntil: null,
  createdAt: "2026-10-01T00:00:00Z",
  stats: {
    today: 2,
    last7d: 9,
    daily: [0, 1, 2, 1, 3, 0, 2],
    lastHitAt: new Date(Date.now() - 3_600_000).toISOString(),
    bestDeal: { postId: "p", title: "MacBook Air M2 8/256", priceVnd: 17_900_000, dealPct: -12 },
    routes: ["telegram"],
    routesFallback: false,
  },
};
const NO_ROUTE: WatchDto = { ...BASE, id: W2, name: "Silent", stats: { ...BASE.stats!, routes: [], routesFallback: true, bestDeal: null } };
const FALLBACK: WatchDto = { ...BASE, id: "44444444-4444-4444-8444-444444444444", name: "Everywhere", stats: { ...BASE.stats!, routes: ["telegram"], routesFallback: true, bestDeal: null } };

const ME = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "op@example.com", role: "operator", teamId: "t", telegramChatId: null };
const HUNTER = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", email: "hunter@example.com", role: "hunter", teamId: "t", telegramChatId: "123" };
const USERS = [
  { id: ME.id, email: ME.email, role: "operator", telegramChatId: null },
  { id: HUNTER.id, email: HUNTER.email, role: "hunter", telegramChatId: "123" },
];
const gets: string[] = [];

const calls: { url: string; method: string; body: Record<string, unknown> }[] = [];

function mount(me: Record<string, unknown> = HUNTER, entry = "/watches") {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      if (method !== "GET") calls.push({ url, method, body });
      else gets.push(url);
      if (url === "/api/me") return Promise.resolve(Response.json(me));
      if (url === "/api/members") return Promise.resolve(Response.json({ users: USERS }));
      if (url.startsWith("/api/watches?stats=1")) return Promise.resolve(Response.json({ watches: [BASE, NO_ROUTE, FALLBACK] }));
      if (url === "/api/categories") return Promise.resolve(Response.json({ categories: [{ id: M, parentId: null, slug: "macbook", name: "MacBook", path: "macbook" }] }));
      if (url.startsWith("/api/catalog-items"))
        return Promise.resolve(
          Response.json({ items: [{ id: IT[0], categoryId: M, name: "MacBook Air" }, { id: IT[1], categoryId: M, name: "MacBook Pro" }, { id: IT[2], categoryId: M, name: "Mac mini" }] }),
        );
      if (url === "/api/watches" && method === "POST") return Promise.resolve(Response.json({ ...BASE, id: "33333333-3333-4333-8333-333333333333" }, { status: 201 }));
      return Promise.resolve(Response.json({}));
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        ToastProvider,
        null,
        createElement(
          MemoryRouter,
          { initialEntries: [entry] },
          createElement(
            Routes,
            null,
            createElement(Route, { path: "/watches", element: createElement(Watches) }),
            createElement(Route, { path: "/watches/:id", element: createElement("p", null, "edit page") }),
          ),
        ),
      ),
    ),
  );
}

const confirmSpy = vi.fn(() => true);

beforeEach(() => {
  calls.length = 0;
  gets.length = 0;
  vi.stubGlobal("confirm", confirmSpy);
  confirmSpy.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

async function card(name: string): Promise<HTMLElement> {
  const link = await screen.findByRole("link", { name });
  return link.closest("li") as HTMLElement;
}

async function openMenu(c: HTMLElement, item: string) {
  const trigger = within(c).getByRole("button", { name: /Options/ });
  fireEvent.keyDown(trigger, { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: item }));
}

describe("Watches cards", () => {
  test("summary, best deal, switch PATCH, and No route", async () => {
    mount();
    const c = await card("MacBook M2+");
    expect(await within(c).findByText("Air, Pro, mini · chip ≥ M2 · ≤ 25M · selling")).toBeTruthy();
    expect(within(c).getByText(/−12% vs median/)).toBeTruthy();
    expect(within(c).queryByText("No route")).toBeNull();
    expect(within(c).queryByText("All notifiers")).toBeNull();
    fireEvent.click(within(c).getByRole("switch"));
    await waitFor(() => expect(calls.find((x) => x.method === "PATCH")).toBeTruthy());
    expect(calls.find((x) => x.method === "PATCH")).toMatchObject({ url: `/api/watches/${W1}`, body: { enabled: false } });
    expect(within(await card("Silent")).getByText("No route")).toBeTruthy();
    expect(within(await card("Silent")).queryByText("All notifiers")).toBeNull();
  });

  // card half: fallback watch with an enabled owner notifier says "All notifiers".
  test("a watch with no notifier picked shows All notifiers and its routes, not No route", async () => {
    mount();
    const c = await card("Everywhere");
    expect(within(c).getByText("All notifiers")).toBeTruthy();
    expect(within(c).getByText("Telegram")).toBeTruthy();
    expect(within(c).queryByText("No route")).toBeNull();
  });

  test("Snooze 1 h and until tomorrow PATCH mutedUntil", async () => {
    mount();
    const c = await card("MacBook M2+");
    const before = Date.now();
    await openMenu(c, "Snooze 1 hour");
    await waitFor(() => expect(calls.length).toBe(1));
    const t1 = Date.parse(String(calls[0]?.body.mutedUntil));
    expect(Math.abs(t1 - (before + 3_600_000))).toBeLessThan(5_000);
    await openMenu(c, "Snooze until tomorrow");
    await waitFor(() => expect(calls.length).toBe(2));
    const t2 = new Date(String(calls[1]?.body.mutedUntil));
    expect([t2.getHours(), t2.getMinutes()]).toEqual([7, 0]);
    expect(t2.getTime()).toBeGreaterThan(before);
  });

  test("Duplicate POSTs a disabled copy and opens it", async () => {
    mount();
    await openMenu(await card("MacBook M2+"), "Duplicate");
    await waitFor(() => expect(calls.find((x) => x.method === "POST")).toBeTruthy());
    const post = calls.find((x) => x.method === "POST");
    expect(post?.url).toBe("/api/watches");
    expect(post?.body).toMatchObject({ name: "MacBook M2+ (copy)", enabled: false, itemIds: IT });
    expect(post?.body.id).toBeUndefined();
    expect(await screen.findByText("edit page")).toBeTruthy();
  });

  test("Delete confirms in the card and never calls window.confirm", async () => {
    mount();
    const c = await card("MacBook M2+");
    await openMenu(c, "Delete");
    expect(calls.filter((x) => x.method === "DELETE")).toEqual([]);
    fireEvent.click(within(within(c).getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls.find((x) => x.method === "DELETE")?.url).toBe(`/api/watches/${W1}`));
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});

// page half: 
describe("Watches owner select", () => {
  test("operator: lists team users with Telegram marks; picking one refetches with userId and sets ?owner=", async () => {
    mount(ME);
    const select = (await screen.findByLabelText("Owner")) as HTMLSelectElement;
    await waitFor(() => expect(within(select).getAllByRole("option")).toHaveLength(2));
    expect(within(select).getByRole("option", { name: "hunter@example.com · Telegram" })).toBeTruthy();
    expect(within(select).getByRole("option", { name: "op@example.com" })).toBeTruthy();
    expect(select.value).toBe(ME.id);
    fireEvent.change(select, { target: { value: HUNTER.id } });
    await waitFor(() => expect(gets).toContain(`/api/watches?stats=1&userId=${HUNTER.id}`));
    expect((screen.getByLabelText("Owner") as HTMLSelectElement).value).toBe(HUNTER.id);
    expect(screen.getByRole("link", { name: "New watch" }).getAttribute("href")).toBe(`/watches/new?owner=${HUNTER.id}`);
  });

  test("operator with ?owner= starts on that owner's list", async () => {
    mount(ME, `/watches?owner=${HUNTER.id}`);
    await waitFor(() => expect(gets).toContain(`/api/watches?stats=1&userId=${HUNTER.id}`));
  });

  test("hunter: no owner select", async () => {
    mount(HUNTER);
    await card("MacBook M2+");
    expect(screen.queryByLabelText("Owner")).toBeNull();
  });
});
