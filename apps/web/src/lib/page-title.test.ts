import { describe, expect, test } from "vitest";
import { pageTitle } from "./page-title";

const CASES: Array<[string, string]> = [
  ["/sources", "Sources · Feedhound"],
  ["/watches", "Watches · Feedhound"],
  ["/watches/new", "New watch · Feedhound"],
  ["/watches/42", "Edit watch · Feedhound"],
  ["/matches", "Matches · Feedhound"],
  ["/posts/7", "Post · Feedhound"],
  ["/health", "Health · Feedhound"],
  ["/403", "Forbidden · Feedhound"],
  ["/x/y", "Not found · Feedhound"],
];

describe("pageTitle", () => {
  test.each(CASES)("%s", (path, title) => {
    expect(pageTitle(path, 0)).toBe(title);
    expect(pageTitle(path, 3)).toBe(`(3) ${title}`);
    expect(pageTitle(path, 12)).toBe(`(9+) ${title}`);
  });
});
