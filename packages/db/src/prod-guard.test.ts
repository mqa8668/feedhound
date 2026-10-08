import { describe, expect, test } from "bun:test";
import { assertNotProdDbFromDev } from "./prod-guard";

const REMOTE_PROD = "postgres://u:p@db.internal.example:5433/feedhound";

describe("assertNotProdDbFromDev", () => {
  test("refuses dev process against prod db", () => {
    expect(() => assertNotProdDbFromDev(REMOTE_PROD, {})).toThrow(/production database/);
    expect(() => assertNotProdDbFromDev(REMOTE_PROD, { NODE_ENV: "development" })).toThrow();
  });
  test("allows feedhound_dev and feedhound_test", () => {
    expect(() => assertNotProdDbFromDev("postgres://u:p@h:5433/feedhound_dev", {})).not.toThrow();
    expect(() => assertNotProdDbFromDev("postgres://u:p@h:5433/feedhound_test", {})).not.toThrow();
  });
  test("allows production containers", () => {
    expect(() => assertNotProdDbFromDev(REMOTE_PROD, { NODE_ENV: "production" })).not.toThrow();
    expect(() => assertNotProdDbFromDev("postgres://u:p@postgres:5432/feedhound", {})).not.toThrow();
  });
  test("ALLOW_PROD_DB=1 overrides", () => {
    expect(() => assertNotProdDbFromDev(REMOTE_PROD, { ALLOW_PROD_DB: "1" })).not.toThrow();
  });
});
