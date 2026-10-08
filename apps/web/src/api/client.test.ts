import { afterEach, describe, expect, test, vi } from "vitest";
import { api, ApiError } from "./client";

function res(init: { type?: ResponseType; status: number; contentType: string; body?: string }): Response {
  return {
    type: init.type ?? "basic",
    status: init.status,
    ok: init.status >= 200 && init.status < 300,
    statusText: "",
    headers: new Headers({ "content-type": init.contentType }),
    json: async () => JSON.parse(init.body ?? "null"),
  } as unknown as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe("client session expiry", () => {
  test.each([
    ["opaqueredirect", res({ type: "opaqueredirect", status: 0, contentType: "" })],
    ["401 html", res({ status: 401, contentType: "text/html; charset=utf-8" })],
    ["200 html", res({ status: 200, contentType: "text/html" })],
  ])("%s -> session_expired", async (_name, response) => {
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    const err = await api.get("/me").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, code: "session_expired" });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  test("502 html is not session_expired", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res({ status: 502, contentType: "text/html" })));
    const err = await api.get("/me").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 502, code: "upstream_unavailable" });
  });

  test("JSON 401 keeps its code", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(res({ status: 401, contentType: "application/json", body: '{"error":"unauthorized"}' }));
    vi.stubGlobal("fetch", fetchMock);
    const err = await api.get("/me").catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 401, code: "unauthorized" });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });
});

describe("client non-JSON failures", () => {
  test.each([
    [502, "upstream_unavailable", "Server did not respond in time (HTTP 502). Try again."],
    [404, "http_404", "Request failed (HTTP 404)."],
  ])("%i with a non-JSON body -> %s", async (status, code, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res({ status, contentType: "text/plain" })));
    const err = await api.get("/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status, code, message });
  });
});
