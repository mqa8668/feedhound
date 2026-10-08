import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

// Recharts only loads through React.lazy components.
const PAGES = ["Matches", "PostDetail"];

describe("lazy charts", () => {
  test.each(PAGES)("%s.tsx has no static recharts import", (page) => {
    const src = readFileSync(resolve(process.cwd(), `src/pages/${page}.tsx`), "utf8");
    expect(src).not.toMatch(/from\s+["']recharts["']/);
  });
  test("chart components are imported lazily", () => {
    const detail = readFileSync(resolve(process.cwd(), "src/pages/PostDetail.tsx"), "utf8");
    expect(detail).toMatch(/lazy\(\(\) => import\("@\/components\/deal\/PriceDistributionChart"\)\)/);
  });
});
