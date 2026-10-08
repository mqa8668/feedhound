import { act, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, type RouteObject } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AppShell } from "@/components/AppShell";
import RouteError from "@/pages/RouteError";
import { routes } from "@/router";

let shellThrows = false;

vi.mock("@/api/ws", () => ({
  LiveProvider: ({ children }: { children: React.ReactNode }) => children,
  useLive: () => ({ status: "open" }),
}));
vi.mock("@/api/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/queries")>()),
  useInsightsUnread: () => ({ data: 0 }),
  useUnseenMatches: () => {
    if (shellThrows) throw new Error("shell boom");
    return { data: 0 };
  },
}));
vi.mock("@/lib/session", () => ({
  useSession: () => ({ me: { email: "o@x.io", role: "operator" }, isLoading: false, error: null }),
  isOperator: () => true,
}));

function Boom(): never {
  throw new Error("page boom");
}

beforeEach(() => {
  shellThrows = false;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("NotFound + error boundaries", () => {
  test("Unknown path renders inside the shell", () => {
    const router = createMemoryRouter(routes, { initialEntries: ["/nope"] });
    render(<RouterProvider router={router} />);
    expect(screen.getByRole("heading", { name: "Page not found" })).toBeTruthy();
    expect(screen.getAllByRole("navigation", { name: "Primary" }).length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Back to Overview" }).getAttribute("href")).toBe("/");
    expect(screen.queryByText(/Unexpected Application Error/)).toBeNull();
  });

  test("A crashed page recovers after navigating", async () => {
    const tree: RouteObject[] = [
      {
        path: "/",
        element: <AppShell />,
        errorElement: <RouteError />,
        children: [
          { path: "boom", element: <Boom /> },
          { path: "ok", element: <p>ok page</p> },
        ],
      },
    ];
    const router = createMemoryRouter(tree, { initialEntries: ["/boom"] });
    render(<RouterProvider router={router} />);
    expect(screen.getByText("page boom")).toBeTruthy();
    await act(async () => {
      await router.navigate("/ok");
    });
    expect(screen.getByText("ok page")).toBeTruthy();
  });

  test("An AppShell-level throw shows RouteError, not the RR default", () => {
    shellThrows = true;
    const router = createMemoryRouter(routes, { initialEntries: ["/health"] });
    render(<RouterProvider router={router} />);
    expect(screen.getByText("Something went wrong")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(screen.queryByText(/Unexpected Application Error/)).toBeNull();
  });
});
