import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createQueryClient } from "@/api/query-client";
import { SessionExpiredBanner } from "@/components/SessionExpiredBanner";
import { SessionProvider, useSession } from "@/lib/session";
import { resetSessionExpired } from "@/lib/session-expired";

function Page() {
  useSession();
  return <p>page</p>;
}

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}

const reload = vi.fn();

beforeEach(() => {
  resetSessionExpired();
  reload.mockReset();
  vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, reload } as unknown as Location);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("session expiry wire test ", () => {
  test("opaqueredirect -> banner, no retry, no /403, Reload reloads", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      type: "opaqueredirect",
      status: 0,
      ok: false,
      headers: new Headers(),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    render(
      <QueryClientProvider client={createQueryClient()}>
        <SessionProvider>
          <MemoryRouter initialEntries={["/matches"]}>
            <SessionExpiredBanner />
            <Where />
            <Routes>
              <Route path="/matches" element={<Page />} />
              <Route path="/403" element={<p>forbidden</p>} />
            </Routes>
          </MemoryRouter>
        </SessionProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/me")).toHaveLength(1); // no retry (status probe is separate)
    expect(screen.getByTestId("where").textContent).toBe("/matches");
    await waitFor(() => expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
