import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const WEB = path.resolve(__dirname, "../..");
const pub = (f: string) => path.join(WEB, "public", f);
const html = readFileSync(path.join(WEB, "index.html"), "utf8");

const PNGS: Array<[string, number, boolean]> = [
  ["apple-touch-icon.png", 180, true],
  ["icon-192.png", 192, false],
  ["icon-512.png", 512, false],
  ["icon-maskable-512.png", 512, true],
];
const FILES = ["favicon.svg", "favicon.ico", "manifest.webmanifest", ...PNGS.map((p) => p[0])];

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lig = l / 100;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return lig - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return `#${[f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`;
}

function surface1(scope: "light" | "dark"): string {
  const css = readFileSync(path.join(WEB, "src/styles/tokens.css"), "utf8");
  const block = scope === "light" ? css.slice(0, css.indexOf("@media")) : css.slice(css.indexOf("prefers-color-scheme: dark"));
  const m = /--surface-1:\s*(\d+)\s+(\d+)%\s+(\d+)%/.exec(block);
  if (!m) throw new Error("surface-1 not found");
  return hslToHex(Number(m[1]), Number(m[2]), Number(m[3]));
}

describe("head assets", () => {
  test.each(FILES)("%s exists", (f) => expect(existsSync(pub(f))).toBe(true));

  test.each(PNGS)("%s IHDR", (f, size, opaque) => {
    const buf = readFileSync(pub(f));
    expect(buf.readUInt32BE(16)).toBe(size);
    expect(buf.readUInt32BE(20)).toBe(size);
    if (opaque) expect(buf[25]).toBe(2);
  });

  test("favicon.ico has 16 and 32 entries", () => {
    const buf = readFileSync(pub("favicon.ico"));
    expect(buf.readUInt16LE(2)).toBe(1);
    expect(buf.readUInt16LE(4)).toBe(2);
    expect([buf[6], buf[22]]).toEqual([16, 32]);
  });

  test("favicon.svg is safe", () => {
    const svg = readFileSync(pub("favicon.svg"), "utf8");
    expect(svg).toContain('viewBox="0 0 64 64"');
    for (const bad of ["<script", "<image", "href="]) expect(svg).not.toContain(bad);
  });

  test("index.html links", () => {
    expect(html).toContain("<title>Feedhound</title>");
    expect(html).toMatch(/<link rel="icon" href="\/favicon\.ico" sizes="32x32"/);
    expect(html).toMatch(/<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml"/);
    expect(html).toMatch(/<link rel="apple-touch-icon" href="\/apple-touch-icon\.png"/);
    expect(html).toMatch(/<link rel="manifest" href="\/manifest\.webmanifest" crossorigin="use-credentials"/);
  });
});

describe("manifest", () => {
  const m = JSON.parse(readFileSync(pub("manifest.webmanifest"), "utf8")) as Record<string, unknown> & {
    icons: Array<{ src: string; sizes: string; purpose: string }>;
  };
  test("fields", () => {
    expect(m).toMatchObject({
      name: "Feedhound",
      short_name: "Feedhound",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#f9fafb",
      theme_color: "#ffffff",
    });
    expect(typeof m.description).toBe("string");
    expect(m.icons.map((i) => [i.sizes, i.purpose])).toEqual([
      ["192x192", "any"],
      ["512x512", "any"],
      ["512x512", "maskable"],
    ]);
  });
  test("icon files exist with matching size", () => {
    for (const i of m.icons) {
      const buf = readFileSync(pub(i.src.slice(1)));
      expect(`${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`).toBe(i.sizes);
    }
  });
});

describe("meta tags", () => {
  test("set", () => {
    expect(html).toContain('name="description" content="Feedhound — self-hosted keyword watcher for public feeds"');
    expect(html).toContain('name="robots" content="noindex, nofollow"');
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toContain('name="mobile-web-app-capable" content="yes"');
    expect(html).toContain('name="apple-mobile-web-app-title" content="Feedhound"');
    expect(html).toContain('name="apple-mobile-web-app-status-bar-style" content="default"');
  });
  test("theme-color equals --surface-1 tokens", () => {
    expect(html).toContain(`content="${surface1("light")}" media="(prefers-color-scheme: light)"`);
    expect(html).toContain(`content="${surface1("dark")}" media="(prefers-color-scheme: dark)"`);
  });
});
