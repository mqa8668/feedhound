import { describe, expect, test } from "bun:test";
import { detectPhone, maskPhone } from "./phone";

// phone half: 
describe("detectPhone / maskPhone", () => {
  test("detects dotted and +84 forms", () => {
    expect(detectPhone("lh 0912.345.678")).toBe("0912345678");
    expect(detectPhone("+84 912 345 678")).toBe("0912345678");
  });
  test("a price is not a phone", () => {
    expect(detectPhone("giá 680.000.000")).toBeNull();
    expect(detectPhone("")).toBeNull();
  });
  test("skips an invalid first match", () => {
    expect(detectPhone("0212345678 hoặc 0987654321")).toBe("0987654321");
  });
  test("maskPhone", () => {
    expect(maskPhone("0912345678")).toBe("0912 ••• 78");
  });
});
