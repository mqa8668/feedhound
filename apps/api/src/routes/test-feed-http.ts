import type { WebHttp } from "../../../agent/src/web/types";

export const RSS_BODY = `<?xml version="1.0"?><rss version="2.0"><channel><title>Example Deals</title>
${[1, 2, 3, 4, 5, 6, 7]
  .map((n) => `<item><title>Deal ${n}</title><link>https://deals.example.test/item/${n}</link><guid>deal-${n}</guid><pubDate>Mon, 05 Oct 2026 0${n}:00:00 GMT</pubDate></item>`)
  .join("")}
</channel></rss>`;

/** Fake web client: every getText answers with `body` (no network). */
export function fakeFeedHttp(body: string, status = 200): WebHttp & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getJson() {
      throw new Error("unused");
    },
    async getText(url) {
      calls.push(url);
      return { status, retryAfterSec: null, body, etag: null, lastModified: null, notModified: false };
    },
  };
}
