// Pure source classification (topic + region), health, rollups and the platform -> topic -> region tree.
import { SLO_TARGETS } from "./metrics";

export interface ClassifyPost {
  topicCategoryId: string | null;
  region: string | null;
  /** ltree path of `topicCategoryId`; breaks topic ties deterministically (lower path wins). */
  topicPath?: string | null;
}

export interface ClassifyConfig {
  minPosts: number;
  topicShareMin: number;
  regionMinPosts: number;
  regionShareMin: number;
}

export interface ClassifyInput {
  posts: ClassifyPost[];
  defaults: { categoryId?: string; region?: string };
  cfg: ClassifyConfig;
}

export interface AutoClassification {
  topicCategoryId: string | null;
  topicMethod: "auto" | "mixed" | "default" | "insufficient";
  topicShare: number | null;
  region: string | null;
  regionMethod: "auto" | "default" | "none";
  regionShare: number | null;
  sampleN: number;
  regionSampleN: number;
}

export function classifySource(input: ClassifyInput): AutoClassification {
  const { posts, defaults, cfg } = input;
  const sampleN = posts.length;
  const regionSampleN = posts.filter((p) => p.region !== null).length;
  const enough = sampleN >= cfg.minPosts;

  let topicCategoryId: string | null = null;
  let topicMethod: AutoClassification["topicMethod"] = "insufficient";
  let topicShare: number | null = null;
  if (!enough) {
    if (defaults.categoryId) {
      topicCategoryId = defaults.categoryId;
      topicMethod = "default";
    }
  } else {
    const counts = new Map<string, { n: number; path: string }>();
    for (const p of posts) {
      if (p.topicCategoryId === null) continue;
      const cur = counts.get(p.topicCategoryId);
      if (cur) cur.n++;
      else counts.set(p.topicCategoryId, { n: 1, path: p.topicPath ?? p.topicCategoryId });
    }
    let best: { id: string; n: number; path: string } | null = null;
    for (const [id, v] of counts) {
      if (!best || v.n > best.n || (v.n === best.n && v.path < best.path)) best = { id, n: v.n, path: v.path };
    }
    const share = best ? best.n / sampleN : 0;
    if (best && share >= cfg.topicShareMin) {
      topicCategoryId = best.id;
      topicMethod = "auto";
      topicShare = share;
    } else {
      topicMethod = "mixed";
    }
  }

  let region: string | null = null;
  let regionMethod: AutoClassification["regionMethod"] = "none";
  let regionShare: number | null = null;
  if (enough && regionSampleN >= cfg.regionMinPosts) {
    const counts = new Map<string, number>();
    for (const p of posts) if (p.region !== null) counts.set(p.region, (counts.get(p.region) ?? 0) + 1);
    let best: [string, number] | null = null;
    for (const [r, n] of counts) if (!best || n > best[1] || (n === best[1] && r < best[0])) best = [r, n];
    if (best && best[1] / regionSampleN >= cfg.regionShareMin) {
      region = best[0];
      regionMethod = "auto";
      regionShare = best[1] / regionSampleN;
    }
  }
  if (regionMethod === "none" && defaults.region) {
    region = defaults.region;
    regionMethod = "default";
  }
  return { topicCategoryId, topicMethod, topicShare, region, regionMethod, regionShare, sampleN, regionSampleN };
}

export type HealthState = "ok" | "degraded" | "down" | "paused" | "unknown" | "stale";

/** A failed health result older than this (with no newer result) is "stale", not "down". */
export const HEALTH_STALE_AFTER_SEC = 12 * 3600;

export function sourceHealth(s: {
  status: string;
  healthOk: boolean | null;
  coverageOk: number | null;
  healthAgeSec: number | null;
}): HealthState {
  if (s.status === "paused") return "paused";
  if (s.status === "paused_by_health") return "down";
  if (s.healthOk === false) {
    return s.healthAgeSec !== null && s.healthAgeSec <= HEALTH_STALE_AFTER_SEC ? "down" : "stale";
  }
  if (s.coverageOk === null) return "unknown";
  if (s.coverageOk < SLO_TARGETS.coverageOk) return "degraded";
  return "ok";
}

export type Effective = {
  key: string;
  label: string;
  method: "auto" | "mixed" | "default" | "insufficient" | "none" | "override";
  share: number | null;
};

export interface SourceLeaf {
  id: string;
  name: string;
  url: string;
  kind: string;
  status: string;
  health: HealthState;
  coverageOk: number | null;
  coverageComplete: number | null;
  secondsSinceOkVisit: number | null;
  relevance7d: { posts: number; matched: number; share: number | null };
  topic: Effective & { categoryId: string | null };
  region: Effective;
  sampleN: number;
  classifiedAt: string | null;
  override: { topicCategoryId: string | null; region: string | null };
}

export interface Rollup {
  sources: number;
  health: Record<HealthState, number>;
  worst: HealthState;
  coverageOk: number | null;
  coverageComplete: number | null;
  maxSecondsSinceOkVisit: number | null;
  posts7d: number;
  matched7d: number;
  relevance7d: number | null;
}

function mean(values: (number | null)[]): number | null {
  const v = values.filter((x): x is number => x !== null);
  return v.length === 0 ? null : v.reduce((a, b) => a + b, 0) / v.length;
}

function worstHealth(leaves: SourceLeaf[], health: Record<HealthState, number>): HealthState {
  const live = leaves.filter((l) => l.health !== "paused");
  const m = live.length;
  if (m === 0) return leaves.length > 0 ? "paused" : "unknown";
  if (health.down * 2 >= m) return "down";
  // a null secondsSinceOkVisit means "not yet visited" (unknown), never down on its own
  const visited = live.filter((l) => l.secondsSinceOkVisit !== null);
  if (visited.length > 0 && visited.every((l) => (l.secondsSinceOkVisit as number) > HEALTH_STALE_AFTER_SEC)) return "down";
  if (health.down + health.degraded > 0) return "degraded";
  if (health.ok > 0) return "ok";
  return "unknown";
}

export function rollup(leaves: SourceLeaf[]): Rollup {
  const health: Record<HealthState, number> = { ok: 0, degraded: 0, down: 0, paused: 0, unknown: 0, stale: 0 };
  for (const l of leaves) health[l.health]++;
  const worst = worstHealth(leaves, health);
  const secs = leaves.map((l) => l.secondsSinceOkVisit).filter((x): x is number => x !== null);
  const posts7d = leaves.reduce((a, l) => a + l.relevance7d.posts, 0);
  const matched7d = leaves.reduce((a, l) => a + l.relevance7d.matched, 0);
  return {
    sources: leaves.length,
    health,
    worst,
    coverageOk: mean(leaves.map((l) => l.coverageOk)),
    coverageComplete: mean(leaves.map((l) => l.coverageComplete)),
    maxSecondsSinceOkVisit: secs.length > 0 ? Math.max(...secs) : null,
    posts7d,
    matched7d,
    relevance7d: posts7d > 0 ? matched7d / posts7d : null,
  };
}

export interface RegionNode { key: string; label: string; rollup: Rollup; sources: SourceLeaf[] }
export interface TopicNode { key: string; categoryId: string | null; label: string; rollup: Rollup; regions: RegionNode[] }
export interface PlatformNode { key: "web" | "telegram" | "push"; label: string; rollup: Rollup; topics: TopicNode[] }
export interface SourceTree { rollup: Rollup; platforms: PlatformNode[]; generatedAt: string }
/** API response: the tree plus the config/taxonomy facts the UI needs (min posts hint, selectable regions). */
export interface SourceTreeResponse extends SourceTree { minPosts: number; regionOptions: string[] }

const PLATFORMS: { key: PlatformNode["key"]; kind: string; label: string }[] = [
  { key: "web", kind: "web", label: "Web" },
  { key: "telegram", kind: "telegram", label: "Telegram" },
  { key: "push", kind: "push", label: "Push" },
];

function groupBy<T>(items: T[], keyOf: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const it of items) {
    const k = keyOf(it);
    const arr = out.get(k);
    if (arr) arr.push(it);
    else out.set(k, [it]);
  }
  return out;
}

const bySizeThenLabel = <T extends { label: string }>(size: (t: T) => number) => (a: T, b: T): number =>
  size(b) - size(a) || a.label.localeCompare(b.label);

/** Platform -> topic -> region tree with a rollup on every node. */
export function buildTree(leaves: SourceLeaf[], generatedAt: string): SourceTree {
  const platforms: PlatformNode[] = [];
  for (const pf of PLATFORMS) {
    const inPlatform = leaves.filter((l) => l.kind === pf.kind);
    if (inPlatform.length === 0) continue;
    const topics: TopicNode[] = [];
    for (const topicLeaves of groupBy(inPlatform, (l) => l.topic.key).values()) {
      const first = topicLeaves[0]!;
      const regions: RegionNode[] = [];
      for (const regionLeaves of groupBy(topicLeaves, (l) => l.region.key).values()) {
        const r = regionLeaves[0]!.region;
        regions.push({
          key: r.key,
          label: r.label,
          rollup: rollup(regionLeaves),
          sources: [...regionLeaves].sort((a, b) => a.name.localeCompare(b.name)),
        });
      }
      regions.sort(bySizeThenLabel((n) => n.rollup.sources));
      topics.push({ key: first.topic.key, categoryId: first.topic.categoryId, label: first.topic.label, rollup: rollup(topicLeaves), regions });
    }
    topics.sort(bySizeThenLabel((n) => n.rollup.sources));
    platforms.push({ key: pf.key, label: pf.label, rollup: rollup(inPlatform), topics });
  }
  return { rollup: rollup(leaves), platforms, generatedAt };
}
