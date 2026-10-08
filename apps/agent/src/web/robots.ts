// RFC 9309 subset (groups, longest-match Allow/Disallow, `*` and `$`).

interface Rule {
  allow: boolean;
  pattern: string;
}

export interface RobotsRules {
  allowed(path: string): boolean;
}

const ALLOW_ALL: RobotsRules = { allowed: () => true };
const DISALLOW_ALL: RobotsRules = { allowed: () => false };

function patternRe(pattern: string): RegExp {
  const endAnchor = pattern.endsWith("$");
  const body = endAnchor ? pattern.slice(0, -1) : pattern;
  const src = body.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${src}${endAnchor ? "$" : ""}`);
}

/** Parses robots.txt for `agent` (the product token, e.g. "feedhound"); the `*` group when no group names it. */
export function parseRobots(text: string, agent: string): RobotsRules {
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let current: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === "allow" || field === "disallow") {
      lastWasAgent = false;
      if (current && value !== "") current.rules.push({ allow: field === "allow", pattern: value });
    } else {
      lastWasAgent = false;
    }
  }
  const token = agent.toLowerCase();
  const own = groups.filter((g) => g.agents.some((a) => a !== "*" && a !== "" && a === token));
  const chosen = own.length > 0 ? own : groups.filter((g) => g.agents.includes("*"));
  const rules = chosen.flatMap((g) => g.rules).map((r) => ({ ...r, re: patternRe(r.pattern) }));
  return {
    allowed(path: string): boolean {
      let best: { allow: boolean; len: number } | null = null;
      for (const r of rules) {
        if (!r.re.test(path)) continue;
        const len = r.pattern.length;
        if (best === null || len > best.len || (len === best.len && r.allow)) best = { allow: r.allow, len };
      }
      return best === null ? true : best.allow;
    },
  };
}

/** robots.txt response -> rules: 2xx parsed, 4xx allow all, anything else (5xx / network) disallow all. */
export function robotsFromResponse(status: number | null, body: string, agent: string): RobotsRules {
  if (status !== null && status >= 200 && status < 300) return parseRobots(body, agent);
  if (status !== null && status >= 400 && status < 500) return ALLOW_ALL;
  return DISALLOW_ALL;
}
