export interface HighlightSegment {
  text: string;
  match: boolean;
}

function foldChar(ch: string): string {
  return ch.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/đ/g, "d");
}

/**
 * Splits `text` into segments, flagging the parts that equal one of `terms` (accent- and case-insensitive).
 * Pure data so callers render React nodes (no HTML strings).
 */
export function highlight(text: string, terms: string[]): HighlightSegment[] {
  const chars = Array.from(text);
  let folded = "";
  const origIndex: number[] = [];
  chars.forEach((ch, i) => {
    const f = foldChar(ch);
    for (let k = 0; k < f.length; k++) origIndex.push(i);
    folded += f;
  });
  const marked = new Array<boolean>(chars.length).fill(false);
  for (const term of terms) {
    const needle = Array.from(term).map(foldChar).join("").trim();
    if (!needle) continue;
    let from = 0;
    for (;;) {
      const at = folded.indexOf(needle, from);
      if (at < 0) break;
      for (let k = at; k < at + needle.length; k++) {
        const oi = origIndex[k];
        if (oi !== undefined) marked[oi] = true;
      }
      from = at + needle.length;
    }
  }
  const out: HighlightSegment[] = [];
  chars.forEach((ch, i) => {
    const m = marked[i] === true;
    const last = out[out.length - 1];
    if (last && last.match === m) last.text += ch;
    else out.push({ text: ch, match: m });
  });
  return out;
}
