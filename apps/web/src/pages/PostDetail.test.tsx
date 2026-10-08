import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import PostDetail from "./PostDetail";
import type { PostDetailDto } from "@/api/types";
import type { DecisionDto } from "@/api/decision";

// PostDetail rendered against a mocked PostDetailDto. Fetch is mocked.

const detail: PostDetailDto = {
  post: {
    id: "p1",
    sourceId: "s1",
    platformPostId: "123",
    url: "https://feeds.example.test/g/posts/123",
    authorName: "Member #a3f2c1d0",
    authorRef: "a3f2c1d0",
    title: "Selling a bike",
    text: "Line one\nLine two <b>not html</b>",
    media: [{ type: "image", url: "https://cdn.test/a.jpg" }, { type: "image", url: "javascript:alert(1)" }, { nope: true }, 42],
    engagement: {},
    postedAt: "2026-09-20T10:00:00Z",
    firstSeenAt: "2026-09-20T10:05:00Z",
    lastSeenAt: "2026-09-21T10:05:00Z",
    editCount: 1,
    capture: "api",
    fingerprint: "fp",
  },
  source: { id: "s1", name: "Bike Group", kind: "web", url: "https://feeds.example.test/g" },
  revisions: [{ id: "r1", seenAt: "2026-09-20T12:00:00Z", text: "Old text", engagement: {} }],
  enrichment: {
    revision: 1,
    intent: "sell",
    priceVnd: 5000000,
    priceRaw: "5tr",
    condition: "used",
    confidence: 0.9,
    sentiment: "neg",
    intentTags: ["complain"],
    engine: "rule",
    model: null,
    updatedAt: "2026-09-20T10:06:00Z",
    category: { id: "c1", name: "Bikes", path: "bikes" },
    item: { id: "i1", name: "Giant ATX" },
  },
  matches: [{ id: "m1", watchId: "w-123", watchName: "Bike watch", score: 0.8, matchedTerms: ["bike"], createdAt: "2026-09-20T10:07:00Z" }],
  duplicates: [{ id: "p2", sourceId: "s2", sourceName: "Other Group", url: "https://example.com/x", firstSeenAt: "2026-09-20T11:00:00Z" }],
  pipeline: { enrichState: "done", matchState: "done", pipelineVersion: 3 },
};

function stubFetch(opts: { role: "operator" | "hunter"; status?: number; body?: PostDetailDto; decision?: DecisionDto }) {
  const hunterBody = opts.body ? { ...opts.body, post: { ...opts.body.post }, pipeline: undefined } : undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/me") return Promise.resolve(Response.json({ id: "u", email: "u@x.test", role: opts.role, teamId: "t", telegramChatId: null }));
      if (url.endsWith("/decision")) return Promise.resolve(opts.decision ? Response.json(opts.decision) : Response.json({ error: "not_found" }, { status: 404 }));
      if (url.startsWith("/api/posts/")) {
        if (opts.status === 404) return Promise.resolve(Response.json({ error: "not_found" }, { status: 404 }));
        return Promise.resolve(Response.json(opts.role === "operator" ? opts.body : hunterBody));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }),
  );
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(MemoryRouter, { initialEntries: ["/posts/p1"] }, createElement(Routes, null, createElement(Route, { path: "/posts/:id", element: createElement(PostDetail) }))),
    ),
  );
}

describe("PostDetail", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("renders text, revisions, enrichment, matches link, duplicates, one valid image, member link, no raw JSON", async () => {
    stubFetch({ role: "operator", body: detail });
    const { container } = renderPage();
    await screen.findByText("Selling a bike");
    expect(screen.getByText(/Line one/).textContent).toContain("<b>not html</b>"); // plain text, never HTML
    expect(screen.getByText("Edit history (1)")).toBeTruthy();
    expect(screen.getByText("Old text")).toBeTruthy();
    expect(screen.getByText("Bikes")).toBeTruthy();
    expect(screen.getByText("Giant ATX")).toBeTruthy();
    expect(screen.getByTestId("enrichment-tags").textContent).toContain("neg");
    expect(screen.getByTestId("enrichment-tags").textContent).toContain("complain");
    expect(screen.getByRole("link", { name: "Bike watch" }).getAttribute("href")).toBe("/watches/w-123");
    expect(screen.getByRole("link", { name: "Other Group" }).getAttribute("href")).toBe("/posts/p2");
    const imgs = container.querySelectorAll("img");
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.getAttribute("src")).toBe("https://cdn.test/a.jpg");
    expect(imgs[0]!.getAttribute("loading")).toBe("lazy");
    expect(screen.getByText(/Member #a3f2c1d0/)).toBeTruthy();
    expect(screen.queryByText("Show raw JSON")).toBeNull();
  });

  test("raw block is hidden for hunters", async () => {
    stubFetch({ role: "hunter", body: detail });
    renderPage();
    await screen.findByText("Selling a bike");
    expect(screen.queryByText("Show raw JSON")).toBeNull();
  });

  test("404 shows 'Post not found'", async () => {
    stubFetch({ role: "hunter", status: 404 });
    renderPage();
    expect(await screen.findByText("Post not found")).toBeTruthy();
  });

  test.each([
    ["floor", null, "> 200M"],
    ["ceiling", null, "< 200M"],
    ["approx", null, "~200M"],
    ["range", 250_000_000, "200–250M"],
    ["exact", null, "200M"],
  ])("price qualifier %s renders %s", async (qualifier, max, text) => {
    const body = { ...detail, enrichment: { ...detail.enrichment!, priceVnd: 200_000_000, priceQualifier: qualifier as never, priceMaxVnd: max } };
    stubFetch({ role: "hunter", body });
    renderPage();
    expect(await screen.findByText(text)).toBeTruthy();
  });

  test("shows the verdict, specs block, comparables and fit list", async () => {
    const decision: DecisionDto = {
      postId: "p1",
      capabilities: { listing: false, dealV2: false, risk: false, seller: false },
      price: { vnd: 185_000_000, qualifier: "exact", suspect: false },
      verdict: { text: "9% cheaper than 13 comparable cars", pct: -9.2, n: 13, medianVnd: 203_000_000, confidence: null },
      specs: [{ key: "year", label: "Year", value: "2012" }],
      comparables: [{ postId: "c1", title: "Morning 2013", url: "u", sourceName: "G", priceVnd: 190_000_000, deltaPct: 2.7, year: 2013, odoKm: 60000, region: null, at: "2026-10-01T00:00:00Z" }],
      distribution: null,
      percentile: null,
      fit: [{ watchId: "w1", watchName: "Morning", items: [{ label: "Price ≤ 200M", status: "ok" }] }],
      seller: { label: "Member #abc", sellPosts90: 2, repostCount: 0 },
    };
    stubFetch({ role: "hunter", body: detail, decision });
    renderPage();
    expect(await screen.findByText("9% cheaper than 13 comparable cars")).toBeTruthy();
    expect(screen.getByText("2012")).toBeTruthy();
    expect(document.querySelector("[data-comparable='c1']")).not.toBeNull();
    expect(screen.getByText("Price ≤ 200M")).toBeTruthy();
  });

  test("the open-original link uses the web platform label", async () => {
    stubFetch({ role: "operator", body: detail });
    renderPage();
    await screen.findByText("Selling a bike");
    expect(screen.getByRole("link", { name: /Open original/ })).toBeTruthy();
  });
});
