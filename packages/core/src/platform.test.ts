import { describe, expect, test } from "bun:test";
import { platformOfUrl } from "./platform";

describe("platformOfUrl", () => {
  for (const url of ["https://example.com/x", "https://feeds.example.test/items/2", "", "not a url", null]) {
    test(`${String(url)} -> web`, () => {
      const p = platformOfUrl(url);
      expect(p.key).toBe("web");
      expect(p.openLabel).toBe("Open original");
    });
  }
  test("labels", () => {
    expect(platformOfUrl(null)).toMatchObject({ label: "Web", phoneLabel: "Show phone at original post", groupWord: "source" });
  });
});
