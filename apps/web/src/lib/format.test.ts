import { describe, expect, test } from "bun:test";
import { formatAbsolute, formatDateCell, formatPriceQualified, formatRelative, formatVndShort } from "./format";

describe("formatAbsolute", () => {
  test("formats in Asia/Ho_Chi_Minh zone as 'D Mon YYYY, HH:mm'", () => {
    // 2026-09-18T03:46:00Z -> 10:46 in UTC+7
    expect(formatAbsolute("2026-09-18T03:46:00Z")).toBe("18 Sep 2026, 10:46");
  });
});

describe("formatRelative", () => {
  const now = new Date("2026-09-18T10:00:00Z");

  test("returns 'just now' for < 5s", () => {
    expect(formatRelative(new Date("2026-09-18T09:59:58Z"), now)).toBe("just now");
  });

  test("returns minutes ago for past times", () => {
    expect(formatRelative(new Date("2026-09-18T09:55:00Z"), now)).toBe("5 minutes ago");
  });

  test("returns hours ago for past times over an hour", () => {
    expect(formatRelative(new Date("2026-09-18T07:00:00Z"), now)).toBe("3 hours ago");
  });

  test("returns future relative label", () => {
    expect(formatRelative(new Date("2026-09-18T10:10:00Z"), now)).toBe("in 10 minutes");
  });
});

describe("formatDateCell", () => {
  test("returns em dash for null/undefined", () => {
    expect(formatDateCell(null)).toEqual({ relative: "—", absolute: undefined });
    expect(formatDateCell(undefined)).toEqual({ relative: "—", absolute: undefined });
  });

  test("returns both relative and absolute for a date", () => {
    const result = formatDateCell("2026-09-18T03:46:00Z");
    expect(result.absolute).toBe("18 Sep 2026, 10:46");
    expect(typeof result.relative).toBe("string");
  });
});

describe("formatVndShort", () => {
  test("short forms", () => {
    expect(formatVndShort(25_000_000)).toBe("25M");
    expect(formatVndShort(17_900_000)).toBe("17.9M");
    expect(formatVndShort(500_000)).toBe("500k");
    expect(formatVndShort(1_500_000_000)).toBe("1.5B");
    expect(formatVndShort(900)).toBe("900");
  });
});

describe("formatPriceQualified", () => {
  test("renders qualifiers", () => {
    expect(formatPriceQualified(200e6, "floor")).toBe("> 200M");
    expect(formatPriceQualified(200e6, "ceiling")).toBe("< 200M");
    expect(formatPriceQualified(350e6, "approx")).toBe("~350M");
    expect(formatPriceQualified(180e6, "range", 200e6)).toBe("180–200M");
    expect(formatPriceQualified(200e6, "exact")).toBe("200M");
    expect(formatPriceQualified(null, "floor")).toBe("—");
  });
});
