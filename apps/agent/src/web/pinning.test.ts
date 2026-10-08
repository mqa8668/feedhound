import { afterAll, describe, expect, test } from "bun:test";
import { createWebFetcher, pinnedFetch, pinnedLookup, pinnedRequestOptions, type FetchFn } from "./fetcher";
import { WebFetchError } from "./types";

const UA = "feedhound/0.1 (+https://example.test)";

describe("DNS pinning", () => {
  test("a resolver that turns private after the first answer never reaches the connection", async () => {
    let resolves = 0;
    const resolve = async (): Promise<string[]> => (++resolves === 1 ? ["93.184.216.34"] : ["10.0.0.5"]);
    const pins: (string | undefined)[] = [];
    const fetchFn: FetchFn = async (url, init) => {
      pins.push(init.pin?.address);
      return new Response("", { status: url.endsWith("/robots.txt") ? 404 : 200 });
    };
    const fetcher = createWebFetcher({ hosts: ["feeds.example.test"], userAgent: UA, minRequestGapMs: 0, resolve, fetch: fetchFn });
    // the page hop validates a public answer; the robots hop then gets a private one and is refused
    await expect(fetcher.getJson("https://feeds.example.test/a")).rejects.toBeInstanceOf(WebFetchError);
    expect(pins).not.toContain("10.0.0.5");
    expect(pins).toEqual([]);
  });

  test("every hop is handed the address it validated", async () => {
    const pins: (string | undefined)[] = [];
    const fetchFn: FetchFn = async (url, init) => {
      pins.push(init.pin?.address);
      return new Response("{}", { status: url.endsWith("/robots.txt") ? 404 : 200 });
    };
    const fetcher = createWebFetcher({ hosts: ["feeds.example.test"], userAgent: UA, minRequestGapMs: 0, resolve: async () => ["93.184.216.34", "2606:2800:220:1::1"], fetch: fetchFn });
    await fetcher.getJson("https://feeds.example.test/a");
    expect(pins).toEqual(["93.184.216.34", "93.184.216.34"]);
  });

  test("pinned lookup answers only with the validated address", () => {
    const lookup = pinnedLookup({ address: "93.184.216.34", family: 4 });
    let single: unknown[] = [];
    lookup("feeds.example.test", {}, (...a: unknown[]) => (single = a));
    expect(single).toEqual([null, "93.184.216.34", 4]);
    let all: unknown[] = [];
    lookup("feeds.example.test", { all: true }, (...a: unknown[]) => (all = a));
    expect(all).toEqual([null, [{ address: "93.184.216.34", family: 4 }]]);
  });

  test("https options keep the original hostname for Host and SNI", () => {
    const o = pinnedRequestOptions(new URL("https://feeds.example.test:8443/x?y=1"), { address: "93.184.216.34", family: 4 }, { Accept: "a" });
    expect(o.hostname).toBe("feeds.example.test");
    expect(o.servername).toBe("feeds.example.test");
    expect(o.headers.Host).toBe("feeds.example.test:8443");
    expect(o.path).toBe("/x?y=1");
    expect(o.port).toBe(8443);
  });
});

describe("pinned client over a local socket", () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /\n");
      if (u.pathname === "/redir") return new Response(null, { status: 302, headers: { location: "/data" } });
      if (u.pathname === "/big") return new Response("x".repeat(3 * 1024 * 1024));
      return Response.json({ host: req.headers.get("host"), ua: req.headers.get("user-agent") });
    },
  });
  afterAll(() => server.stop(true));

  test("connects to the pinned address while Host stays the original name", async () => {
    // the name does not exist in DNS: only the pin can make this connect
    const res = await pinnedFetch(`http://pinned.invalid:${server.port}/data`, {
      headers: { "User-Agent": UA },
      signal: new AbortController().signal,
      redirect: "manual",
      pin: { address: "127.0.0.1", family: 4 },
    });
    const body = (await res.json()) as { host: string; ua: string };
    expect(res.status).toBe(200);
    expect(body.host).toBe(`pinned.invalid:${server.port}`);
    expect(body.ua).toBe(UA);
  });

  test("full fetcher path with allowPrivateHosts: redirect, JSON and 2 MB cap", async () => {
    const fetcher = createWebFetcher({ hosts: ["127.0.0.1"], userAgent: UA, minRequestGapMs: 0, allowPrivateHosts: true });
    const ok = await fetcher.getJson(`http://127.0.0.1:${server.port}/redir`);
    expect(ok.status).toBe(200);
    await expect(fetcher.getText(`http://127.0.0.1:${server.port}/big`)).rejects.toMatchObject({ kind: "too_large" });
  });
});
