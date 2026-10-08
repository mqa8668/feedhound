import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const dir = path.resolve(__dirname);
const tokens = readFileSync(path.join(dir, "tokens.css"), "utf8");
const index = readFileSync(path.join(dir, "..", "index.css"), "utf8");
const rootBlock = tokens.slice(0, tokens.indexOf("@media"));

const NAMES = [
  "surface-0", "surface-1", "surface-2", "line", "line-strong", "text", "text-muted", "text-faint",
  "accent", "accent-fg", "good", "warn", "bad", "good-soft", "warn-soft", "bad-soft",
  ...Array.from({ length: 8 }, (_, i) => `avatar-${i + 1}`),
  "avatar-fg",
  "fs-sm", "fs-md", "fs-lg", "radius-sm", "radius-md",
  ...Array.from({ length: 6 }, (_, i) => `space-${i + 1}`),
];

describe("design tokens", () => {
  test("every token is defined in :root", () => {
    for (const n of NAMES) expect(rootBlock, n).toMatch(new RegExp(`--${n}:`));
  });
  test("type, radius and spacing values", () => {
    expect(rootBlock).toMatch(/--fs-sm:\s*12px/);
    expect(rootBlock).toMatch(/--fs-md:\s*14px/);
    expect(rootBlock).toMatch(/--fs-lg:\s*20px/);
    expect(rootBlock).toMatch(/--radius-sm:\s*6px/);
    expect(rootBlock).toMatch(/--radius-md:\s*10px/);
    expect(rootBlock).toMatch(/--space-6:\s*32px/);
  });
  test("index.css imports tokens before @theme inline and maps the color utilities", () => {
    const imp = index.indexOf("tokens.css");
    expect(imp).toBeGreaterThan(-1);
    expect(imp).toBeLessThan(index.indexOf("@theme inline"));
    for (const c of ["surface-1", "line", "good", "warn", "bad", "accent"]) expect(index).toMatch(new RegExp(`--color-${c}:`));
  });
});

// Review r1 item 7: avatar text contrast >= 4.5:1 for all 8 hues in both themes.
function triplet(block: string, name: string): [number, number, number] {
  const m = block.match(new RegExp(`--${name}:\\s*(\\d+)\\s+(\\d+)%\\s+(\\d+)%`));
  if (!m) throw new Error(`missing ${name}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
function luminance([h, s, l]: [number, number, number]): number {
  const sat = s / 100;
  const li = l / 100;
  const a = sat * Math.min(li, 1 - li);
  const f = (n: number): number => {
    const k = (n + h / 30) % 12;
    return li - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  const [r, g, b] = [f(0), f(8), f(4)].map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
describe("avatar contrast", () => {
  const darkBlock = tokens.slice(tokens.indexOf("@media"));
  test.each([["light", rootBlock], ["dark", darkBlock]] as const)("%s theme: every hue >= 4.5:1 against --avatar-fg", (_n, block) => {
    const fg = luminance(triplet(block, "avatar-fg"));
    for (let i = 1; i <= 8; i++) expect(contrast(luminance(triplet(block, `avatar-${i}`)), fg), `avatar-${i}`).toBeGreaterThanOrEqual(4.5);
  });
});
