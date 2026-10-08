import { describe, expect, test } from "bun:test";
import { serverRawPostSchema } from "@feedhound/core/sources";
import { CONNECTORS } from "../registry";
import { WebHttpError, WebParseError, type WebHttp, type WebTextResponse } from "../types";
import { feedConnector, parseFeed, previewFeed, stripHtml } from "./feed";

const read = (name: string): Promise<string> => Bun.file(new URL(`../../../../../tests/fixtures/feeds/${name}`, import.meta.url)).text();
const CAPTURED = new Date("2026-10-06T00:00:00.000Z");

function textHttp(body: string, over: Partial<WebTextResponse> = {}): WebHttp & { calls: { url: string; etag?: string | null | undefined; lastModified?: string | null | undefined }[] } {
  const calls: { url: string; etag?: string | null | undefined; lastModified?: string | null | undefined }[] = [];
  return {
    calls,
    async getJson() {
      throw new Error("unused");
    },
    async getText(url, opts) {
      calls.push({ url, ...opts });
      return { status: 200, retryAfterSec: null, body, etag: null, lastModified: null, notModified: false, ...over };
    },
  };
}

describe("feed connector: registration and url", () => {
  test("registered as 'feed'", () => {
    expect(CONNECTORS.get("feed")).toBe(feedConnector as never);
  });

  test("normalises the url into platformId", () => {
    const r = feedConnector.parseSourceUrl("HTTPS://News.Example.COM:443/feed.xml?x=1#frag");
    expect(r).toEqual({ ok: true, platformId: "feed:https://news.example.com/feed.xml?x=1", url: "https://news.example.com/feed.xml?x=1" });
    const again = feedConnector.parseSourceUrl((r as { url: string }).url);
    expect(again).toEqual(r);
    expect(feedConnector.parseSourceUrl("http://news.example.com:80/f")).toMatchObject({ url: "http://news.example.com/f" });
  });

  test("rejects other schemes, credentials and long urls", () => {
    for (const u of ["ftp://example.com/f", "javascript:alert(1)", "file:///etc/hosts", "https://user:pw@example.com/f", "https://user@example.com/f", "nonsense", `https://example.com/${"a".repeat(2100)}`]) {
      expect(feedConnector.parseSourceUrl(u).ok).toBe(false);
    }
  });
});

describe("feed parsing", () => {
  test("RSS 2.0", async () => {
    const feed = parseFeed(await read("rss2.xml"));
    expect(feed.title).toBe("Example Gadget Blog");
    expect(feed.malformed).toBe(1); // the empty <item>
    expect(feed.items.length).toBe(3);
    const posts = feed.items.map((i) => feedConnector.map(i, { capturedAt: CAPTURED, sourceUrl: "https://blog.example.com/rss.xml" })!);
    expect(posts.map((p) => p.platformPostId)).toEqual(["example-post-1001", "https://blog.example.com/posts/orbit-firmware", "https://blog.example.com/posts/undated"]);
    expect(posts[0]).toMatchObject({
      url: "https://blog.example.com/posts/zephyr-9",
      text: 'Quartz & Co. unveils the Zephyr 9\nA fanless laptop with a 14" panel.\nShips in November.',
      postedAt: "2026-10-05T08:30:00.000Z",
      authorName: "Mina Okafor",
      capture: "api",
      media: [{ type: "image", url: "https://blog.example.com/img/zephyr.jpg" }],
    });
    expect(posts[1]).toMatchObject({ authorName: "Ravi Sen", postedAt: "2026-10-04T17:00:00.000Z", media: [{ type: "image", url: "https://blog.example.com/img/orbit.png" }] });
    expect(posts[1]!.text).toBe("Firmware 2.1 for the Orbit router\nFixes a Wi-Fi roaming bug.\nSee notes.");
    expect(posts[2]!.postedAt).toBeUndefined();
    for (const p of posts) expect(serverRawPostSchema.safeParse(p).success).toBe(true);
  });

  test("Atom 1.0", async () => {
    const feed = parseFeed(await read("atom.xml"));
    expect(feed.title).toBe("Example Deals Feed");
    const posts = feed.items.map((i) => feedConnector.map(i, { capturedAt: CAPTURED, sourceUrl: "https://deals.example.test/atom.xml" })!);
    expect(posts.length).toBe(2);
    expect(posts[0]).toMatchObject({
      platformPostId: "tag:deals.example.test,2026:item-77",
      url: "https://deals.example.test/item/77",
      authorName: "Lan Pham",
      postedAt: "2026-10-05T04:45:00.000Z",
    });
    expect(posts[0]!.text).toBe("Used monitor 27 inch\nBarely used, & boxed.");
    expect(posts[1]).toMatchObject({ url: "https://deals.example.test/item/78", postedAt: "2026-10-04T09:00:00.000Z", text: "Mechanical keyboard\nTactile switches, hot-swappable." });
    for (const p of posts) expect(serverRawPostSchema.safeParse(p).success).toBe(true);
  });

  test("JSON Feed 1.1", async () => {
    const feed = parseFeed(await read("jsonfeed.json"));
    expect(feed.title).toBe("Example Notes");
    expect(feed.malformed).toBe(1);
    const posts = feed.items.map((i) => feedConnector.map(i, { capturedAt: CAPTURED, sourceUrl: "https://notes.example.com/feed.json" })!);
    expect(posts[0]).toMatchObject({
      platformPostId: "note-31",
      url: "https://notes.example.com/31",
      authorName: "Tuan Vo",
      postedAt: "2026-10-03T07:15:00.000Z",
      media: [{ type: "image", url: "https://notes.example.com/img/31.jpg" }],
    });
    expect(posts[0]!.text).toBe("Shelf build log\nCut the boards & sanded them.\nOak");
    expect(posts[1]).toMatchObject({ platformPostId: "32", text: "Short note without a title.", postedAt: "2026-10-04T15:00:00.000Z", media: [{ type: "audio", url: "https://notes.example.com/a/32.mp3" }] });
  });

  test("ids are stable across parses; missing id falls back to link, then a sha1", () => {
    const xml = `<rss><channel><item><title>A</title><link>https://e.example.com/a</link></item><item><title>B</title></item></channel></rss>`;
    const a = parseFeed(xml).items.map((i) => feedConnector.map(i, { capturedAt: CAPTURED, sourceUrl: "https://e.example.com/f" })!.platformPostId);
    const b = parseFeed(xml).items.map((i) => feedConnector.map(i, { capturedAt: new Date(), sourceUrl: "https://e.example.com/f" })!.platformPostId);
    expect(a).toEqual(b);
    expect(a[0]).toBe("https://e.example.com/a");
    expect(a[1]).toMatch(/^[0-9a-f]{40}$/);
  });

  test("a non-http item link falls back to the feed url; text is capped; items capped at 200", () => {
    const xml = `<rss><channel><item><title>T</title><link>javascript:alert(1)</link><guid>g</guid><description>${"x".repeat(30000)}</description></item></channel></rss>`;
    const post = feedConnector.map(parseFeed(xml).items[0]!, { capturedAt: CAPTURED, sourceUrl: "https://e.example.com/f.xml" })!;
    expect(post.url).toBe("https://e.example.com/f.xml");
    expect(post.text.length).toBe(20000);
    const many = `<rss><channel>${Array.from({ length: 250 }, (_, i) => `<item><title>t${i}</title><guid>g${i}</guid></item>`).join("")}</channel></rss>`;
    expect(parseFeed(many).items.length).toBe(200);
  });

  test("sniffs by content, not content type", () => {
    expect(parseFeed('﻿  {"items":[{"id":"1","title":"x"}]}').items.length).toBe(1);
  });

  test("an HTML page is a readable parse error", async () => {
    const html = await read("page.html");
    expect(() => parseFeed(html)).toThrow(WebParseError);
    expect(() => parseFeed(html)).toThrow(/HTML page, not a feed/);
    expect(() => parseFeed("plain words")).toThrow(/neither XML nor JSON/);
    expect(() => parseFeed("")).toThrow(/empty/);
    expect(() => parseFeed('{"a":1}')).toThrow(/not a JSON Feed/);
    expect(() => parseFeed("<rss><channel>")).toThrow(WebParseError);
  });

  test("stripHtml decodes entities and drops scripts", () => {
    expect(stripHtml("<p>a &amp; b &#169; &#x41;</p><script>evil()</script><p>c<br/>d</p>")).toBe("a & b \u00a9 A\nc\nd");
  });
});

describe("feed list()", () => {
  const URL_ = "https://news.example.com/feed.xml";

  test("single page, next null, validators returned and conditional headers sent", async () => {
    const http = textHttp(await read("rss2.xml"), { etag: '"abc"', lastModified: "Mon, 05 Oct 2026 08:00:00 GMT" });
    const page = await feedConnector.list(http, URL_, null, 50, { validators: { etag: '"old"', lastModified: null } });
    expect(page.next).toBeNull();
    expect(page.items.length).toBe(3);
    expect(page.malformed).toBe(1);
    expect(page.validators).toEqual({ etag: '"abc"', lastModified: "Mon, 05 Oct 2026 08:00:00 GMT" });
    expect(http.calls).toEqual([{ url: URL_, etag: '"old"', lastModified: null }]);
  });

  test("304 yields no items and keeps the validators", async () => {
    const prev = { etag: '"abc"', lastModified: null };
    const http = textHttp("", { status: 304, notModified: true });
    const page = await feedConnector.list(http, URL_, null, 50, { validators: prev });
    expect(page).toMatchObject({ items: [], next: null, notModified: true, validators: prev });
  });

  test("non-2xx throws WebHttpError; html body throws parse error", async () => {
    await expect(feedConnector.list(textHttp("", { status: 503, retryAfterSec: 30 }), URL_, null, 50)).rejects.toBeInstanceOf(WebHttpError);
    await expect(feedConnector.list(textHttp(await read("page.html")), URL_, null, 50)).rejects.toThrow(/HTML page/);
  });

  test("a non-normalised source url is refused", async () => {
    await expect(feedConnector.list(textHttp(""), "HTTPS://News.Example.com/x#y", null, 50)).rejects.toBeInstanceOf(WebParseError);
  });
});

describe("previewFeed", () => {
  test("ok with title and items", async () => {
    const r = await previewFeed("https://deals.example.test/atom.xml", textHttp(await read("atom.xml")));
    expect(r).toEqual({
      ok: true,
      title: "Example Deals Feed",
      items: [
        { title: "Used monitor 27 inch", url: "https://deals.example.test/item/77", postedAt: "2026-10-05T04:45:00.000Z" },
        { title: "Mechanical keyboard", url: "https://deals.example.test/item/78", postedAt: "2026-10-04T09:00:00.000Z" },
      ],
    });
  });

  test("failures carry a readable reason", async () => {
    expect(await previewFeed("ftp://x.example.com/f", textHttp(""))).toMatchObject({ ok: false });
    expect(await previewFeed("https://x.example.com/f", textHttp(await read("page.html")))).toMatchObject({ ok: false, reason: expect.stringContaining("HTML page") });
    expect(await previewFeed("https://x.example.com/f", textHttp("", { status: 404 }))).toEqual({ ok: false, reason: "the server answered HTTP 404" });
  });

  test("the default fetcher refuses a loopback host", async () => {
    const r = await previewFeed("http://127.0.0.1:9/feed.xml");
    expect(r.ok).toBe(false);
  });
});
