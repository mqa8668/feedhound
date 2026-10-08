import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SourceTree } from "./SourceTree";
import { SourceLeafRow } from "./SourceLeafRow";
import type { SourceLeaf } from "@feedhound/core/source-classify";
import type { SourceDto } from "@/api/types";
import { SessionProvider } from "@/lib/session";

// UI: tree, relevance %, insufficient hint, role-gated actions, no flat table.
const rollup = { sources: 1, health: { ok: 1, degraded: 0, down: 0, paused: 0, unknown: 0, stale: 0 }, worst: "ok", coverageOk: 1, coverageComplete: 1, maxSecondsSinceOkVisit: 10, posts7d: 10, matched7d: 3, relevance7d: 0.3 };
const eff = (key: string, label: string, method: string) => ({ key, label, method, share: null });
const leaf = (id: string, name: string, method: string, sampleN: number, relevance: { posts: number; matched: number; share: number | null }) => ({
  id, name, url: `https://x/${id}`, kind: "web", status: "active", health: "ok", coverageOk: 1, coverageComplete: 1, secondsSinceOkVisit: 10,
  relevance7d: relevance, topic: { ...eff("cars", "Cars", method), categoryId: null }, region: eff("hcm", "HCM", "auto"), sampleN, classifiedAt: null,
  override: { topicCategoryId: null, region: null },
});
const tree = {
  minPosts: 20, regionOptions: ["hcm"],
  rollup, generatedAt: "2026-10-05T00:00:00Z",
  platforms: [{ key: "web", label: "Web", rollup, topics: [{ key: "cars", categoryId: null, label: "Cars", rollup, regions: [{ key: "hcm", label: "HCM", rollup, sources: [
    leaf("a", "Src A", "auto", 40, { posts: 10, matched: 3, share: 0.3 }),
    leaf("b", "Src B", "insufficient", 7, { posts: 0, matched: 0, share: null }),
  ] }] }] }],
};

let paused = false;
afterEach(() => {
  paused = false;
  vi.unstubAllGlobals();
});

function renderAs(role: string, treeBody: unknown = tree) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
      if (url.endsWith("/api/me")) return json({ id: "u", email: "a@b.c", role });
      if (url.endsWith("/source-groups/tree")) return new Response(paused ? JSON.stringify(treeBody).replaceAll('"status":"active"', '"status":"paused"') : JSON.stringify(treeBody), { status: 200, headers: { "content-type": "application/json" } });
      if (url.endsWith("/pause") || url.endsWith("/resume")) {
        paused = url.endsWith("/pause");
        return json({});
      }
      if (url.endsWith("/sources")) return json({ sources: [] });
      return json({ keys: [], categories: [] });
    }),
  );
  render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(SessionProvider, null, createElement(SourceTree))));
}

describe("SourceTree", () => {
  test("operator sees tree, 30%, insufficient hint, actions; no table", async () => {
    renderAs("operator");
    expect(await screen.findByText("30%")).toBeTruthy();
    expect(screen.getByText("Insufficient data (7/20)")).toBeTruthy();
    expect(screen.getByText("Cars")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Override group" }).length).toBe(2);
    expect(screen.getAllByRole("button", { name: "Pause" }).length).toBe(2);
    expect(screen.getByRole("button", { name: "Reclassify" })).toBeTruthy();
    expect(document.querySelector("table")).toBeNull();
  });

  test("hunter has no Override or Pause", async () => {
    renderAs("hunter");
    expect(await screen.findByText("30%")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Override group" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
  });

  test("Pause refreshes the tree: label flips to Resume", async () => {
    renderAs("operator");
    const [pause] = await screen.findAllByRole("button", { name: "Pause" });
    fireEvent.click(pause!);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Resume" }).length).toBe(2));
  });

  test("regions start collapsed when a topic has more than 5 regions", async () => {
    const regions = Array.from({ length: 6 }, (_, i) => ({ key: `r${i}`, label: `Region ${i}`, rollup, sources: [leaf(`s${i}`, `Src ${i}`, "auto", 40, { posts: 1, matched: 1, share: 1 })] }));
    const big = { ...tree, platforms: [{ ...tree.platforms[0]!, topics: [{ ...tree.platforms[0]!.topics[0]!, regions }] }] };
    renderAs("operator", big);
    expect(await screen.findByText("Region 0")).toBeTruthy();
    expect(screen.queryByText("Src 0")).toBeNull();
  });

  test("Parent shows stale count, ok worst", async () => {
    const staleRollup = { ...rollup, sources: 3, health: { ok: 1, degraded: 0, down: 0, paused: 0, unknown: 0, stale: 2 } };
    const staleTree = { ...tree, rollup: staleRollup, platforms: [{ ...tree.platforms[0]!, rollup: staleRollup }] };
    renderAs("operator", staleTree);
    expect((await screen.findAllByText("2 stale")).length).toBeGreaterThan(0);
  });
});

describe("SourceLeafRow key badge", () => {
  const detail = (kind: string): SourceDto => ({
    id: "a", name: "A", url: "https://x/a", kind, status: "active", assignedKeyId: null, schedule: null, health: { lastVisitAt: null, postsLastHour: 0 },
  } as unknown as SourceDto);
  const row = (kind: string) =>
    render(
      createElement(SourceLeafRow, {
        leaf: leaf("a", "Src A", "auto", 40, { posts: 10, matched: 3, share: 0.3 }) as unknown as SourceLeaf,
        minPosts: 20, detail: detail(kind), keys: [], keysError: false, operator: false, onEdit: () => {}, onToggle: () => {}, onOverride: () => {},
      }),
    );
  test("web source shows Server poll, not No key assigned", () => {
    row("web");
    expect(screen.getByText("Server poll")).toBeTruthy();
    expect(screen.queryByText("No key assigned")).toBeNull();
  });
  test("push source with null key shows No key assigned", () => {
    row("push");
    expect(screen.getByText("No key assigned")).toBeTruthy();
  });
});
