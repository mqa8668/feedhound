import { STOPWORDS } from "./stopwords";

// Term extraction and z-scores for trending terms.

const TOKEN_RE = /[\p{L}\p{N}]+/gu;
const URL_RE = /(?:https?:\/\/|www\.)\S+/gu;
const MAX_TOKENS = 300;
const MAX_TERM_LEN = 64;
const MAX_N = 3;

/** Tokens that are dropped (and break n-grams). Single digits survive as context ("airpods pro 2"). */
function keepToken(tok: string): boolean {
  if (tok.length < 2 && !/^\p{N}$/u.test(tok)) return false;
  if (/^\p{N}{8,}$/u.test(tok)) return false;
  if (tok.startsWith("http") || tok.startsWith("www")) return false;
  return !STOPWORDS.has(tok);
}

/** Distinct 1-3-grams of `text`; never spans a dropped token or a line break. */
export function extractTerms(text: string): string[] {
  const out = new Set<string>();
  let budget = MAX_TOKENS;
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    if (budget <= 0) break;
    const toks = (rawLine.normalize("NFC").toLowerCase().replace(URL_RE, " http ").match(TOKEN_RE) ?? []).slice(0, budget);
    budget -= toks.length;
    let run: string[] = [];
    const flush = (): void => {
      for (let i = 0; i < run.length; i++) {
        for (let n = 1; n <= MAX_N && i + n <= run.length; n++) {
          const term = run.slice(i, i + n).join(" ");
          if (term.length > MAX_TERM_LEN) break;
          if (n === 1 && term.length < 2) continue;
          out.add(term);
        }
      }
      run = [];
    };
    for (const tok of toks) {
      if (keepToken(tok)) run.push(tok);
      else flush();
    }
    flush();
  }
  return [...out];
}

/** z = (x - mu) / max(sigma, sqrt(mu), 1). */
export function zscoreFromStats(count: number, mu: number, sigma: number): number {
  return (count - mu) / Math.max(sigma, Math.sqrt(mu), 1);
}

export function meanStd(values: readonly number[]): { mu: number; sigma: number } {
  const n = values.length;
  if (n === 0) return { mu: 0, sigma: 0 };
  const mu = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mu) ** 2, 0) / n;
  return { mu, sigma: Math.sqrt(variance) };
}

/** z-score of `count` against hourly baseline counts. */
export function zscore(count: number, baseline: readonly number[]): number {
  const { mu, sigma } = meanStd(baseline);
  return zscoreFromStats(count, mu, sigma);
}
