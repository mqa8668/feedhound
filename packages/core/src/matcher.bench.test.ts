// matchPost perf: p95 < 100 ms and mean < 50 ms over 100 runs against
// 1000 compiled watches and one 2 kB post with enrichment.
import { describe, expect, test } from "bun:test";
import { generateCompiledWatches } from "../../../tests/fixtures/watches-1000";
import { matchPost } from "./matcher";
import { normalizeText } from "./normalize";

const RUNS = 100;

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

describe("matchPost bench", () => {
  test("1000 watches x 100 runs stays within CI-friendly time budget", () => {
    const index = generateCompiledWatches(1000);
    const text = `${"ban iphone 15 pro max 256gb hang xach tay gia tot con moi ".repeat(35)}`.slice(0, 2000);
    const post = {
      id: "bench-post",
      sourceId: "bench-source",
      textNormalized: normalizeText(text).nfc,
    };
    const enrichment = { intent: "sell" as const, priceVnd: 20_000_000, categoryId: null, itemId: "item-1" };

    const durations: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const start = performance.now();
      matchPost({ post, enrichment }, index, new Date());
      durations.push(performance.now() - start);
    }
    durations.sort((a, b) => a - b);

    const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
    const p95 = percentile(durations, 95);

    expect(mean).toBeLessThan(50);
    expect(p95).toBeLessThan(100);
  });
});
