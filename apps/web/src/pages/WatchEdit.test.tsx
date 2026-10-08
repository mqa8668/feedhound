import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import WatchEdit from "./WatchEdit";
import { ToastProvider } from "@/components/ui/toast";


// WatchEdit half: a draft in router state seeds the new-watch form; an invalid draft is ignored.
const DRAFT = {
  name: "Hyundai Santafe 2019",
  include: ["hyundai", "santafe"],
  categoryIds: [] as string[],
  attributeFilters: [{ key: "year", op: "gte", value: 2018 }],
  priceMin: 578_000_000,
  priceMax: 782_000_000,
  intents: ["sell"],
};

const posts: string[] = [];
const bodies: { url: string; body: Record<string, unknown> }[] = [];
const patches: { url: string; body: Record<string, unknown> }[] = [];
type Handler = (url: string, body: Record<string, unknown>) => Promise<Response> | undefined;
let extra: Handler = () => undefined;

const L = "00000000-0000-4000-8000-0000000000a1";
const M = "00000000-0000-4000-8000-0000000000a2";
const IT = ["00000000-0000-4000-8000-0000000000b1", "00000000-0000-4000-8000-0000000000b2", "00000000-0000-4000-8000-0000000000b3"];
let categoriesBody: unknown[] = [];
const CATS = [
  { id: L, parentId: null, slug: "laptops", name: "Laptops", path: "laptops" },
  { id: M, parentId: L, slug: "macbook", name: "MacBook", path: "laptops/macbook", attributeSchema: [{ key: "chip", label: "Chip", kind: "ordered", values: ["m1", "m2", "m3"] }] },
];
const ITEMS = [
  { id: IT[0], categoryId: M, name: "MacBook Air" },
  { id: IT[1], categoryId: M, name: "MacBook Pro" },
  { id: IT[2], categoryId: M, name: "Mac mini" },
];
const PREVIEW = { count: 0, total: 0, daily: [0, 0, 0, 0, 0, 0, 0], truncated: false, posts: [] };

function mount(state: unknown, entry = "/watches/new") {
  posts.length = 0;
  bodies.length = 0;
  patches.length = 0;
  const [pathname = "/watches/new", search = ""] = entry.split("?");
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      if (method === "PATCH") patches.push({ url, body });
      if (method === "POST") {
        posts.push(url);
        bodies.push({ url, body });
      }
      const custom = extra(url, body);
      if (custom) return custom;
      if (url === "/api/categories") return Promise.resolve(Response.json({ categories: categoriesBody }));
      if (url === "/api/sources") return Promise.resolve(Response.json({ sources: [] }));
      if (url.startsWith("/api/catalog-items")) return Promise.resolve(Response.json({ items: ITEMS }));
      if (url.startsWith("/api/watches/test")) return Promise.resolve(Response.json(PREVIEW));
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
          { initialEntries: [{ pathname, search: search ? `?${search}` : "", state }] },
          createElement(Routes, null, createElement(Route, { path: "/watches/:id", element: createElement(WatchEdit) })),
        ),
      ),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  extra = () => undefined;
  categoriesBody = [];
});

describe("WatchEdit draft from a listing card", () => {
  test("shows the draft's name and price band and posts nothing", async () => {
    mount({ draft: DRAFT });
    const name = (await screen.findByLabelText("Name")) as HTMLInputElement;
    await waitFor(() => expect(name.value).toBe("Hyundai Santafe 2019"));
    expect((screen.getByLabelText("Price min (VND)") as HTMLInputElement).value).toBe("578000000");
    expect((screen.getByLabelText("Price max (VND)") as HTMLInputElement).value).toBe("782000000");
    expect(posts).toEqual([]);
  });

  test("an invalid draft is ignored", async () => {
    mount({ draft: { name: 42 } });
    const name = (await screen.findByLabelText("Name")) as HTMLInputElement;
    expect(name.value).toBe("");
  });

  test("no router state leaves the form empty", async () => {
    mount(undefined);
    const name = (await screen.findByLabelText("Name")) as HTMLInputElement;
    expect(name.value).toBe("");
  });
});

const PARSED = {
  draft: {
    name: "MacBook Air/Pro/mini M2+",
    include: [],
    includeAll: [],
    exclude: [],
    categoryIds: [M],
    itemIds: IT,
    intents: ["sell"],
    priceMax: 25_000_000,
    attributeFilters: [{ key: "chip", op: "gte", value: "m2" }],
  },
  warnings: [],
  suggestions: { aliases: [], exclude: [], priceRange: null },
};

const SEED = { draft: { name: "Seed", include: ["macbook"], categoryIds: [] as string[], attributeFilters: [], intents: [] as string[] } };
const previewPosts = () => posts.filter((u) => u.startsWith("/api/watches/test"));

describe("live preview", () => {
  test("5 edits inside the debounce send one request; no 24h test button", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount(SEED);
    const min = (await screen.findByLabelText("Price min (VND)")) as HTMLInputElement;
    for (const v of ["1", "12", "123", "1234", "12345"]) fireEvent.change(min, { target: { value: v } });
    expect(screen.queryByRole("button", { name: /Test on last 24 h/i })).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    await waitFor(() => expect(previewPosts().length).toBe(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(previewPosts()).toEqual(["/api/watches/test?hours=168"]);
    expect(bodies.find((b) => b.url.startsWith("/api/watches/test"))?.body.priceMin).toBe(12345);
  });

  test("a slower earlier response arriving last is not rendered", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const resolvers: ((r: Response) => void)[] = [];
    extra = (url) => (url.startsWith("/api/watches/test") ? new Promise<Response>((res) => resolvers.push(res)) : undefined);
    mount(SEED);
    const min = (await screen.findByLabelText("Price min (VND)")) as HTMLInputElement;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    await waitFor(() => expect(resolvers.length).toBe(1));
    fireEvent.change(min, { target: { value: "5000000" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    await waitFor(() => expect(resolvers.length).toBe(2));
    await act(async () => {
      resolvers[1]?.(Response.json({ ...PREVIEW, total: 7, count: 7 }));
      await vi.advanceTimersByTimeAsync(10);
    });
    await screen.findByText("7");
    await act(async () => {
      resolvers[0]?.(Response.json({ ...PREVIEW, total: 3, count: 3 }));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.queryByText("3")).toBeNull();
    expect(screen.getByText("7")).toBeTruthy();
  });

  test("matched terms are marked accent-insensitively and markup renders as text", async () => {
    const post = (id: string, title: string, terms: string[]) => ({ id, title, sourceId: "s", firstSeenAt: "2026-10-04T00:00:00Z", url: "https://x/" + id, matchedTerms: terms, priceVnd: 17_900_000 });
    extra = (url) =>
      url.startsWith("/api/watches/test")
        ? Promise.resolve(Response.json({ ...PREVIEW, total: 2, count: 2, posts: [post("1", "Bán máy MacBook", ["may"]), post("2", "<img src=x onerror=alert(1)> macbook", ["macbook"])] }))
        : undefined;
    const { container } = mount(SEED);
    const marks = await screen.findAllByText("máy", { selector: "mark" });
    expect(marks).toHaveLength(1);
    expect(screen.getByText(/<img src=x/)).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getAllByText("17.9M").length).toBe(2);
  });
});

describe("builder", () => {
  test("parse, edit chips, pick from the tree, save once", async () => {
    categoriesBody = CATS;
    extra = (url) => (url === "/api/watches/parse" ? Promise.resolve(Response.json(PARSED)) : undefined);
    mount({ draft: { name: "", include: [], categoryIds: [], attributeFilters: [], intents: [] } });
    fireEvent.change(await screen.findByLabelText("Describe what you are hunting"), { target: { value: "macbook air/pro chip m2 trở lên dưới 25tr, bán" } });
    fireEvent.click(screen.getByRole("button", { name: /Parse/ }));
    expect(await screen.findByText("Chip ≥ M2")).toBeTruthy();
    expect(screen.getByText("Price ≤ 25M")).toBeTruthy();
    // Advanced stays collapsed for this draft.
    expect(screen.queryByLabelText("Must contain all of")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove Intent: sell" }));
    fireEvent.change(screen.getByLabelText("Search categories"), { target: { value: "mac" } });
    const laptops = (await screen.findByText("Laptops")).closest("li");
    expect(laptops).not.toBeNull();
    expect(within(laptops as HTMLElement).getByText("MacBook")).toBeTruthy();
    expect(posts.filter((u) => u === "/api/watches")).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posts.filter((u) => u === "/api/watches")).toHaveLength(1));
    const saved = bodies.find((b) => b.url === "/api/watches")?.body;
    expect(saved?.intents).toEqual([]);
    expect(saved?.priceMax).toBe(25_000_000);
    expect(saved?.categoryIds).toEqual([M]);
  });

  test("a parse failure is non-blocking", async () => {
    extra = (url) => (url === "/api/watches/parse" ? Promise.resolve(Response.json({ error: "llm_unavailable" }, { status: 503 })) : undefined);
    mount(undefined);
    fireEvent.change(await screen.findByLabelText("Describe what you are hunting"), { target: { value: "macbook" } });
    fireEvent.click(screen.getByRole("button", { name: /Parse/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("fill the form in");
    expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(false);
  });

  test("Advanced opens for a draft keeping only keywords or includeAll", async () => {
    mount({ draft: { name: "kw", include: ["abc"], categoryIds: [], attributeFilters: [], intents: [] } });
    expect(await screen.findByLabelText("Include (any)")).toBeTruthy();
  });
});

describe("templates", () => {
  test("MacBook M-series prefills macbook, chip gte m2, sell and posts nothing", async () => {
    categoriesBody = CATS;
    mount(undefined);
    await screen.findByText("Laptops");
    fireEvent.click(await screen.findByRole("button", { name: /MacBook M-series/ }));
    expect(await screen.findByText("Chip ≥ M2")).toBeTruthy();
    expect(screen.getByText("Line: MacBook")).toBeTruthy();
    expect(screen.getByText("Intent: sell")).toBeTruthy();
    expect(posts.filter((u) => u === "/api/watches")).toEqual([]);
  });

  test("Espresso machines prefills include terms without a category when the slug is missing", async () => {
    categoriesBody = CATS;
    mount(undefined);
    await screen.findByText("Laptops");
    fireEvent.click(await screen.findByRole("button", { name: /Espresso machines/ }));
    expect(await screen.findByText("espresso")).toBeTruthy();
    expect(screen.getByText("máy pha cà phê")).toBeTruthy();
    expect(screen.queryByText(/^Line:/)).toBeNull();
  });
});

// owner picker and owner select in the form
const N1 = "00000000-0000-4000-8000-0000000000c1";
const N2 = "00000000-0000-4000-8000-0000000000c2";
const OP = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "op@example.com", role: "operator", teamId: "t", telegramChatId: null };
const HU = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", email: "hunter@example.com", role: "hunter", teamId: "t", telegramChatId: "123" };
const TEAM = [
  { id: OP.id, email: OP.email, role: "operator", telegramChatId: null },
  { id: HU.id, email: HU.email, role: "hunter", telegramChatId: "123" },
];
const NOTIFIERS = [
  { id: N1, kind: "telegram", enabled: true },
  { id: N2, kind: "telegram", enabled: false },
];
const notifierUrls: string[] = [];
const WATCH = {
  id: "99999999-9999-4999-8999-999999999999",
  userId: HU.id,
  name: "Hunter's watch",
  enabled: true,
  include: ["macbook"],
  includeAll: [],
  exclude: [],
  regex: null,
  categoryIds: [],
  itemIds: [],
  priceMin: null,
  priceMax: null,
  intents: [],
  attributeFilters: [],
  sourceIds: [],
  notifierIds: [N1],
  quietHours: null,
  mutedUntil: null,
  createdAt: "2026-10-01T00:00:00Z",
};

function operatorHandlers(): Handler {
  return (url) => {
    if (url === "/api/me") return Promise.resolve(Response.json(OP));
    if (url === "/api/members") return Promise.resolve(Response.json({ users: TEAM }));
    if (url.startsWith("/api/notifiers")) {
      notifierUrls.push(url);
      return Promise.resolve(Response.json({ notifiers: NOTIFIERS }));
    }
    if (url === `/api/watches/${WATCH.id}`) return Promise.resolve(Response.json(WATCH));
    return undefined;
  };
}

describe("notifier picker", () => {
  test("one checkbox per notifier, the off one disabled, None picked helper counts enabled, save sends the pick", async () => {
    extra = (url) => (url.startsWith("/api/notifiers") ? Promise.resolve(Response.json({ notifiers: NOTIFIERS })) : undefined);
    mount(SEED);
    const telegram = (await screen.findByRole("checkbox", { name: "Telegram" })) as HTMLInputElement;
    const offNotifier = screen.getByRole("checkbox", { name: "Telegram (off)" }) as HTMLInputElement;
    expect(offNotifier.disabled).toBe(true);
    expect(telegram.disabled).toBe(false);
    expect(screen.getByText("None picked: sends to all enabled notifiers of you (1)")).toBeTruthy();
    fireEvent.click(telegram);
    expect(screen.queryByText(/None picked/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posts.filter((u) => u === "/api/watches")).toHaveLength(1));
    expect(bodies.find((b) => b.url === "/api/watches")?.body.notifierIds).toEqual([N1]);
  });

  test("an owner with no enabled notifier gets the warning", async () => {
    extra = (url) => (url.startsWith("/api/notifiers") ? Promise.resolve(Response.json({ notifiers: [{ id: N2, kind: "telegram", enabled: false }] })) : undefined);
    mount(SEED);
    expect(await screen.findByText("No enabled notifier: matches will not be sent")).toBeTruthy();
  });
});

describe("owner select in the watch form", () => {
  test("operator creating with ?owner= lists that owner's notifiers and posts userId", async () => {
    notifierUrls.length = 0;
    extra = operatorHandlers();
    mount(SEED, `/watches/new?owner=${HU.id}`);
    const select = (await screen.findByLabelText("Owner")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(HU.id));
    await screen.findByRole("checkbox", { name: "Telegram" });
    expect(notifierUrls).toContain(`/api/notifiers?userId=${HU.id}`);
    expect(screen.getByText("None picked: sends to all enabled notifiers of hunter@example.com (1)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posts.filter((u) => u === "/api/watches")).toHaveLength(1));
    expect(bodies.find((b) => b.url === "/api/watches")?.body.userId).toBe(HU.id);
  });

  test("changing the owner on edit warns and PATCHes userId with notifierIds []", async () => {
    extra = operatorHandlers();
    mount(undefined, `/watches/${WATCH.id}`);
    const select = (await screen.findByLabelText("Owner")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(HU.id));
    expect(screen.queryByText(/Moving resets/)).toBeNull();
    fireEvent.change(select, { target: { value: OP.id } });
    expect(await screen.findByText("Moving resets the notifier picks to the new owner's defaults")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]?.url).toBe(`/api/watches/${WATCH.id}`);
    expect(patches[0]?.body).toMatchObject({ userId: OP.id, notifierIds: [] });
  });

  test("switching the owner away and back restores the original notifier picks", async () => {
    extra = operatorHandlers();
    mount(undefined, `/watches/${WATCH.id}`);
    const select = (await screen.findByLabelText("Owner")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(HU.id));
    fireEvent.change(select, { target: { value: OP.id } });
    fireEvent.change(select, { target: { value: HU.id } });
    await waitFor(() => expect(screen.queryByText(/Moving resets/)).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]?.body).toMatchObject({ notifierIds: [N1] });
  });

  test("a hunter sees no owner select", async () => {
    extra = (url) => (url === "/api/me" ? Promise.resolve(Response.json(HU)) : undefined);
    mount(SEED);
    await screen.findByLabelText("Name");
    expect(screen.queryByLabelText("Owner")).toBeNull();
  });
});
