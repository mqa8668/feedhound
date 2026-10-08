import { describe, expect, test } from "bun:test";
import { assertTestDatabase } from "./harness";

describe("assertTestDatabase", () => {
  test("throws for a non-test database", () => {
    expect(() => assertTestDatabase("postgres://u:p@h:5432/feedhound")).toThrow();
  });
  test("accepts a _test database", () => {
    expect(() => assertTestDatabase("postgres://u:p@h:5432/feedhound_test")).not.toThrow();
  });
});
