/**
 * Pure command parser (bot command grammar). No I/O —
 * `poll.ts` calls `parseCommand` and dispatches the result against the DB.
 */

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (i >= text.length) break;
    if (text[i] === '"') {
      i++;
      let out = "";
      while (i < text.length && text[i] !== '"') {
        out += text[i];
        i++;
      }
      i++; // skip closing quote (tolerant of unterminated quotes)
      tokens.push(out);
    } else {
      let out = "";
      while (i < text.length && !/\s/.test(text[i]!)) {
        out += text[i];
        i++;
      }
      tokens.push(out);
    }
  }
  return tokens;
}

export type ParsedCommand =
  | { kind: "start" }
  | { kind: "link"; code: string }
  | {
      kind: "watch_add";
      name: string;
      include: string[];
      includeAll: string[];
      exclude: string[];
      regex?: string;
      categorySlugs: string[];
      priceMin?: number;
      priceMax?: number;
      intent?: "sell" | "buy";
    }
  | { kind: "watch_list" }
  | { kind: "watch_del"; sel: string }
  | { kind: "watch_mute"; sel: string; durationMs: number | "off" }
  | { kind: "search"; q: string; n: number }
  | { kind: "status" }
  | { kind: "unknown" }
  | { kind: "error"; usage: string };

const USAGE: Record<string, string> = {
  link: "/link <code>",
  watch: '/watch add <name> [-i "term"]* [-a "term"]* [-x "term"]* [-r <regex>] [-c <categorySlug>]* [-p <min>-<max>] [--intent sell|buy]\n/watch list | del <sel> | mute <sel> [<Nm|Nh|Nd> | off]',
  search: "/search <q> [-n <1..10>]",
};

/** Accepts `12k`, `1.5m` (or `1.5tr`), or a plain integer VND amount; `undefined` if unparseable. */
export function parsePriceToken(raw: string): number | undefined {
  const m = /^([0-9]+(?:[.,][0-9]+)?)(k|tr|m)?$/i.exec(raw.trim());
  if (!m) return undefined;
  const num = Number(m[1]!.replace(",", "."));
  if (Number.isNaN(num)) return undefined;
  const suffix = m[2]?.toLowerCase();
  if (suffix === "k") return Math.round(num * 1_000);
  if (suffix === "tr" || suffix === "m") return Math.round(num * 1_000_000);
  return Math.round(num);
}

const DURATION_RE = /^(\d+)(m|h|d)$/i;

function parseDuration(raw: string): number | "off" | undefined {
  if (raw.toLowerCase() === "off") return "off";
  const m = DURATION_RE.exec(raw);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  const unitMs = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return n * unitMs;
}

function parseWatchAdd(tokens: string[]): ParsedCommand {
  const name = tokens[0];
  if (!name) return { kind: "error", usage: USAGE.watch! };
  const include: string[] = [];
  const includeAll: string[] = [];
  const exclude: string[] = [];
  const categorySlugs: string[] = [];
  let regex: string | undefined;
  let priceMin: number | undefined;
  let priceMax: number | undefined;
  let intent: "sell" | "buy" | undefined;

  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i]!;
    const next = tokens[i + 1];
    switch (t) {
      case "-i":
        if (next === undefined) return { kind: "error", usage: USAGE.watch! };
        include.push(next);
        i += 2;
        break;
      case "-a":
        if (next === undefined) return { kind: "error", usage: USAGE.watch! };
        includeAll.push(next);
        i += 2;
        break;
      case "-x":
        if (next === undefined) return { kind: "error", usage: USAGE.watch! };
        exclude.push(next);
        i += 2;
        break;
      case "-r":
        if (next === undefined) return { kind: "error", usage: USAGE.watch! };
        regex = next;
        i += 2;
        break;
      case "-c":
        if (next === undefined) return { kind: "error", usage: USAGE.watch! };
        categorySlugs.push(next);
        i += 2;
        break;
      case "-p": {
        if (next === undefined) return { kind: "error", usage: USAGE.watch! };
        const parts = next.split("-");
        if (parts.length !== 2) return { kind: "error", usage: USAGE.watch! };
        const min = parsePriceToken(parts[0]!);
        const max = parsePriceToken(parts[1]!);
        if (min === undefined || max === undefined) return { kind: "error", usage: USAGE.watch! };
        priceMin = min;
        priceMax = max;
        i += 2;
        break;
      }
      case "--intent":
        if (next !== "sell" && next !== "buy") return { kind: "error", usage: USAGE.watch! };
        intent = next;
        i += 2;
        break;
      default:
        return { kind: "error", usage: USAGE.watch! };
    }
  }

  if (include.length === 0 && includeAll.length === 0 && !regex && categorySlugs.length === 0) {
    include.push(name);
  }

  return {
    kind: "watch_add",
    name,
    include,
    includeAll,
    exclude,
    regex,
    categorySlugs,
    priceMin,
    priceMax,
    intent,
  };
}

/** Parses one message text into a command, or `{kind:"unknown"}` for anything not starting with `/`. */
export function parseCommand(text: string): ParsedCommand {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return { kind: "unknown" };
  const tokens = tokenize(trimmed);
  const cmd = tokens[0]!.replace(/^\//, "").split("@")[0]!.toLowerCase();
  const rest = tokens.slice(1);

  switch (cmd) {
    case "start":
      return { kind: "start" };
    case "status":
      return { kind: "status" };
    case "link": {
      const code = rest[0];
      if (!code) return { kind: "error", usage: USAGE.link! };
      return { kind: "link", code };
    }
    case "search": {
      const parts: string[] = [];
      let n = 5;
      let i = 0;
      while (i < rest.length) {
        if (rest[i] === "-n") {
          const val = Number(rest[i + 1]);
          if (!Number.isInteger(val) || val < 1 || val > 10) return { kind: "error", usage: USAGE.search! };
          n = val;
          i += 2;
        } else {
          parts.push(rest[i]!);
          i++;
        }
      }
      const q = parts.join(" ").trim();
      if (!q) return { kind: "error", usage: USAGE.search! };
      return { kind: "search", q, n };
    }
    case "watch": {
      const sub = rest[0];
      if (sub === "add") return parseWatchAdd(rest.slice(1));
      if (sub === "list") return { kind: "watch_list" };
      if (sub === "del") {
        const sel = rest[1];
        if (!sel) return { kind: "error", usage: USAGE.watch! };
        return { kind: "watch_del", sel };
      }
      if (sub === "mute") {
        const sel = rest[1];
        if (!sel) return { kind: "error", usage: USAGE.watch! };
        const durationRaw = rest[2];
        const duration = durationRaw === undefined ? 3_600_000 : parseDuration(durationRaw);
        if (duration === undefined) return { kind: "error", usage: USAGE.watch! };
        return { kind: "watch_mute", sel, durationMs: duration };
      }
      return { kind: "error", usage: USAGE.watch! };
    }
    default:
      return { kind: "unknown" };
  }
}
