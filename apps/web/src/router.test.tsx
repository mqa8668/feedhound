import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { describe, expect, test, vi } from "vitest";
import { routes } from "@/router";

vi.mock("@/api/ws", () => ({
  LiveProvider: ({ children }: { children: React.ReactNode }) => children,
  useLive: () => ({ status: "open" }),
}));
vi.mock("@/api/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/queries")>()),
  useUnseenMatches: () => ({ data: 0 }),
}));
vi.mock("@/lib/session", () => ({
  useSession: () => ({ me: { email: "o@x.io", role: "operator" }, isLoading: false, error: null }),
  isOperator: () => true,
}));
vi.mock("@/pages/Matches", () => ({ default: () => <h1>matches heading</h1> }));
vi.mock("@/pages/WatchEdit", () => ({ default: () => <h1>watch edit heading</h1> }));
vi.mock("@/pages/Health", () => ({ default: () => <h1>health heading</h1> }));

describe("router code-splitting", () => {
  test("only Forbidden, NotFound and RouteError are static page imports", () => {
    const src = readFileSync(resolve(process.cwd(), "src/router.tsx"), "utf8");
    const staticPages = [...src.matchAll(/^import\s+.*from\s+"@\/pages\/(\w+)";/gm)].map((m) => m[1]);
    expect(staticPages.sort()).toEqual(["Forbidden", "NotFound", "RouteError"]);
    expect([...src.matchAll(/lazy\(\(\) => import\("@\/pages\/(\w+)"\)\)/g)].map((m) => m[1]).sort()).toEqual(
      ["Health", "Login", "Matches", "PostDetail", "Sources", "Watches", "WatchEdit"].sort(),
    );
  });

  test.each([
    ["/", "matches heading"],
    ["/watches/new", "watch edit heading"],
    ["/health", "health heading"],
  ])("renders %s through Suspense", async (path, heading) => {
    const router = createMemoryRouter(routes, { initialEntries: [path] });
    render(<RouterProvider router={router} />);
    expect(await screen.findByText(heading)).toBeTruthy();
  });
});
