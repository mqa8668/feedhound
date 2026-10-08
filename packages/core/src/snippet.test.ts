import { describe, expect, test } from "bun:test";
import { deriveSnippet } from "./snippet";

describe("deriveSnippet", () => {
  test("first non-blank line, whitespace collapsed", () => {
    expect(deriveSnippet("\n  \nFirst  line\nsecond")).toBe("First line");
    expect(deriveSnippet("a\r\nb")).toBe("a");
  });
  test("long line truncated to 120 code points ending with ellipsis", () => {
    const s = deriveSnippet("x".repeat(300));
    expect(Array.from(s ?? "")).toHaveLength(120);
    expect(s?.endsWith("…")).toBe(true);
    expect(deriveSnippet("😀".repeat(120))).toBe("😀".repeat(120));
  });
  test("blank or null gives null", () => {
    expect(deriveSnippet(" \n\t\n")).toBeNull();
    expect(deriveSnippet("")).toBeNull();
    expect(deriveSnippet(null)).toBeNull();
  });
});
