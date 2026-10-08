import { describe, expect, test } from "bun:test";
import { splitTarget } from "./target-split";

describe("splitTarget", () => {
  test("upper bound with tr", () => {
    expect(splitTarget("Honda city dưới 250tr")).toEqual({ product: "Honda city", priceMin: null, priceMax: 250_000_000 });
  });
  test("NFD input is normalized", () => {
    expect(splitTarget("Honda City dưới 250tr".normalize("NFD"))).toEqual({ product: "Honda City", priceMin: null, priceMax: 250_000_000 });
  });
  test("no price", () => {
    expect(splitTarget("iphone 15 pro max")).toEqual({ product: "iphone 15 pro max", priceMin: null, priceMax: null });
  });
  test("lower bound", () => {
    expect(splitTarget("macbook air m2 trên 15tr")).toEqual({ product: "macbook air m2", priceMin: 15_000_000, priceMax: null });
  });
  test("operators and units", () => {
    expect(splitTarget("sh 150i <= 80 triệu").priceMax).toBe(80_000_000);
    expect(splitTarget("ipad dưới 500k").priceMax).toBe(500_000);
    expect(splitTarget("xe dưới 2 củ").priceMax).toBe(2_000_000);
  });
  test("price only is left alone", () => {
    expect(splitTarget("dưới 250tr").priceMax).toBeNull();
  });
});
