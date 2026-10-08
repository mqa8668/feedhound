import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

// Files in the design-token set carry no literal colors.
const SRC = path.resolve(__dirname, "..");
const FILES = [
  "components/ui/Icon.tsx",
  "components/layout/Card.tsx",
  "components/layout/StatCard.tsx",
  "components/SourceAvatar.tsx",
  "components/ListingCard.tsx",
  "pages/Matches.tsx",
  "pages/WatchEdit.tsx",
  "components/feed-grammar.ts",
  "pages/Health.tsx",
];
for (const f of readdirSync(path.join(SRC, "components/watches"))) if (f.endsWith(".tsx")) FILES.push(`components/watches/${f}`);
const PALETTE = "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const PATTERNS = [/#[0-9a-fA-F]{3,8}\b/, /\brgb\(/, /\bhsl\(/, new RegExp(`\\b(bg|text|border|ring|fill|stroke)-(${PALETTE})-\\d{2,3}\\b`)];

describe("no literal colors", () => {
  test.each(FILES)("%s", (file) => {
    const text = readFileSync(path.join(SRC, file), "utf8");
    for (const re of PATTERNS) expect(text).not.toMatch(re);
  });
});
