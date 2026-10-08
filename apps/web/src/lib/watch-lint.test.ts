import { describe, expect, test } from "vitest";
import { lintWatch } from "./watch-lint";

const base = { include: [] as string[], includeAll: [] as string[] };

describe("lintWatch", () => {
  test("includeAll + zero hits -> include_all_zero, action moves terms to include", () => {
    const draft = { include: [], includeAll: ["mini", "air", "pro"] };
    const lint = lintWatch(draft, { total: 0 });
    expect(lint.map((l) => l.code)).toEqual(["include_all_zero"]);
    expect(lint[0]?.action?.apply(draft)).toEqual({ include: ["mini", "air", "pro"], includeAll: [] });
  });
  test("zero hits otherwise -> no_hits_7d", () => {
    expect(lintWatch({ ...base, include: ["a"] }, { total: 0 }).map((l) => l.code)).toEqual(["no_hits_7d"]);
  });
  test("1500 -> too_broad; 40 -> none; unknown preview -> none", () => {
    expect(lintWatch(base, { total: 1500 }).map((l) => l.code)).toEqual(["too_broad"]);
    expect(lintWatch(base, { total: 40 })).toEqual([]);
    expect(lintWatch(base, null)).toEqual([]);
  });
});
