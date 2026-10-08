import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { EditSourceDialog } from "./EditSourceDialog";
import type { SourceDto } from "@/api/types";

// Web sources have no ingest-key control and PATCH only id + schedule.
const SCHEDULE = { visitEverySec: { min: 60, max: 120 } };
const src = (kind: string): SourceDto =>
  ({ id: "s1", name: "Src", url: "https://x/s", kind, status: "active", assignedKeyId: null, schedule: SCHEDULE, health: {} }) as unknown as SourceDto;

let patchUrl = "";
let patchBody: Record<string, unknown> | null = null;

function mount(kind: string) {
  patchBody = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
      if (init?.method === "PATCH") {
        patchUrl = url;
        patchBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return json({});
      }
      if (url.includes("/keys")) return json({ keys: [] });
      return json({});
    }),
  );
  render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(EditSourceDialog, { source: src(kind), onClose: () => {} })));
}

afterEach(() => vi.unstubAllGlobals());

describe("EditSourceDialog", () => {
  test("web source: no key control; PATCH /sources/s1 body is exactly {schedule} (id travels in the path)", async () => {
    mount("web");
    expect(screen.queryByText("Assigned ingest key")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patchBody).not.toBeNull());
    expect(Object.keys(patchBody ?? {}).sort()).toEqual(["schedule"]);
    expect(patchUrl).toMatch(/\/sources\/s1$/);
  });

  test("push: key control present and body carries assignedKeyId", async () => {
    mount("push");
    expect(screen.getByText("Assigned ingest key")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patchBody).not.toBeNull());
    expect(Object.keys(patchBody ?? {})).toContain("assignedKeyId");
  });
});
