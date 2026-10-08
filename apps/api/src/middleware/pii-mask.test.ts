import { describe, expect, test } from "bun:test";
import { authorKey } from "@feedhound/core/normalize";
import { authorRef, PHONE_MASK } from "@feedhound/core/pii";
import { maskJson } from "./pii-mask";

// Pure walk over a nested fixture.

const SALT = "test-salt";
const PHONE = "0912 345 678";

const fixture = {
  items: [
    {
      id: "p1",
      title: `Bán xe lh ${PHONE}`,
      displayTitle: `Vios ${PHONE}`,
      snippet: `<mark>xe</mark> gọi 0912 <mark>345</mark> 678`,
      text: `Zalo ${PHONE}`,
      authorName: "Nguyễn Văn A",
      authorId: "100012345",
      phone: "0912345678",
      raw: { authorName: "Nguyễn Văn A", note: PHONE },
      priceVnd: 150_000_000,
    },
    { id: "p2", authorName: "Trần B", authorId: null, text: "plain" },
  ],
  authors: [{ authorKey: "id:100012345", name: "Nguyễn Văn A", posts: 3 }],
  notable: [{ line: `Rao xe ${PHONE}` }],
  nested: { excerpt: `call ${PHONE}`, postTitle: `x ${PHONE}`, plain: PHONE, headline: PHONE },
};

describe("maskJson", () => {
  const out = maskJson(fixture, SALT) as typeof fixture & Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const json = JSON.stringify(out);

  test("phone digits, names and ids appear nowhere", () => {
    for (const leak of ["912", "345 678", "Nguyễn Văn A", "100012345", "0912345678"]) expect(json).not.toContain(leak);
    expect(json).toContain(PHONE_MASK);
  });

  test("authors become a ref and a label; authorId and raw/phone are dropped", () => {
    const ref = authorRef(SALT, authorKey({ authorId: "100012345", authorName: "Nguyễn Văn A" }));
    const a = out.items[0] as Record<string, unknown>;
    expect(a.authorRef).toBe(ref);
    expect(a.authorName).toBe(`Member #${ref}`);
    expect("authorId" in a).toBe(false);
    expect("raw" in a).toBe(false);
    expect("phone" in a).toBe(false);
    expect((out.items[1] as Record<string, unknown>).authorRef).toBe(authorRef(SALT, authorKey({ authorName: "Trần B" })));
  });

  test("analytics author key becomes the ref, name the label", () => {
    const ref = authorRef(SALT, "id:100012345");
    expect(out.authors[0]).toEqual({ authorKey: ref as string, name: `Member #${ref}`, posts: 3 });
  });

  test("non-text fields and the input are untouched", () => {
    expect((out.items[0] as Record<string, unknown>).priceVnd).toBe(150_000_000);
    expect(fixture.items[0]!.authorId).toBe("100012345");
  });

  test("a missing author key gives a null ref and label", () => {
    const o = maskJson({ authorName: null, authorId: null }, SALT) as Record<string, unknown>;
    expect(o).toEqual({ authorRef: null, authorName: null });
  });
});
