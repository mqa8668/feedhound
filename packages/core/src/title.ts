/**
 * Title = first non-empty line, joined (" · ") with following lines until 40 code points,
 * cut to 80. `rest` is what the title did not consume: the remaining lines, preceded by any tail of the last
 * consumed line that the 80-code-point cut dropped.
 */
export function splitTitle(text: string): { title: string; rest: string } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return { title: "", rest: "" };
  let t = lines[0]!;
  let used = 1;
  let lastStart = 0;
  while (used < lines.length && Array.from(t).length < 40) {
    lastStart = Array.from(t).length + 3;
    t = `${t} · ${lines[used]!}`;
    used++;
  }
  const chars = Array.from(t);
  const title = chars.slice(0, 80).join("");
  const tail = chars.length > 80 ? Array.from(lines[used - 1]!).slice(80 - lastStart).join("") : "";
  return { title, rest: [tail, ...lines.slice(used)].filter((l) => l !== "").join("\n") };
}
