import { describe, expect, test } from "bun:test";
import { createWebFetcher, type FetchFn } from "./fetcher";
import { WebFetchError } from "./types";

interface Call {
  url: string;
  headers: Record<string, string>;
  at: number;
}

const PUBLIC = async (): Promise<string[]> => ["93.184.216.34"];

function harness(robots: { status: number; body?: string } = { status: 404 }) {
  let clock = 1_000_000;
  const calls: Call[] = [];
  const waits: number[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, headers: init.headers, at: clock });
    if (url.endsWith("/robots.txt")) return new Response(robots.body ?? "", { status: robots.status });
    return new Response(JSON.stringify({ ads: [] }), { status: 200, headers: { "retry-after": "12" } });
  };
  const fetcher = createWebFetcher({
    hosts: ["feeds.example.test"],
    userAgent: "feedhound/0.1 (+https://example.test)",
    minRequestGapMs: 5000,
    fetch: fetchFn,
    resolve: PUBLIC,
    now: () => clock,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
  });
  return { fetcher, calls, waits, advance: (ms: number) => (clock += ms) };
}

describe("fetcher", () => {
  test("second request to the same host waits the gap; UA sent, no cookie", async () => {
    const h = harness();
    await h.fetcher.getJson("https://feeds.example.test/api/items?topic=gpu");
    const r = await h.fetcher.getJson("https://feeds.example.test/api/items?topic=gpu&o=3");
    expect(r.retryAfterSec).toBe(12);
    expect(r.body).toEqual({ ads: [] });
    // robots + list + list: every pair of requests is >= 5000 ms apart
    for (let i = 1; i < h.calls.length; i++) expect(h.calls[i]!.at - h.calls[i - 1]!.at).toBeGreaterThanOrEqual(5000);
    expect(h.calls.length).toBe(3);
    for (const c of h.calls) {
      expect(c.headers["User-Agent"]).toBe("feedhound/0.1 (+https://example.test)");
      expect(Object.keys(c.headers).map((k) => k.toLowerCase())).not.toContain("cookie");
    }
  });

  test("a host outside the allow-list is rejected without a request", async () => {
    const h = harness();
    await expect(h.fetcher.getJson("https://evil.example/x")).rejects.toBeInstanceOf(WebFetchError);
    expect(h.calls.length).toBe(0);
  });

  test("robots disallow -> no list request; robots 503 -> disallow", async () => {
    const a = harness({ status: 200, body: "User-agent: *\nDisallow: /api" });
    await expect(a.fetcher.getJson("https://feeds.example.test/api/items")).rejects.toMatchObject({ kind: "robots" });
    expect(a.calls.map((c) => c.url)).toEqual(["https://feeds.example.test/robots.txt"]);
    const b = harness({ status: 503 });
    await expect(b.fetcher.getJson("https://feeds.example.test/api/items")).rejects.toMatchObject({ kind: "robots" });
  });

  test("redirects are followed manually (max 3) and every hop is re-checked", async () => {
    const inits: string[] = [];
    const urls: string[] = [];
    const fetchFn: FetchFn = async (url, init) => {
      inits.push(init.redirect);
      urls.push(url);
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (url.endsWith("/v1/a")) return new Response("", { status: 302, headers: { location: "/v1/b" } });
      if (url.endsWith("/v1/b")) return new Response("", { status: 301, headers: { location: "https://other.example.test/x" } });
      return new Response("{}", { status: 200 });
    };
    const f = createWebFetcher({ hosts: ["feeds.example.test", "other.example.test"], userAgent: "feedhound/0.1", minRequestGapMs: 1000, fetch: fetchFn, resolve: PUBLIC, sleep: async () => undefined });
    const r = await f.getJson("https://feeds.example.test/v1/a");
    expect(r.status).toBe(200);
    expect(inits.every((m) => m === "manual")).toBe(true);
    expect(urls).toEqual([
      "https://feeds.example.test/robots.txt",
      "https://feeds.example.test/v1/a",
      "https://feeds.example.test/v1/b",
      "https://other.example.test/robots.txt",
      "https://other.example.test/x",
    ]);
  });

  test("a redirect to a host outside the allow-list is refused", async () => {
    const fetchFn: FetchFn = async (url) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      return new Response("", { status: 302, headers: { location: "https://evil.example/x" } });
    };
    const f = createWebFetcher({ hosts: ["feeds.example.test"], userAgent: "feedhound/0.1", minRequestGapMs: 1000, fetch: fetchFn, resolve: PUBLIC, sleep: async () => undefined });
    await expect(f.getJson("https://feeds.example.test/a")).rejects.toMatchObject({ kind: "forbidden_host" });
  });

  test("more than 3 redirects fails", async () => {
    let n = 0;
    const fetchFn: FetchFn = async (url) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      n++;
      return new Response("", { status: 302, headers: { location: `/r${n}` } });
    };
    const f = createWebFetcher({ hosts: ["feeds.example.test"], userAgent: "feedhound/0.1", minRequestGapMs: 1000, fetch: fetchFn, resolve: PUBLIC, sleep: async () => undefined });
    await expect(f.getText("https://feeds.example.test/a")).rejects.toMatchObject({ kind: "network" });
    expect(n).toBe(4);
  });

  test("robots.txt is fetched once per host within 24 h", async () => {
    const h = harness();
    await h.fetcher.getJson("https://feeds.example.test/a");
    h.advance(3_600_000);
    await h.fetcher.getJson("https://feeds.example.test/b");
    expect(h.calls.filter((c) => c.url.endsWith("/robots.txt")).length).toBe(1);
  });

  test("getText sends conditional headers and reports 304 and validators", async () => {
    const seen: Record<string, string>[] = [];
    const fetchFn: FetchFn = async (url, init) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      seen.push(init.headers);
      if (init.headers["If-None-Match"] === '"v1"') return new Response(null, { status: 304 });
      return new Response("<rss/>", { status: 200, headers: { etag: '"v2"', "last-modified": "Mon, 05 Oct 2026 08:00:00 GMT" } });
    };
    const f = createWebFetcher({ hosts: ["feeds.example.test"], userAgent: "feedhound/0.1", minRequestGapMs: 1000, fetch: fetchFn, resolve: PUBLIC, sleep: async () => undefined });
    const fresh = await f.getText("https://feeds.example.test/feed");
    expect(fresh).toMatchObject({ status: 200, body: "<rss/>", etag: '"v2"', lastModified: "Mon, 05 Oct 2026 08:00:00 GMT", notModified: false });
    const cond = await f.getText("https://feeds.example.test/feed", { etag: '"v1"', lastModified: "Sun, 04 Oct 2026 08:00:00 GMT" });
    expect(cond).toMatchObject({ status: 304, notModified: true, body: "" });
    expect(seen[1]).toMatchObject({ "If-None-Match": '"v1"', "If-Modified-Since": "Sun, 04 Oct 2026 08:00:00 GMT" });
    expect(seen[0]!["If-None-Match"]).toBeUndefined();
  });

  test("an oversize body is refused (declared and streamed)", async () => {
    const big = "x".repeat(2 * 1024 * 1024 + 10);
    const declared: FetchFn = async (url) =>
      url.endsWith("/robots.txt") ? new Response("", { status: 404 }) : new Response("ok", { status: 200, headers: { "content-length": String(big.length) } });
    const streamed: FetchFn = async (url) => (url.endsWith("/robots.txt") ? new Response("", { status: 404 }) : new Response(big, { status: 200 }));
    for (const fetchFn of [declared, streamed]) {
      const f = createWebFetcher({ hosts: ["feeds.example.test"], userAgent: "feedhound/0.1", minRequestGapMs: 1000, fetch: fetchFn, resolve: PUBLIC, sleep: async () => undefined });
      await expect(f.getText("https://feeds.example.test/feed")).rejects.toMatchObject({ kind: "too_large" });
    }
  });

  test("dynamic host provider is consulted per request", async () => {
    let hosts: string[] = [];
    const fetchFn: FetchFn = async (url) => new Response(url.endsWith("/robots.txt") ? "" : "{}", { status: url.endsWith("/robots.txt") ? 404 : 200 });
    const f = createWebFetcher({ hosts: () => hosts, userAgent: "feedhound/0.1", minRequestGapMs: 1000, fetch: fetchFn, resolve: PUBLIC, sleep: async () => undefined });
    await expect(f.getText("https://news.example.com/feed")).rejects.toMatchObject({ kind: "forbidden_host" });
    hosts = ["news.example.com"];
    expect((await f.getText("https://news.example.com/feed")).status).toBe(200);
  });
});

describe("fetcher SSRF guard", () => {
  function guarded(resolve: (h: string) => Promise<string[]>, extra: Partial<Parameters<typeof createWebFetcher>[0]> = {}) {
    const calls: string[] = [];
    const fetchFn: FetchFn = async (url) => {
      calls.push(url);
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (url.includes("/hop")) return new Response("", { status: 302, headers: { location: "http://internal.example.test/secret" } });
      return new Response("hello", { status: 200 });
    };
    const f = createWebFetcher({
      hosts: ["feeds.example.test", "internal.example.test", "10.0.0.5", "127.0.0.1", "[::1]", "169.254.169.254"],
      userAgent: "feedhound/0.1",
      minRequestGapMs: 1000,
      fetch: fetchFn,
      resolve,
      sleep: async () => undefined,
      ...extra,
    });
    return { f, calls };
  }

  test("DNS answer with any private address is refused before any request", async () => {
    const { f, calls } = guarded(async () => ["93.184.216.34", "10.1.2.3"]);
    await expect(f.getText("https://feeds.example.test/feed")).rejects.toMatchObject({ kind: "forbidden_host" });
    expect(calls.length).toBe(0);
  });

  test("literal-IP hosts and non-http schemes are refused", async () => {
    const { f, calls } = guarded(PUBLIC);
    for (const u of ["http://127.0.0.1/x", "http://10.0.0.5/x", "http://[::1]/x", "http://169.254.169.254/latest/meta-data", "ftp://feeds.example.test/x", "file:///etc/passwd"]) {
      await expect(f.getText(u)).rejects.toMatchObject({ kind: "forbidden_host" });
    }
    expect(calls.length).toBe(0);
  });

  test("a redirect hop whose host resolves to a private address is refused", async () => {
    const { f, calls } = guarded(async (h) => (h === "internal.example.test" ? ["127.0.0.1"] : ["93.184.216.34"]));
    await expect(f.getText("https://feeds.example.test/hop")).rejects.toMatchObject({ kind: "forbidden_host" });
    expect(calls.some((c) => c.includes("internal.example.test"))).toBe(false);
  });

  test("a name that does not resolve is a network error", async () => {
    const { f } = guarded(async () => {
      throw new Error("ENOTFOUND");
    });
    await expect(f.getText("https://feeds.example.test/feed")).rejects.toMatchObject({ kind: "network" });
  });

  test("allowPrivateHosts disables the guard", async () => {
    const { f, calls } = guarded(async () => ["127.0.0.1"], { allowPrivateHosts: true });
    expect((await f.getText("http://127.0.0.1/feed")).body).toBe("hello");
    expect((await f.getText("https://feeds.example.test/feed")).status).toBe(200);
    expect(calls.length).toBeGreaterThan(0);
  });

  test("the default resolver is used for literal IPs without DNS", async () => {
    const f = createWebFetcher({ hosts: ["127.0.0.1"], userAgent: "feedhound/0.1", minRequestGapMs: 1000, fetch: async () => new Response(""), sleep: async () => undefined });
    await expect(f.getText("http://127.0.0.1:9/x")).rejects.toBeInstanceOf(WebFetchError);
  });
});
