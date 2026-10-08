import { describe, expect, spyOn, test } from "bun:test";
import { randomLinkCode } from "./seed";

// The operator's seeded link code must come from
// `crypto.getRandomValues` (CSPRNG), not `Math.random`, and stay within the documented
// 8-char [A-Z0-9] alphabet.
describe("randomLinkCode", () => {
  test("returns 8 chars from [A-Z0-9] and does not collide across 200 draws", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const code = randomLinkCode();
      expect(code).toMatch(/^[A-Z0-9]{8}$/);
      codes.add(code);
    }
    expect(codes.size).toBe(200);
  });

  test("draws from crypto.getRandomValues, not Math.random", () => {
    const spy = spyOn(crypto, "getRandomValues");
    spy.mockClear();
    randomLinkCode();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
