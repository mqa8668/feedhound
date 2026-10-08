import { describe, expect, test } from "bun:test";
import { DEFAULT_TZ, validTz } from "./tz";

describe("validTz", () => {
  test("accepts IANA zones, falls back for offsets and misspellings", () => {
    expect(validTz("America/New_York")).toBe("America/New_York");
    for (const bad of ["+07:00", "UTC+7", "Asia/Ho_Chi_Minhh", "", null, undefined, "Vietnam"]) expect(validTz(bad)).toBe(DEFAULT_TZ);
  });
});
