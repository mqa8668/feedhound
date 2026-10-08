// Deterministic generator of corpus posts (seeded PRNG; no network, no clock).

export interface CorpusPostRow {
  sourceId: string;
  platformPostId: string;
  url: string;
  text: string;
  textNormalized: string;
  authorName: string;
  authorId: string;
  postedAt: Date;
}

/** mulberry32: small seeded PRNG returning floats in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ["iphone", "samsung", "macbook", "laptop", "ban", "can", "mua", "gia", "re", "fullbox", "seal", "like", "new", "cu", "may", "dep", "pro", "max", "ipad", "tuyen", "dung", "react"];
const AUTHORS = ["Nam", "Lan", "Hung", "Mai", "Tuan", "Linh"];

/** `count` posts spread over `days` days ending at `endMs`, round-robin over `sourceIds`; ~6 words each, 'iphone 15' in about a third. */
export function corpusPosts(count: number, seed: number, sourceIds: string[], runTag: string, endMs = Date.UTC(2026, 9, 1), days = 30): CorpusPostRow[] {
  const rnd = seededRandom(seed);
  const rows: CorpusPostRow[] = [];
  for (let i = 0; i < count; i++) {
    const n = 4 + Math.floor(rnd() * 5);
    const words: string[] = [];
    for (let j = 0; j < n; j++) words.push(WORDS[Math.floor(rnd() * WORDS.length)]!);
    if (rnd() < 0.34) words.push("iphone", "15");
    const text = words.join(" ");
    const author = AUTHORS[Math.floor(rnd() * AUTHORS.length)]!;
    rows.push({
      sourceId: sourceIds[i % sourceIds.length]!,
      platformPostId: `cp-${runTag}-${i}`,
      url: `https://feeds.example.test/g/posts/cp-${runTag}-${i}`,
      text,
      textNormalized: text,
      authorName: author,
      authorId: `${author.toLowerCase()}-${runTag}`,
      // several posts share a timestamp on purpose (keyset tie-break by id)
      postedAt: new Date(endMs - Math.floor(rnd() * days * 8) * 3 * 3600_000),
    });
  }
  return rows;
}
