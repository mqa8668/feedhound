import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SourceHealthCards } from "./SourceHealthCards";
import type { SourceDto } from "@/api/types";

// UI half: an ok:null (never visited) source renders the neutral
// "Not visited yet" state, not "degraded"; ok:false + reason stays "degraded".

function source(id: string, name: string, health: SourceDto["health"]): SourceDto {
  return {
    id,
    name,
    url: `https://feeds.example.test/${id}`,
    kind: "web",
    status: "active",
    assignedKeyId: null,
    schedule: null,
    health,
  };
}

const sources: SourceDto[] = [
  source("s1", "Never visited group", { ok: null, lastVisitAt: null, reason: null, pausedAt: null, lastOkVisitAt: null, coveragePct: null }),
  source("s2", "Degraded group", {
    ok: false,
    lastVisitAt: "2026-09-20T10:00:00Z",
    reason: "visit failed twice",
    pausedAt: null,
    lastOkVisitAt: "2026-09-19T10:00:00Z",
    coveragePct: 80,
  }),
];

function renderCards() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(createElement(QueryClientProvider, { client }, createElement(SourceHealthCards)));
}

describe("SourceHealthCards neutral state", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({ sources }))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("ok:null renders neutral 'Not visited yet', not degraded", async () => {
    renderCards();
    const neutral = await screen.findByText(/Not visited yet/);
    const item = neutral.closest("li")!;
    expect(item.textContent).not.toContain("degraded");
    // Neutral dot (unknown tone falls back to muted), no warning dot.
    expect(item.querySelector(".bg-warning")).toBeNull();
    expect(item.querySelector(".bg-muted-foreground")).not.toBeNull();
  });

  test("ok:false + reason still renders degraded", async () => {
    renderCards();
    await screen.findByText(/Not visited yet/);
    const degraded = screen.getByText("Degraded group").closest("li")!;
    expect(degraded.querySelector('[title="degraded"]')).not.toBeNull();
    expect(screen.getByText("visit failed twice")).toBeTruthy();
  });
});

// Coverage % + last ok visit line, and paused_by_health degraded tone.
describe("SourceHealthCards coverage + last ok visit", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({ sources }))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("shows Coverage n% and last ok relative time when set", async () => {
    renderCards();
    const item = (await screen.findByText("Degraded group")).closest("li")!;
    expect(item.textContent).toContain("Coverage 80%");
    expect(item.textContent).toContain("last ok");
  });

  test("shows Coverage – and last ok never when coveragePct/lastOkVisitAt are null", async () => {
    renderCards();
    const item = (await screen.findByText("Never visited group")).closest("li")!;
    expect(item.textContent).toContain("Coverage –");
    expect(item.textContent).toContain("last ok never");
  });

  test("paused_by_health source renders degraded tone", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const pausedByHealth: SourceDto[] = [
      source("s3", "Paused by health group", {
        ok: false,
        lastVisitAt: "2026-09-20T10:00:00Z",
        reason: "watchdog gap",
        pausedAt: "2026-09-20T10:05:00Z",
        lastOkVisitAt: "2026-09-19T10:00:00Z",
        coveragePct: 40,
      }),
    ];
    pausedByHealth[0]!.status = "paused_by_health";
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({ sources: pausedByHealth }))));
    render(createElement(QueryClientProvider, { client }, createElement(SourceHealthCards)));
    const item = (await screen.findByText("Paused by health group")).closest("li")!;
    expect(item.querySelector('[title="degraded"]')).not.toBeNull();
  });
});
