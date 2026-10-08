import { describe, expect, test } from "vitest";
import { avatarSlot, displayTitle, initials, timeBucket } from "./feed-grammar";

describe("feed-grammar", () => {
  test("initials", () => {
    expect(initials("HỘI IPHONE TP.HCM")).toBe("IT");
    expect(initials("Nhóm Chợ Điện Mac")).toBe("ĐM");
    expect(initials("Cộng đồng Macbook Việt")).toBe("MV");
    expect(initials("Macbook - Hội Người Dùng")).toBe("MH");
    expect(initials("🔥 Group Mac Studio")).toBe("MS");
    expect(initials("Hội")).toBe("H");
    expect(initials("123 !!")).toBe("?");
    expect(initials("Macbook")).toBe("M");
    expect(initials("Đồng Tiền Vàng")).toBe("TV");
    expect(initials("ĐỒNG hồ Mac")).toBe("HM");
    expect(initials("HỘI MUA BÁN XE HƠI CŨ TPHCM")).toBe("TP");
    expect(initials("Hội mua bán xe ô tô cũ")).toBe("HM");
    expect(initials("Chợ Xe Ô Tô Cũ TP.HCM")).toBe("TH");
    expect(initials("Xe ô tô cũ Sài Gòn")).toBe("SG");
  });
  test("avatarSlot is stable and in 1..8", () => {
    expect(avatarSlot("abc")).toBe(avatarSlot("abc"));
    for (const id of ["a", "b", "source-9"]) expect(avatarSlot(id)).toBeGreaterThanOrEqual(1);
  });
  test("displayTitle fallbacks", () => {
    expect(displayTitle("  t ", "s")).toBe("t");
    expect(displayTitle("  ", "s")).toBe("s");
    expect(displayTitle(null, null)).toBeNull();
  });
  test("timeBucket", () => {
    const now = new Date("2026-10-04T10:00:00Z");
    const dayStart = new Date("2026-10-04T00:00:00Z");
    expect(timeBucket("2026-10-04T09:58:00Z", now, dayStart)).toBe("Last 10 minutes");
    expect(timeBucket("2026-10-04T09:30:00Z", now, dayStart)).toBe("Last hour");
    expect(timeBucket("2026-10-04T01:00:00Z", now, dayStart)).toBe("Earlier today");
    expect(timeBucket("2026-10-03T23:00:00Z", now, dayStart)).toBe("Older");
  });
});
