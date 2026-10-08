import { describe, expect, test } from "bun:test";
import { configRegistry } from "./config-registry";
import { configSchemas } from "./config-schema";
import { resolveSuggestExclude, resolveWeakTerms, SUGGEST_EXCLUDE_PRESETS, WEAK_TERM_PRESETS } from "./weak-terms";

const yaml = Bun.YAML.parse(await Bun.file(new URL("../../../config/defaults.yaml", import.meta.url).pathname).text()) as Record<string, unknown>;

describe("weak terms resolver", () => {
  test("presets", () => {
    expect(WEAK_TERM_PRESETS.en).toContain("for sale");
    expect(WEAK_TERM_PRESETS.vi).toHaveLength(19);
    expect(resolveWeakTerms({ preset: "en", custom: [] })).toEqual([...WEAK_TERM_PRESETS.en]);
    expect(resolveWeakTerms({ preset: "vi", custom: [] })).toEqual([...WEAK_TERM_PRESETS.vi]);
    expect(resolveWeakTerms({ preset: "none", custom: [] })).toEqual([]);
  });
  test("union with the custom list, de-duplicated, order kept", () => {
    expect(resolveWeakTerms({ preset: "none", custom: ["a", "b", "a"] })).toEqual(["a", "b"]);
    expect(resolveWeakTerms({ preset: "en", custom: ["selling", "extra"] })).toEqual([...WEAK_TERM_PRESETS.en, "extra"]);
    expect(resolveWeakTerms({ preset: "vi", custom: ["x1"] })).toEqual([...WEAK_TERM_PRESETS.vi, "x1"]);
  });
  test("missing or unknown preset acts as en; missing custom is empty", () => {
    expect(resolveWeakTerms({})).toEqual([...WEAK_TERM_PRESETS.en]);
    expect(resolveWeakTerms({ preset: "xx", custom: null })).toEqual([...WEAK_TERM_PRESETS.en]);
  });
  test("suggested exclusions resolve the same way", () => {
    expect(resolveSuggestExclude({ preset: "vi", custom: [] })).toEqual(["thu mua", "cầm đồ", "cần mua", "tìm mua"]);
    expect(resolveSuggestExclude({ preset: "en", custom: ["scam"] })).toEqual([...SUGGEST_EXCLUDE_PRESETS.en, "scam"]);
    expect(resolveSuggestExclude({ preset: "none" })).toEqual([]);
  });
  test("config keys: schema, registry and yaml agree", () => {
    for (const key of ["match.weakTermsPreset", "watch.suggestExcludePreset"] as const) {
      expect(configSchemas[key].safeParse("vi").success).toBe(true);
      expect(configSchemas[key].safeParse("de").success).toBe(false);
      expect(yaml[key]).toBe("en");
      expect(configRegistry[key].default).toBe("en");
    }
    expect(yaml["match.weakTerms"]).toEqual([]);
    expect(yaml["watch.suggestExcludeSell"]).toEqual([]);
  });
});
