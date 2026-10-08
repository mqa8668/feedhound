import { describe, expect, it } from "bun:test";
import { postFingerprint } from "./fingerprint";
import { authorKey, normalizeText } from "./normalize";

describe("normalizeText", () => {
  it("normalizes NFC + lowercase + whitespace and produces a folded copy", () => {
    expect(normalizeText("Cần MUA  iPhone")).toEqual({
      nfc: "cần mua iphone",
      folded: "can mua iphone",
    });
  });

  it("collapses leading/trailing/internal whitespace", () => {
    expect(normalizeText("  Bán   xe  ")).toEqual({
      nfc: "bán xe",
      folded: "ban xe",
    });
  });

  it("folds đ/Đ to d/D", () => {
    expect(normalizeText("Điện thoại")).toEqual({
      nfc: "điện thoại",
      folded: "dien thoai",
    });
  });
});

describe("postFingerprint", () => {
  const base = { scopeId: "g1", authorId: "a1", text: "Bán xe Wave 2020 giá tốt" };
  const fp = (o: Partial<Parameters<typeof postFingerprint>[0]> = {}) => postFingerprint({ ...base, ...o });

  it("ignores whitespace, case, NFC/NFD, emoji, modifiers and zero-width chars", () => {
    const f = fp();
    expect(f).toMatch(/^[0-9a-f]{64}$/);
    expect(fp({ text: "  BÁN   xe\nwave 2020 giá tốt " })).toBe(f);
    expect(fp({ text: "Bán xe Wave 2020 giá tốt".normalize("NFD") })).toBe(f);
    expect(fp({ text: "Bán 🔥 xe Wave 2020 giá tốt 👍🏽❤️" })).toBe(f);
    expect(fp({ text: "Bán xe​ Wave 2020⁠ giá tốt﻿" })).toBe(f);
  });

  it("differs by group, author or early text; same after char 500", () => {
    const f = fp();
    expect(fp({ scopeId: "g2" })).not.toBe(f);
    expect(fp({ authorId: "a2" })).not.toBe(f);
    expect(fp({ text: "Bán xe Wave 2021 giá tốt" })).not.toBe(f);
    const head = "a".repeat(500);
    expect(fp({ text: `${head}xyz` })).toBe(fp({ text: `${head}other` }));
    expect(fp({ text: `${head.slice(1)}b` })).not.toBe(fp({ text: head }));
  });

  it("returns null for empty or emoji-only text", () => {
    expect(fp({ text: "" })).toBeNull();
    expect(fp({ text: " 🔥👍🏽 " })).toBeNull();
  });

  it("authorKey falls back to name then empty", () => {
    expect(authorKey({ authorId: "1", authorName: "x" })).toBe("id:1");
    expect(authorKey({ authorName: " Foo  Bar " })).toBe("name:foo bar");
    expect(authorKey({})).toBe("");
  });

});
