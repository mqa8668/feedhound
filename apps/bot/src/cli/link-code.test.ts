import { describe, expect, spyOn, test } from "bun:test";
import { randomCode } from "./link-code";

// Link codes must come from `crypto.getRandomValues`
// (CSPRNG), not `Math.random`, and stay within the documented 8-char [A-Z0-9] alphabet.
describe("randomCode", () => {
  test("returns 8 chars from [A-Z0-9] and does not collide across 200 draws", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const code = randomCode();
      expect(code).toMatch(/^[A-Z0-9]{8}$/);
      codes.add(code);
    }
    // 200 draws from a 36^8 space should essentially never collide.
    expect(codes.size).toBe(200);
  });

  test("draws from crypto.getRandomValues, not Math.random", () => {
    const spy = spyOn(crypto, "getRandomValues");
    spy.mockClear();
    randomCode();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
