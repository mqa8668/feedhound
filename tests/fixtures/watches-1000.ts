// Generated fixture for the matcher perf benchmark: 1000 compiled watches, 60% term-only
// with 1-5 terms, 20% with enrichment filters, 20% with regex.
import { compileWatch, type CategoryTree, type CompiledWatch, type Watch } from "../../packages/core/src/matcher";

const SAMPLE_TERMS = [
  "iphone",
  "samsung",
  "macbook",
  "laptop",
  "may anh",
  "xe may",
  "ban gap",
  "gia tot",
  "con moi",
  "256gb",
  "128gb",
  "16 pro",
  "15 pro max",
  "man hinh",
  "pin trau",
  "hang xach tay",
];

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)] as T;
}

function makeBaseWatch(id: string, overrides: Partial<Watch>): Watch {
  return {
    id,
    userId: "fixture-user",
    name: `watch ${id}`,
    enabled: true,
    include: [],
    includeAll: [],
    exclude: [],
    regex: null,
    categoryIds: [],
    itemIds: [],
    priceMin: null,
    priceMax: null,
    intents: [],
    sourceIds: [],
    notifierIds: [],
    quietHours: null,
    mutedUntil: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Generates `count` deterministic watches (60% term-only, 20% enrichment-filter, 20% regex). */
export function generateWatches(count = 1000, seed = 42): Watch[] {
  const rng = mulberry32(seed);
  const watches: Watch[] = [];

  for (let i = 0; i < count; i++) {
    const id = `watch-${i}`;
    const bucket = i % 5; // 0-2 term-only (60%), 3 enrichment (20%), 4 regex (20%)

    if (bucket <= 2) {
      const n = 1 + Math.floor(rng() * 5);
      const include = Array.from({ length: n }, () => pick(rng, SAMPLE_TERMS));
      watches.push(makeBaseWatch(id, { include }));
    } else if (bucket === 3) {
      watches.push(
        makeBaseWatch(id, {
          include: [pick(rng, SAMPLE_TERMS)],
          itemIds: [`item-${Math.floor(rng() * 50)}`],
          priceMin: 1_000_000,
          priceMax: 50_000_000,
          intents: ["sell"],
        }),
      );
    } else {
      watches.push(makeBaseWatch(id, { regex: "\\biphone\\s?1[3-9]\\b" }));
    }
  }

  return watches;
}

export function generateCompiledWatches(count = 1000, seed = 42, cat: CategoryTree = new Map()): CompiledWatch[] {
  return generateWatches(count, seed).map((w) => compileWatch(w, cat));
}
