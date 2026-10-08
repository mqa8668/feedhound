import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createDb, schema, type DbHandle } from "@feedhound/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { readThumbConfig, runThumbSweep, thumbPath, toThumb, type ThumbConfig } from "./thumbs";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL && process.env.CI) throw new Error("thumbs.test.ts: TEST_DATABASE_URL is required (CI is set)");
if (TEST_DATABASE_URL && !new URL(TEST_DATABASE_URL).pathname.replace(/^\//, "").endsWith("_test")) {
  throw new Error("TEST_DATABASE_URL must point at a database whose name ends in '_test'");
}

const CONFIG: ThumbConfig = { enabled: true, userAgent: "feedhound-thumbs/0.1", batch: 100, backfillDays: 7, maxBytes: 5_242_880, timeoutMs: 40, allowedHosts: ["img.example.test", "cdn.example.test"] };

async function jpeg(w: number, h: number): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 30, b: 30 } } }).jpeg().toBuffer();
}

describe("toThumb limits (review r1)", () => {
  test("rejects a header declaring more pixels than the limit", async () => {
    const big = await sharp({ create: { width: 7000, height: 7000, channels: 3, background: "#fff" } }).png({ compressionLevel: 9 }).toBuffer();
    await expect(toThumb(big)).rejects.toThrow();
  });
  test("rejects svg", async () => {
    await expect(toThumb(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'))).rejects.toThrow();
  });
});

// library half: sharp loads and encodes under Bun.
describe("toThumb under Bun", () => {
  test("600x400 jpeg becomes a 160-px-wide webp; small images are not enlarged", async () => {
    const out = await toThumb(await jpeg(600, 400));
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(160);
    expect((await sharp(await toThumb(await jpeg(100, 80))).metadata()).width).toBe(100);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("runThumbSweep", () => {
  const RUN = crypto.randomUUID().slice(0, 8);
  let handle: DbHandle;
  let teamId: string;
  let sourceId: string;
  let mediaDir: string;
  let img: Buffer;
  const futureOe = (Date.now() / 1000 + 86_400).toString(16).split(".")[0]!;
  const pastOe = (Date.now() / 1000 - 86_400).toString(16).split(".")[0]!;

  async function mkPost(key: string, media: unknown[]): Promise<string> {
    const [p] = await handle.db
      .insert(schema.post)
      .values({ sourceId, platformPostId: `th-${key}-${RUN}`, url: "u", media })
      .returning({ id: schema.post.id });
    return p!.id;
  }
  const imgUrl = (key: string, oe = futureOe): string => `https://cdn1.img.example.test/v/${key}-${RUN}.jpg?oe=${oe}&_nc=1`;
  async function state(id: string): Promise<{ thumb_state: string | null; thumb_attempts: number }> {
    const [r] = await handle.sql<{ thumb_state: string | null; thumb_attempts: number }[]>`select thumb_state, thumb_attempts from post where id = ${id}::uuid`;
    return r!;
  }

  beforeAll(async () => {
    handle = createDb(TEST_DATABASE_URL!);
    mediaDir = await mkdtemp(`${tmpdir()}/thumbs-`);
    img = await jpeg(600, 400);
    const [t] = await handle.db.insert(schema.team).values({ name: `th-${RUN}` }).returning({ id: schema.team.id });
    teamId = t!.id;
    const [s] = await handle.db
      .insert(schema.source)
      .values({ teamId, kind: "web", platformId: `th-${RUN}`, name: "th", url: `https://feeds.example.test/th-${RUN}` })
      .returning({ id: schema.source.id });
    sourceId = s!.id;
  });

  afterAll(async () => {
    await handle.db.delete(schema.post).where(eq(schema.post.sourceId, sourceId));
    await handle.db.delete(schema.source).where(eq(schema.source.id, sourceId));
    await handle.db.delete(schema.team).where(eq(schema.team.id, teamId));
    await rm(mediaDir, { recursive: true, force: true });
    await handle.close();
  });

  test("allowed hosts default and override", async () => {
    const urls = {
      cdn: `https://cdn.example.test/a-${RUN}.jpg`,
      evil: `https://evil.example.com/b-${RUN}.jpg`,
      suffix: `https://cdn.example.test.evil.net/c-${RUN}.jpg`,
      notimg: `https://notimg.example.test/d-${RUN}.jpg`,
    };
    const ids = {
      cdn: await mkPost("h-cdn", [{ type: "image", url: urls.cdn }]),
      evil: await mkPost("h-evil", [{ type: "image", url: urls.evil }]),
      suffix: await mkPost("h-suffix", [{ type: "image", url: urls.suffix }]),
      notimg: await mkPost("h-notimg", [{ type: "image", url: urls.notimg }]),
    };
    const requested: string[] = [];
    const fakeFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes(`-${RUN}`)) requested.push(url);
      return new Response(img, { status: 200, headers: { "content-type": "image/jpeg" } });
    }) as typeof fetch;
    await runThumbSweep({ handle, mediaDir, fetch: fakeFetch, config: CONFIG, sleep: async () => {} });
    expect((await state(ids.cdn)).thumb_state).toBe("ok");
    for (const k of ["evil", "suffix", "notimg"] as const) expect((await state(ids[k])).thumb_state).toBe("failed");
    expect(requested).toEqual([urls.cdn]);

    const again = await mkPost("h-cdn2", [{ type: "image", url: `https://cdn.example.test/e-${RUN}.jpg` }]);
    requested.length = 0;
    await runThumbSweep({ handle, mediaDir, fetch: fakeFetch, config: { ...CONFIG, allowedHosts: ["img.example.test"] }, sleep: async () => {} });
    expect((await state(again)).thumb_state).toBe("failed");
    expect(requested).toEqual([]);
  });

  test("r1: invalid allowedHosts config falls back to the default list", async () => {
    const key = "media.thumbs.allowedHosts";
    const rows = await handle.db.select({ version: schema.config.version }).from(schema.config).where(eq(schema.config.key, key));
    let version = Math.max(0, ...rows.map((r) => r.version));
    const added: number[] = [];
    try {
      for (const bad of [["localhost"], [123], ["10.0.0.1"]]) {
        version += 1;
        added.push(version);
        await handle.db.insert(schema.config).values({ key, version, value: bad, updatedBy: `thumbs-test-${RUN}` });
        expect((await readThumbConfig(handle)).allowedHosts).toEqual([]);
      }
    } finally {
      await handle.db.delete(schema.config).where(eq(schema.config.updatedBy, `thumbs-test-${RUN}`));
    }
  });

  test("Stores a 160-px webp, request carries only UA + Accept; no-image post gets none", async () => {
    const p = await mkPost("ok", [{ type: "image", url: imgUrl("ok") }]);
    const none = await mkPost("none", []);
    const seen: { url: string; headers: Headers; init: RequestInit }[] = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(`-${RUN}`)) seen.push({ url, headers: new Headers(init?.headers), init: init ?? {} });
      return new Response(img, { status: 200, headers: { "content-type": "image/jpeg" } });
    }) as typeof fetch;
    await runThumbSweep({ handle, mediaDir, fetch: fakeFetch, config: CONFIG, sleep: async () => {} });

    expect(await state(p)).toMatchObject({ thumb_state: "ok" });
    expect(existsSync(thumbPath(mediaDir, p))).toBe(true);
    expect((await sharp(thumbPath(mediaDir, p)).metadata()).width).toBe(160);
    expect(thumbPath(mediaDir, p)).toContain(`/thumbs/${p.slice(0, 2)}/${p}.webp`);
    expect(seen.length).toBe(1);
    const sent = seen[0]!;
    expect(sent.headers.get("user-agent")).toBe(CONFIG.userAgent);
    expect(sent.headers.get("accept")).toBe("image/*");
    for (const h of ["cookie", "authorization", "referer"]) expect(sent.headers.has(h)).toBe(false);
    expect([...sent.headers.keys()].sort()).toEqual(["accept", "user-agent"]);
    expect(sent.init.redirect).toBe("manual");
    expect((await state(none)).thumb_state).toBe("none");
  });

  test("Terminal outcomes, retry backoff, 3rd failure, concurrency cap", async () => {
    const past = await mkPost("past", [{ type: "image", url: imgUrl("past", pastOe) }]);
    const gone = await mkPost("gone", [{ type: "image", url: imgUrl("gone") }]);
    const host = await mkPost("host", [{ type: "image", url: `https://evil.example.com/${`host-${RUN}`}.jpg` }]);
    const http = await mkPost("http", [{ type: "image", url: imgUrl("http").replace("https:", "http:") }]);
    const big = await mkPost("big", [{ type: "image", url: imgUrl("big") }]);
    const redir = await mkPost("redir", [{ type: "image", url: imgUrl("redir") }]);
    const slow = await mkPost("slow", [{ type: "image", url: imgUrl("slow") }]);
    const html = await mkPost("html", [{ type: "image", url: imgUrl("html") }]);

    let inFlight = 0;
    let maxInFlight = 0;
    const requests: string[] = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes(`-${RUN}`)) return new Response("", { status: 404 });
      requests.push(url);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((r) => setTimeout(r, 5));
        if (url.includes("/gone-")) return new Response("", { status: 404 });
        if (url.includes("/big-")) return new Response(new Uint8Array(6 * 1024 * 1024), { status: 200, headers: { "content-type": "image/jpeg" } });
        if (url.includes("/html-")) return new Response("<html>", { status: 200, headers: { "content-type": "text/html" } });
        if (url.includes("/redir-")) return new Response("", { status: 302, headers: { location: "https://evil.example.com/x.jpg" } });
        if (url.includes("/slow-")) {
          return await new Promise<Response>((_res, rej) => {
            init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
          });
        }
        return new Response(img, { status: 200, headers: { "content-type": "image/jpeg" } });
      } finally {
        inFlight--;
      }
    }) as typeof fetch;

    const t0 = Date.now();
    const run = (offsetMin: number) =>
      runThumbSweep({ handle, mediaDir, fetch: fakeFetch, config: CONFIG, sleep: async () => {}, now: () => new Date(t0 + offsetMin * 60_000) });
    await run(0);

    expect((await state(past)).thumb_state).toBe("expired");
    expect((await state(gone)).thumb_state).toBe("expired");
    expect((await state(host)).thumb_state).toBe("failed");
    expect((await state(http)).thumb_state).toBe("failed");
    expect((await state(big)).thumb_state).toBe("failed");
    expect((await state(redir)).thumb_state).toBe("failed");
    expect((await state(html)).thumb_state).toBe("failed");
    expect(await state(slow)).toEqual({ thumb_state: null, thumb_attempts: 1 });
    expect(requests.some((u) => u.includes("/past-") || u.includes("/host-") || u.includes("/http-"))).toBe(false);
    expect(maxInFlight).toBeLessThanOrEqual(2);

    // Backoff 10 min x 2^attempts: not retried at +5 or +19 min, retried at +21.
    const before = requests.length;
    await run(5);
    await run(19);
    expect(requests.length).toBe(before);
    await run(21);
    expect(await state(slow)).toEqual({ thumb_state: null, thumb_attempts: 2 });
    await run(21 + 41);
    expect(await state(slow)).toEqual({ thumb_state: "failed", thumb_attempts: 3 });
    const after = requests.length;
    await run(21 + 41 + 600);
    expect(requests.length).toBe(after); // terminal: never retried
  });

  test("a 5xx or 429 is a retry, not a terminal state", async () => {
    const p = await mkPost("five", [{ type: "image", url: imgUrl("five") }]);
    const fakeFetch = (async (input: string | URL | Request) => new Response("", { status: String(input).includes(`five-${RUN}`) ? 503 : 404 })) as typeof fetch;
    await runThumbSweep({ handle, mediaDir, fetch: fakeFetch, config: CONFIG, sleep: async () => {} });
    expect(await state(p)).toEqual({ thumb_state: null, thumb_attempts: 1 });
  });

  test("a spent time budget leaves the remaining rows untouched for the next tick", async () => {
    const p = await mkPost("budget", [{ type: "image", url: imgUrl("budget") }]);
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response(img, { status: 200, headers: { "content-type": "image/jpeg" } });
    }) as unknown as typeof fetch;
    await runThumbSweep({ handle, mediaDir, fetch: fakeFetch, config: CONFIG, sleep: async () => {}, budgetMs: 0 });
    expect(calls).toBe(0);
    expect(await state(p)).toEqual({ thumb_state: null, thumb_attempts: 0 });
  });

  test("request starts are spaced at least 250 ms apart", async () => {
    await mkPost("sp1", [{ type: "image", url: imgUrl("sp1") }]);
    await mkPost("sp2", [{ type: "image", url: imgUrl("sp2") }]);
    const sleeps: number[] = [];
    let clock = Date.now();
    const fakeFetch = (async () => new Response(img, { status: 200, headers: { "content-type": "image/jpeg" } })) as unknown as typeof fetch;
    await runThumbSweep({
      handle,
      mediaDir,
      fetch: fakeFetch,
      config: CONFIG,
      now: () => new Date(clock),
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    expect(sleeps.some((ms) => ms > 0 && ms <= 250)).toBe(true);
  });
});
