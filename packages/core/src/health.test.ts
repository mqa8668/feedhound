import { describe, expect, test } from "bun:test";
import { runReadiness } from "./health";

describe("runReadiness", () => {
  test("ok when every check is ok", async () => {
    const result = await runReadiness({ a: () => true, b: async () => true });
    expect(result).toEqual({ ok: true, checks: { a: "ok", b: "ok" } });
  });

  test("fail when any check returns false", async () => {
    const result = await runReadiness({ a: () => true, b: () => false });
    expect(result.ok).toBe(false);
    expect(result.checks).toEqual({ a: "ok", b: "fail" });
  });

  test("fail when a check throws", async () => {
    const result = await runReadiness({
      a: () => {
        throw new Error("boom");
      },
    });
    expect(result).toEqual({ ok: false, checks: { a: "fail" } });
  });

  test("a check that never settles is marked fail once timeoutMs elapses", async () => {
    const result = await runReadiness({ slow: () => new Promise(() => {}) }, { timeoutMs: 20 });
    expect(result).toEqual({ ok: false, checks: { slow: "fail" } });
  });
});
