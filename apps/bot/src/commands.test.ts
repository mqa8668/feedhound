import { describe, expect, test } from "bun:test";
import { parseCommand, parsePriceToken, tokenize } from "./commands";

describe("tokenize", () => {
  test("splits on whitespace and respects quotes", () => {
    expect(tokenize('/watch add "iphone 15" -x "cần mua"')).toEqual(["/watch", "add", "iphone 15", "-x", "cần mua"]);
  });
});

describe("parsePriceToken", () => {
  test("accepts k/tr suffixes", () => {
    expect(parsePriceToken("12k")).toBe(12_000);
    expect(parsePriceToken("1.5tr")).toBe(1_500_000);
    expect(parsePriceToken("500")).toBe(500);
  });
});

describe("parseCommand", () => {
  test("/start", () => {
    expect(parseCommand("/start")).toEqual({ kind: "start" });
  });

  test("/link <code>", () => {
    expect(parseCommand("/link ABCD1234")).toEqual({ kind: "link", code: "ABCD1234" });
  });

  test("/link with no code is an error", () => {
    expect(parseCommand("/link").kind).toBe("error");
  });

  test('/watch add "ip15" -x "cần mua"', () => {
    const result = parseCommand('/watch add "ip15" -x "cần mua"');
    expect(result).toEqual({
      kind: "watch_add",
      name: "ip15",
      include: ["ip15"],
      includeAll: [],
      exclude: ["cần mua"],
      regex: undefined,
      categorySlugs: [],
      priceMin: undefined,
      priceMax: undefined,
      intent: undefined,
    });
  });

  test("/watch add with -p price range", () => {
    const result = parseCommand("/watch add laptop -p 5tr-10tr");
    expect(result.kind).toBe("watch_add");
    if (result.kind === "watch_add") {
      expect(result.priceMin).toBe(5_000_000);
      expect(result.priceMax).toBe(10_000_000);
    }
  });

  test("/watch list | del | mute", () => {
    expect(parseCommand("/watch list")).toEqual({ kind: "watch_list" });
    expect(parseCommand("/watch del ip15")).toEqual({ kind: "watch_del", sel: "ip15" });
    expect(parseCommand("/watch mute ip15 2h")).toEqual({ kind: "watch_mute", sel: "ip15", durationMs: 2 * 3_600_000 });
    expect(parseCommand("/watch mute ip15")).toEqual({ kind: "watch_mute", sel: "ip15", durationMs: 3_600_000 });
    expect(parseCommand("/watch mute ip15 off")).toEqual({ kind: "watch_mute", sel: "ip15", durationMs: "off" });
  });

  test("/search with -n", () => {
    expect(parseCommand("/search iphone 15 -n 3")).toEqual({ kind: "search", q: "iphone 15", n: 3 });
  });

  test("/search -n out of range is an error", () => {
    expect(parseCommand("/search q -n 11").kind).toBe("error");
  });

  test("/status", () => {
    expect(parseCommand("/status")).toEqual({ kind: "status" });
  });

  test("unknown command", () => {
    expect(parseCommand("hello")).toEqual({ kind: "unknown" });
  });

  test("unknown slash command falls through to unknown", () => {
    expect(parseCommand("/foo")).toEqual({ kind: "unknown" });
  });
});
