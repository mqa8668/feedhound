import { describe, expect, test } from "vitest";
import { highlight } from "./highlight";

describe("highlight", () => {
  test("accent- and case-insensitive", () => {
    expect(highlight("Bán máy MacBook", ["may"])).toEqual([
      { text: "Bán ", match: false },
      { text: "máy", match: true },
      { text: " MacBook", match: false },
    ]);
    expect(highlight("Bán máy MacBook", ["macbook"]).filter((s) => s.match)[0]?.text).toBe("MacBook");
  });
  test("no terms or no hit leaves one plain segment", () => {
    expect(highlight("abc", [])).toEqual([{ text: "abc", match: false }]);
    expect(highlight("abc", ["zzz"])).toEqual([{ text: "abc", match: false }]);
  });
  test("đ folds to d", () => {
    expect(highlight("đồng hồ", ["dong"])[0]).toEqual({ text: "đồng", match: true });
  });
});
