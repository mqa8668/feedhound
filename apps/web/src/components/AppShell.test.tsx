import { act, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, test, vi } from "vitest";
import { routes } from "@/router";

vi.mock("@/api/ws", () => ({
  LiveProvider: ({ children }: { children: React.ReactNode }) => children,
  useLive: () => ({ status: "open" }),
}));
vi.mock("@/api/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/queries")>()),
  useUnseenMatches: () => ({ data: 2 }),
}));
vi.mock("@/lib/session", () => ({
  useSession: () => ({ me: { email: "o@x.io", role: "operator" }, isLoading: false, error: null }),
  isOperator: () => true,
}));
vi.mock("@/pages/Watches", () => ({ default: () => <p>watches page</p> }));
vi.mock("@/pages/Matches", () => ({ default: () => <p>matches page</p> }));

afterEach(() => {
  document.title = "";
});

describe("AppShell title + brand ", () => {
  test("document.title follows the route and carries the unread count", async () => {
    const router = createMemoryRouter(routes, { initialEntries: ["/watches"] });
    render(<RouterProvider router={router} />);
    expect(document.title).toBe("(2) Watches · Feedhound");
    await act(async () => {
      await router.navigate("/matches");
    });
    expect(document.title).toBe("(2) Matches · Feedhound");
    expect(screen.getAllByTestId("logo-mark").length).toBeGreaterThan(0);
  });
});
