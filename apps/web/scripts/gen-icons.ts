// Single source of the logo mark. Run: `bun run icons`.
// Writes public/favicon.svg, favicon.ico and the PNG set via chromium.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { chromium } from "@playwright/test";

const ACCENT = "#1d8660";
const PUBLIC_DIR = path.resolve(import.meta.dirname, "../public");

const glyph = (): string =>
  `<g fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round">` +
  `<circle cx="32" cy="32" r="16"/>` +
  `<path d="M32 6V18M32 46V58M6 32H18M46 32H58"/>` +
  `</g><circle cx="32" cy="32" r="4" fill="#fff"/>`;

const faviconSvg =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
  `<rect width="64" height="64" rx="14" fill="${ACCENT}"/>${glyph()}</svg>\n`;

// Full-bleed variant: glyph scaled to 60% and centred, no transparency, no rx.
const bleedSvg =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
  `<rect width="64" height="64" fill="${ACCENT}"/>` +
  `<g transform="translate(12.8 12.8) scale(0.6)">${glyph()}</g></svg>`;

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc(body));
  return Buffer.concat([head, body, tail]);
}

/** Strip the alpha channel from an RGBA 8-bit PNG (colour type 6 -> 2). */
function stripAlpha(png: Buffer): Buffer {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const idat: Buffer[] = [];
  for (let o = 8; o < png.length; ) {
    const len = png.readUInt32BE(o);
    if (png.toString("ascii", o + 4, o + 8) === "IDAT") idat.push(png.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x]!;
      const a = x >= 4 ? px[y * stride + x - 4]! : 0;
      const b = y > 0 ? px[(y - 1) * stride + x]! : 0;
      const c = x >= 4 && y > 0 ? px[(y - 1) * stride + x - 4]! : 0;
      let add = 0;
      if (f === 1) add = a;
      else if (f === 2) add = b;
      else if (f === 3) add = (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = (v + add) & 255;
    }
  }
  const out = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    out[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      for (let k = 0; k < 3; k++) out[y * (width * 3 + 1) + 1 + x * 3 + k] = px[y * stride + x * 4 + k]!;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    png.subarray(0, 8),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(out)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function ico(entries: { size: number; png: Buffer }[]): Buffer {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  let offset = 6 + 16 * entries.length;
  const dirs = entries.map(({ size, png }) => {
    const d = Buffer.alloc(16);
    d[0] = size;
    d[1] = size;
    d.writeUInt16LE(1, 4);
    d.writeUInt16LE(32, 6);
    d.writeUInt32LE(png.length, 8);
    d.writeUInt32LE(offset, 12);
    offset += png.length;
    return d;
  });
  return Buffer.concat([head, ...dirs, ...entries.map((e) => e.png)]);
}

mkdirSync(PUBLIC_DIR, { recursive: true });
writeFileSync(path.join(PUBLIC_DIR, "favicon.svg"), faviconSvg);

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const render = async (svg: string, size: number, opaque: boolean): Promise<Buffer> => {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    );
    const shot = await page.screenshot({ omitBackground: true, type: "png" });
    return opaque ? stripAlpha(shot) : shot;
  };
  const out = (name: string, buf: Buffer): void => writeFileSync(path.join(PUBLIC_DIR, name), buf);
  out("apple-touch-icon.png", await render(bleedSvg, 180, true));
  out("icon-192.png", await render(faviconSvg, 192, false));
  out("icon-512.png", await render(faviconSvg, 512, false));
  out("icon-maskable-512.png", await render(bleedSvg, 512, true));
  out(
    "favicon.ico",
    ico([
      { size: 16, png: await render(faviconSvg, 16, false) },
      { size: 32, png: await render(faviconSvg, 32, false) },
    ]),
  );
} finally {
  await browser.close();
}
console.log("icons written to", PUBLIC_DIR);
