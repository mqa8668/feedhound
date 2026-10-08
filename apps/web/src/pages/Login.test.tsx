import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AppShell } from "@/components/AppShell";
import Login from "@/pages/Login";

const session = vi.hoisted(() => ({ value: { me: undefined as unknown, isLoading: false, error: null, authMode: "local", needsLogin: false } }));
vi.mock("@/lib/session", () => ({ useSession: () => session.value, isOperator: () => false }));
vi.mock("@/api/ws", () => ({
  LiveProvider: ({ children }: { children: React.ReactNode }) => children,
  useLive: () => ({ status: "open" }),
}));
vi.mock("@/api/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/queries")>()),
  useUnseenMatches: () => ({ data: 0 }),
}));

function renderLogin() {
  const router = createMemoryRouter(
    [
      { path: "/login", element: <Login /> },
      { path: "/matches", element: <h1>matches page</h1> },
    ],
    { initialEntries: ["/login"] },
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.restoreAllMocks();
  session.value = { me: undefined, isLoading: false, error: null, authMode: "local", needsLogin: false };
});

describe("Login page", () => {
  test("successful login posts the password and redirects to /matches", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, { ok: true }));
    renderLogin();
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "s3cret" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("matches page");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/auth/login");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ password: "s3cret" });
    expect(new Headers((init as RequestInit).headers).get("x-requested-with")).toBe("feedhound");
  });

  test("wrong password shows an error and stays on /login", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(401, { error: "invalid_credentials" }));
    const router = renderLogin();
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Incorrect password");
    expect(router.state.location.pathname).toBe("/login");
  });

  test("rate limited response is explained", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(429, { error: "rate_limited" }));
    renderLogin();
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Too many attempts"));
  });

  test("submit is disabled while the password is empty", () => {
    renderLogin();
    expect((screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("session redirect", () => {
  function renderShell() {
    const router = createMemoryRouter(
      [
        { path: "/login", element: <h1>login page</h1> },
        { path: "/", element: <AppShell />, children: [{ path: "matches", element: <h1>inside</h1> }] },
      ],
      { initialEntries: ["/matches"] },
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  }

  test("AppShell redirects to /login when local mode has no session", async () => {
    session.value = { ...session.value, needsLogin: true };
    renderShell();
    await screen.findByText("login page");
  });

  test("local mode shows the logout button; cf-access does not", async () => {
    renderShell();
    expect(await screen.findAllByRole("button", { name: "Log out" })).not.toHaveLength(0);
  });

  test("cf-access mode renders no logout button", async () => {
    session.value = { ...session.value, authMode: "cf-access" };
    renderShell();
    await screen.findByText("inside");
    expect(screen.queryByRole("button", { name: "Log out" })).toBeNull();
  });
});
