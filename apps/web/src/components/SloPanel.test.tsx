import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SloPanel } from "./SloPanel";
import type { OpsSloDto, SourceSloDto } from "@/api/types";


function slo(over: Partial<SourceSloDto> & { sourceId: string; name: string }): SourceSloDto {
  return {
    status: "active",
    coverageOkRatio: null,
    coverageCompleteRatio: null,
    secondsSinceOkVisit: 600,
    visits24h: {},
    ...over,
  };
}

function stub(sources: SourceSloDto[]) {
  const body: OpsSloDto = {
    targets: { coverageOk: 0.98, coverageComplete: 0.95, windowHours: 24 },
    generatedAt: "2026-10-03T00:00:00Z",
    sources,
  };
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json(body))));
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(createElement(QueryClientProvider, { client }, createElement(SloPanel)));
}

describe("SloPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("renders coverage with danger tone, dashes null", async () => {
    stub([
      slo({ sourceId: "s1", name: "S1", coverageOkRatio: 0.97, coverageCompleteRatio: 0.96 }),
      slo({ sourceId: "s2", name: "S2" }),
    ]);
    renderPanel();
    const s1 = (await screen.findByText("S1")).closest("li")!;
    expect(s1.textContent).toContain("Coverage 97% · complete 96%");
    expect(s1.querySelector('[data-tone="danger"]')?.textContent).toContain("Coverage 97%");
    expect(s1.querySelectorAll('[data-tone="danger"]').length).toBe(1);
    const s2 = screen.getByText("S2").closest("li")!;
    expect(s2.textContent).toContain("Coverage –");
    expect(s2.querySelector('[data-tone="danger"]')).toBeNull();
  });

  test("tone agrees with the floored display: 0.976 reads 97% and is danger; 0.984 reads 98% and is not", async () => {
    stub([
      slo({ sourceId: "s1", name: "Low", coverageOkRatio: 0.976, coverageCompleteRatio: 0.99 }),
      slo({ sourceId: "s2", name: "High", coverageOkRatio: 0.984, coverageCompleteRatio: 0.99 }),
    ]);
    renderPanel();
    const low = (await screen.findByText("Low")).closest("li")!;
    expect(low.textContent).toContain("Coverage 97%");
    expect(low.querySelector('[data-tone="danger"]')?.textContent).toContain("Coverage 97%");
    const high = screen.getByText("High").closest("li")!;
    expect(high.textContent).toContain("Coverage 98%");
    expect(high.querySelector('[data-tone="danger"]')).toBeNull();
  });

  test("empty list shows No sources", async () => {
    stub([]);
    renderPanel();
    expect(await screen.findByText("No sources")).toBeTruthy();
  });
});
