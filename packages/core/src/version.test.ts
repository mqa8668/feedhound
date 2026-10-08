import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appVersion } from "./version";

const ROOT = join(import.meta.dir, "..", "..", "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

describe("appVersion", () => {
  test("reads APP_VERSION, falls back to dev", () => {
    expect(appVersion({ APP_VERSION: "v1.2.3" })).toBe("v1.2.3");
    expect(appVersion({})).toBe("dev");
    expect(appVersion({ APP_VERSION: " " })).toBe("dev");
  });

  test("every Dockerfile bakes the version after bun install", () => {
    for (const app of ["api", "agent", "bot", "web"]) {
      const text = read(`apps/${app}/Dockerfile`);
      const install = text.indexOf("bun install");
      const arg = text.indexOf("ARG APP_VERSION");
      const env = text.indexOf("ENV APP_VERSION=$APP_VERSION");
      expect(install).toBeGreaterThan(-1);
      expect(arg).toBeGreaterThan(install);
      expect(env).toBeGreaterThan(arg);
    }
  });

});
