import { describe, expect, test } from "bun:test";
import { cutExcerpt, escapeHtml, formatAlert, formatDigest, formatOps, formatPriceVnd } from "./format";

describe("escapeHtml", () => {
  test("escapes html special chars", () => {
    expect(escapeHtml('<b>&"</b>')).toBe("&lt;b&gt;&amp;&quot;&lt;/b&gt;");
  });
});

describe("formatPriceVnd", () => {
  test("formats vnd, or em dash for null", () => {
    expect(formatPriceVnd(12_500_000)).toBe("12.500.000 VND");
    expect(formatPriceVnd(null)).toBe("—");
  });
});

describe("cutExcerpt", () => {
  test("cuts at a word boundary with an ellipsis", () => {
    const text = "a".repeat(10) + " " + "b".repeat(10);
    expect(cutExcerpt(text, 15)).toBe("aaaaaaaaaa…");
  });
  test("returns unchanged text under the limit", () => {
    expect(cutExcerpt("short", 300)).toBe("short");
  });
});

describe("formatAlert", () => {
  test("renders header, title, excerpt, meta and three buttons", () => {
    const { html, buttons } = formatAlert({
      watchNames: ["ip15", "macbook"],
      intent: "sell",
      priceVnd: 1_000_000,
      title: "iPhone 15 like new",
      excerpt: "Máy đẹp keng, bao test",
      sourceName: "Nhóm mua bán",
      authorName: "An",
      postedAt: new Date(Date.now() - 3 * 60_000),
      reactions: 5,
      comments: 2,
      url: "https://example.com/p/1",
      notificationId: "abc-123",
      excerptChars: 300,
      now: new Date(),
    });
    expect(html).toContain("ip15 · macbook");
    expect(html).toContain("Sell");
    expect(html).toContain("iPhone 15 like new");
    expect(html).toContain("3 min ago");
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toEqual([{ text: "Open post", url: "https://example.com/p/1" }]);
    expect(buttons[1]).toEqual([
      { text: "Mute 1h", callback: "m1:abc-123" },
      { text: "Mute watch", callback: "mw:abc-123" },
    ]);
  });

  // Alert: a multi-KB title with an escaped
  // entity/emoji near the cut boundary must never leave a dangling `&...;`
  // entity or an unclosed `<b>`/`<i>` tag — truncation happens on the plain
  // text before escaping, never on the assembled HTML string.
  test("truncates a multi-KB title without cutting inside an escaped entity or a tag", () => {
    const bigTitle = "Máy đẹp <3 & sẵn sàng " + "x".repeat(5000) + " 🎉 cuối cùng & hết";
    const { html } = formatAlert({
      watchNames: ["w"],
      intent: "sell",
      priceVnd: null,
      title: bigTitle,
      excerpt: "y".repeat(2000) + " & còn nữa",
      sourceName: "s",
      authorName: "a",
      postedAt: new Date(),
      reactions: 0,
      comments: 0,
      url: "https://example.com",
      notificationId: "n1",
      excerptChars: 300,
      now: new Date(),
    });
    expect(html.length).toBeLessThanOrEqual(4096);
    expect((html.match(/<b>/g) ?? []).length).toBe((html.match(/<\/b>/g) ?? []).length);
    expect((html.match(/<i>/g) ?? []).length).toBe((html.match(/<\/i>/g) ?? []).length);
    // Never ends mid-entity: every "&" is part of a complete &amp;/&lt;/&gt;/&quot;.
    expect(html).not.toMatch(/&(?!amp;|lt;|gt;|quot;)/);
  });
});

describe("formatDigest", () => {
  test("splits overflow into multiple messages suffixed (n/total)", () => {
    const entries = Array.from({ length: 3 }, (_, i) => ({ id: `n-${i}`, url: `https://x/${i}`, title: `t${i}`, priceVnd: null, sourceName: "s" }));
    const messages = formatDigest({ watchName: "ip15", entries, maxEntries: 2, notificationId: "n1" });
    expect(messages).toHaveLength(2);
    expect(messages[0]!.html).toContain("(1/2)");
    expect(messages[1]!.html).toContain("(2/2)");
    expect(messages.flatMap((m) => m.entryIds)).toEqual(["n-0", "n-1", "n-2"]);
  });

  // a chunk longer than 4096 chars must never silently drop trailing
  // entries — it is re-chunked into additional messages so every entry is still
  // delivered (and never by slicing the assembled HTML string).
  test("re-chunks into additional messages (never drops entries) when a chunk overflows 4096 chars", () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      id: `n-${i}`,
      url: `https://example.com/very/long/path/${i}`,
      title: "Máy đẹp <3 & sẵn sàng ".repeat(20) + i,
      priceVnd: 1_000_000,
      sourceName: "Nhóm mua bán",
    }));
    const messages = formatDigest({ watchName: "ip15", entries, maxEntries: 20, notificationId: "n1" });
    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      expect(message.html.length).toBeLessThanOrEqual(4096);
      expect((message.html.match(/<a /g) ?? []).length).toBe((message.html.match(/<\/a>/g) ?? []).length);
      expect(message.html).not.toMatch(/&(?!amp;|lt;|gt;|quot;)/);
    }
    // Every entry is delivered exactly once, across the messages, in order.
    expect(messages.flatMap((m) => m.entryIds)).toEqual(entries.map((e) => e.id));
  });
});

describe("formatOps", () => {
  test("renders kind, text and ISO ts without a hostname", () => {
    const html = formatOps({ kind: "dlq", text: "a < b", ts: new Date("2026-10-05T01:02:03.000Z") });
    expect(html).toBe("<b>[ops] dlq</b>\na &lt; b\n<i>2026-10-05T01:02:03.000Z</i>");
  });
});

// Telegram output stays unmasked (owner's private chat).
describe("formatAlert / formatDigest keep PII", () => {
  test("alert shows the raw phone, the real author name and the post url", () => {
    const { html, buttons } = formatAlert({
      watchNames: ["xe"],
      intent: "sell",
      priceVnd: 1_000_000,
      title: "Bán xe lh 0912 345 678",
      excerpt: "zalo 0912 345 678",
      sourceName: "Nhóm xe",
      authorName: "Nguyễn Văn A",
      postedAt: null,
      reactions: 0,
      comments: 0,
      url: "https://example.com/p/9",
      notificationId: "n-1",
      excerptChars: 300,
      now: new Date(),
    });
    expect(html).toContain("0912 345 678");
    expect(html).toContain("Nguyễn Văn A");
    expect(html).not.toContain("[SĐT ẩn]");
    expect(html).not.toContain("Member #");
    expect(buttons[0]).toEqual([{ text: "Open post", url: "https://example.com/p/9" }]);
  });

  test("digest shows the raw title", () => {
    const [m] = formatDigest({
      watchName: "xe",
      entries: [{ id: "n-1", url: "https://example.com/p/9", title: "Bán xe lh 0912 345 678", priceVnd: null, sourceName: "Nhóm xe" }],
      maxEntries: 20,
      notificationId: "n-1",
    });
    expect(m!.html).toContain("0912 345 678");
    expect(m!.html).not.toContain("[SĐT ẩn]");
  });
});
