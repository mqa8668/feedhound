import { describe, expect, test } from "bun:test";
import { buildTree, classifySource, rollup, sourceHealth, type ClassifyConfig, type ClassifyPost, type HealthState, type SourceLeaf } from "./source-classify";

const cfg: ClassifyConfig = { minPosts: 20, topicShareMin: 0.5, regionMinPosts: 10, regionShareMin: 0.6 };
const post = (topic: string | null, region: string | null = null): ClassifyPost => ({ topicCategoryId: topic, region, topicPath: topic });
const many = (n: number, topic: string | null, region: string | null = null) => Array.from({ length: n }, () => post(topic, region));

describe("classifySource", () => {
  test("18 cars / 5 motorbikes / 2 null; region 9 of 12 hcm", () => {
    const posts = [
      ...many(9, "cars", "hcm"),
      ...many(3, "cars", "ha_noi"),
      ...many(6, "cars"),
      ...many(5, "motorbikes"),
      ...many(2, null),
    ];
    expect(posts).toHaveLength(25);
    const r = classifySource({ posts, defaults: {}, cfg });
    expect(r.topicCategoryId).toBe("cars");
    expect(r.topicMethod).toBe("auto");
    expect(r.topicShare).toBeCloseTo(0.72);
    expect(r.region).toBe("hcm");
    expect(r.regionMethod).toBe("auto");
    expect(r.regionShare).toBeCloseTo(0.75);
    expect(r.regionSampleN).toBe(12);
  });

  test("19 posts use defaults, else insufficient / none", () => {
    const posts = many(19, "cars", "hcm");
    const a = classifySource({ posts, defaults: { categoryId: "cars", region: "hcm" }, cfg });
    expect([a.topicCategoryId, a.topicMethod, a.region, a.regionMethod]).toEqual(["cars", "default", "hcm", "default"]);
    const b = classifySource({ posts, defaults: {}, cfg });
    expect([b.topicCategoryId, b.topicMethod, b.region, b.regionMethod, b.sampleN]).toEqual([null, "insufficient", null, "none", 19]);
  });

  test("Share 0.4 is mixed; 15/15 tie goes to the lower path", () => {
    const mixed = classifySource({ posts: [...many(12, "a"), ...many(10, "b"), ...many(8, "c")], defaults: {}, cfg });
    expect([mixed.topicCategoryId, mixed.topicMethod]).toEqual([null, "mixed"]);
    const tie = classifySource({ posts: [...many(15, "z"), ...many(15, "m")], defaults: {}, cfg });
    expect([tie.topicCategoryId, tie.topicMethod, tie.topicShare]).toEqual(["m", "auto", 0.5]);
  });

  test("region below the share threshold falls back to the default", () => {
    const posts = [...many(8, "a", "hcm"), ...many(7, "a", "ha_noi"), ...many(10, "a")];
    expect(classifySource({ posts, defaults: { region: "da_nang" }, cfg }).region).toBe("da_nang");
    expect(classifySource({ posts, defaults: {}, cfg }).regionMethod).toBe("none");
  });
});

const leaf = (over: Partial<SourceLeaf> & { health: HealthState }): SourceLeaf => ({
  id: crypto.randomUUID(),
  name: "n",
  url: "u",
  kind: "web",
  status: "active",
  coverageOk: null,
  coverageComplete: null,
  secondsSinceOkVisit: 60,
  relevance7d: { posts: 0, matched: 0, share: null },
  topic: { key: "t", label: "T", method: "auto", share: 0.7, categoryId: "t" },
  region: { key: "hcm", label: "HCM", method: "auto", share: 0.8 },
  sampleN: 30,
  classifiedAt: null,
  override: { topicCategoryId: null, region: null },
  ...over,
});

describe("health and rollup", () => {
  test("sourceHealth precedence", () => {
    const base = { healthAgeSec: 60 };
    expect(sourceHealth({ status: "paused", healthOk: false, coverageOk: 1, ...base })).toBe("paused");
    expect(sourceHealth({ status: "paused_by_health", healthOk: null, coverageOk: 1, healthAgeSec: 48 * 3600 })).toBe("down");
    expect(sourceHealth({ status: "active", healthOk: false, coverageOk: 1, healthAgeSec: 3600 })).toBe("down");
    expect(sourceHealth({ status: "active", healthOk: false, coverageOk: 1, healthAgeSec: 13 * 3600 })).toBe("stale");
    expect(sourceHealth({ status: "active", healthOk: false, coverageOk: 1, healthAgeSec: null })).toBe("stale");
    expect(sourceHealth({ status: "active", healthOk: true, coverageOk: null, ...base })).toBe("unknown");
    expect(sourceHealth({ status: "active", healthOk: true, coverageOk: 0.9, ...base })).toBe("degraded");
    expect(sourceHealth({ status: "active", healthOk: null, coverageOk: 0.99, ...base })).toBe("ok");
  });

  test("Stale never colours a parent; down share and no-ok-visit rules", () => {
    const ok = (n: number) => Array.from({ length: n }, () => leaf({ health: "ok" }));
    const stale = (n: number) => Array.from({ length: n }, () => leaf({ health: "stale" }));
    const r = rollup([...ok(17), ...stale(2)]);
    expect(r.worst).toBe("ok");
    expect(r.health.stale).toBe(2);
    expect(rollup([leaf({ health: "down" }), ...ok(1)]).worst).toBe("down");
    expect(rollup([leaf({ health: "down" }), ...ok(3)]).worst).toBe("degraded");
    const old = Array.from({ length: 4 }, () => leaf({ health: "ok", secondsSinceOkVisit: 13 * 3600 }));
    expect(rollup(old).worst).toBe("down");
    const never = Array.from({ length: 3 }, () => leaf({ health: "unknown", secondsSinceOkVisit: null }));
    expect(rollup(never).worst).not.toBe("down");
    expect(rollup([...never, ...old]).worst).toBe("down");
  });

  test("Rollup of A, B, C", () => {
    const a = leaf({ health: "degraded", coverageOk: 0.9, relevance7d: { posts: 10, matched: 3, share: 0.3 } });
    const b = leaf({ health: "unknown", relevance7d: { posts: 5, matched: 1, share: 0.2 } });
    const c = leaf({ health: "paused", status: "paused" });
    const r = rollup([a, b, c]);
    expect(r.health).toEqual({ degraded: 1, unknown: 1, paused: 1, ok: 0, down: 0, stale: 0 });
    expect(r.worst).toBe("degraded");
    expect(r.coverageOk).toBe(0.9);
    expect(r.relevance7d).toBeCloseTo(4 / 15);
    expect(rollup([c]).worst).toBe("paused");
    expect(rollup([]).relevance7d).toBeNull();
  });

  test("buildTree groups platform -> topic -> region with sorted nodes", () => {
    const l1 = leaf({ health: "ok", name: "b" });
    const l2 = leaf({ health: "ok", name: "a" });
    const l3 = leaf({ health: "ok", name: "c", topic: { key: "mixed", label: "Mixed", method: "mixed", share: null, categoryId: null } });
    const l4 = leaf({ health: "ok", name: "d", kind: "telegram" });
    const tree = buildTree([l1, l2, l3, l4], "now");
    expect(tree.platforms.map((p) => p.key)).toEqual(["web", "telegram"]);
    const web = tree.platforms[0]!;
    expect(web.topics.map((t) => t.key)).toEqual(["t", "mixed"]);
    expect(web.topics[0]!.regions[0]!.sources.map((s) => s.name)).toEqual(["a", "b"]);
    expect(web.rollup.sources).toBe(3);
    expect(tree.rollup.sources).toBe(4);
  });
});
