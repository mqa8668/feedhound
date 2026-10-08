import { describe, expect, test } from "bun:test";
import { authorKey } from "./normalize";
import { deriveSnippet } from "./snippet";
import { AUTHOR_REF_RE, authorLabel, authorRef, EMAIL_MASK, LINK_MASK, maskPii, PHONE_MASK } from "./pii";

describe("maskPii", () => {
  const masked: [string, string][] = [
    ["0912345678", PHONE_MASK],
    ["0912 345 678", PHONE_MASK],
    ["0912.345.678", PHONE_MASK],
    ["+84 912 345 678", PHONE_MASK],
    ["84912345678", PHONE_MASK],
    ["09​12​345678", PHONE_MASK],
    ["không chín một hai ba bốn năm sáu bảy tám", PHONE_MASK],
    ["０９１２３４５６７８", PHONE_MASK],
    ["zalo 912345678", `zalo ${PHONE_MASK}`],
    ["a.b@example.com", EMAIL_MASK],
    ["zalo.me/0912345678", LINK_MASK],
  ];
  for (const [input, out] of masked) {
    test(`masks ${JSON.stringify(input)}`, () => {
      const r = maskPii(input);
      expect(r).toBe(out);
      expect(maskPii(r)).toBe(r);
    });
  }

  test("html: <mark> inside a number", () => {
    const r = maskPii("0912 <mark>345</mark> 678", { html: true });
    expect(r).not.toMatch(/\d{3}/);
    expect(r).toContain(PHONE_MASK);
    expect(r.split("<mark>").length).toBe(r.split("</mark>").length);
    expect(maskPii(r, { html: true })).toBe(r);
  });

  test("two numbers give two masks", () => {
    expect(maskPii("0912345678 0987654321")).toBe(`${PHONE_MASK} ${PHONE_MASK}`);
  });

  test("math-bold digits and letter o between digits", () => {
    expect(maskPii("𝟎𝟗𝟏𝟐𝟑𝟒𝟓𝟔𝟕𝟖")).toBe(PHONE_MASK);
    expect(maskPii("0912o45678")).toBe(PHONE_MASK);
  });

  test("a phone inside prose keeps the surrounding text", () => {
    expect(maskPii("Vios 2019 lh 0912 345 678 xe đẹp")).toBe(`Vios 2019 lh ${PHONE_MASK} xe đẹp`);
  });

  const kept = ["150.000.000", "1,2 tỷ", "15tr5", "Vios 2019", "05/10/2025", "35.000 km", "12345678", "example.com/items/456"];
  for (const k of kept) {
    test(`keeps ${JSON.stringify(k)}`, () => {
      expect(maskPii(k)).toBe(k);
    });
  }
});

describe("authorRef", () => {
  const key = authorKey({ authorName: "Nguyễn Văn A" });
  test("8 hex, stable, salt-dependent", () => {
    const a = authorRef("S1", key);
    expect(a).toMatch(AUTHOR_REF_RE);
    expect(authorRef("S1", key)).toBe(a);
    expect(authorRef("S2", key)).not.toBe(a);
  });
  test("case, whitespace and NFC variants share a ref", () => {
    const variant = authorKey({ authorName: "  nguyễn   văn a ".normalize("NFD") });
    expect(authorRef("S1", variant)).toBe(authorRef("S1", key));
  });
  test("authorId wins over the name; empty key is null", () => {
    const withId = authorKey({ authorId: "100012345", authorName: "Nguyễn Văn A" });
    expect(withId).toBe("id:100012345");
    expect(authorRef("S1", withId)).not.toBe(authorRef("S1", key));
    expect(authorRef("S1", "")).toBeNull();
    expect(authorLabel(null)).toBeNull();
    expect(authorLabel("a3f2c1d0")).toBe("Member #a3f2c1d0");
  });
});

describe("maskPii security findings", () => {
  test("phone crossing the snippet cut is masked (mask before cut)", () => {
    const text = `${"a".repeat(105)} lh 0912345678 ${"b".repeat(30)}`;
    const snip = deriveSnippet(text, maskPii) as string;
    expect(snip).not.toMatch(/\d{4}/);
    expect(snip).toContain(PHONE_MASK);
  });
  test("truncated trailing digit run is masked", () => {
    expect(maskPii("giá tốt lh 0912 345…")).toBe(`giá tốt lh ${PHONE_MASK}…`);
    expect(maskPii("call 091234")).not.toMatch(/\d{4}/);
  });
});
