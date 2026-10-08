import { describe, expect, test } from "bun:test";
import { CONFIG_SECTIONS, configRegistry, humanizeDuration, isDefaultValue, validateConfigWrite, visibleEntries, type ConfigEntry } from "./config-registry";
import { configSchemas } from "./config-schema";

const yaml = Bun.YAML.parse(await Bun.file(new URL("../../../config/defaults.yaml", import.meta.url).pathname).text()) as Record<string, unknown>;
// Seeded + read by silence.ts but not in configSchemas; registered by the registry itself.
const REGISTRY_ONLY = ["watchdog.gapMultiplier", "watchdog.gapGraceMin"];
const entries = Object.values(configRegistry) as ConfigEntry[];

const USER = [
  "schedule.activeHours", "schedule.dailyCapPerSource", "schedule.visitEverySec",
  "media.thumbs.enabled", "llm.model.cheap", "llm.model.strong", "llm.enrichAll", "llm.dailyTokenBudget", "llm.budgetAlertPct",
  "match.minScore", "insights.topicsMax", "insights.digest.hourLocal", "insights.spike.minVolume", "insights.spike.ratioMin",
  "feed.priceBands", "notify.quietHoursStart", "notify.quietHoursEnd", "notify.digest.defaultEveryMin", "notify.excerptChars",
  "notify.ops.chatId", "notify.ops.recipientEmail",
  "watch.suggestExcludePreset", "watch.suggestExcludeSell", "app.tz", "retention.postRevisionDays",
];

describe("config registry", () => {
  test("covers schema keys and yaml keys, defaults equal yaml", () => {
    const regKeys = Object.keys(configRegistry).sort();
    expect(regKeys).toEqual([...Object.keys(configSchemas), ...REGISTRY_ONLY].sort());
    for (const k of Object.keys(yaml)) expect(regKeys).toContain(k);
    for (const e of entries) {
      if (e.key === "notify.ops.chatId") expect(e.default).toBeNull();
      else expect(isDefaultValue(e.key, yaml[e.key])).toBe(true);
    }
  });

  test("defaults pass schema, controls fit, copy rules, visibility", () => {
    for (const e of entries) {
      expect(e.schema.safeParse(e.default).success).toBe(true);
      expect(e.label.length).toBeLessThanOrEqual(60);
      expect(e.label).not.toMatch(/\w\.\w/);
      expect(e.label).not.toMatch(/\b(ms|sec|secs|seconds|min|minutes|percent|px)\b|%/i);
      expect(e.description.length).toBeLessThanOrEqual(160);
      expect(e.description.length).toBeGreaterThan(10);
      expect((e.description.match(/\. /g) ?? []).length).toBe(0);
      const v = e.default;
      const isRange = typeof v === "object" && v !== null && "min" in v && "max" in v;
      switch (e.control.kind) {
        case "toggle": expect(typeof v).toBe("boolean"); break;
        case "number": case "ratio": case "duration": case "hourOfDay": expect(typeof v).toBe("number"); break;
        case "range": expect(isRange).toBe(true); break;
        case "timeWindow": expect(typeof v === "object" && v !== null && "start" in v && "end" in v).toBe(true); break;
        case "time": case "cron": case "select": expect(typeof v).toBe("string"); break;
        case "tags": expect(Array.isArray(v) && v.every((x) => typeof x === "string")).toBe(true); break;
        case "numberList": expect(Array.isArray(v) && v.every((x) => typeof x === "number")).toBe(true); break;
        case "text": expect(typeof v === "string" || v === null).toBe(true); break;
        case "json": break;
      }
      if (e.key.endsWith("Pct")) expect(e.control).toEqual({ kind: "number", unit: "percent" });
      if (/Per(Sec|Min)$/.test(e.key)) expect(e.control.kind).toBe("number");
      if (e.control.kind === "duration") expect(/(Ms|Sec|Minutes|Hours|Days)$|retentionDays\.|defaultEveryMin|requestTtlMin/.test(e.key)).toBe(true);
      if (/(ratioMin|zMin|ConfidenceMin)$/.test(e.key)) expect(e.control.kind).not.toBe("duration");
    }
    expect(entries.filter((e) => e.visibility === "internal").map((e) => String(e.key)).sort()).toEqual(["bot.telegram.updateOffset"]);
    expect(entries.filter((e) => e.visibility === "user").map((e) => String(e.key)).sort()).toEqual([...USER].sort());
    expect(visibleEntries().length).toBe(entries.length - 1);
    expect(CONFIG_SECTIONS.map((s) => s.label)).toEqual(["Collection", "Matching & AI", "Dashboard insights", "Notifications", "Watches & search", "System"]);
  });

  test("media.thumbs.allowedHosts schema, registry and yaml", () => {
    const schema = configSchemas["media.thumbs.allowedHosts"];
    expect(schema.safeParse(["img.example.test", "cdn.example.test"]).success).toBe(true);
    for (const bad of [["https://x.com"], ["*.x.com"], ["localhost"], ["169.254.169.254"], ["10.0.0.1"], ["0.1"], ["1.2.3.4"], ["a.1"], ["-a.com"]]) expect(schema.safeParse(bad).success).toBe(false);
    expect(yaml["media.thumbs.allowedHosts"]).toEqual([]);
    expect((configRegistry["media.thumbs.allowedHosts"] as ConfigEntry).default).toEqual([]);
  });

  test("validateConfigWrite + humanizeDuration", () => {
    expect(validateConfigWrite("bot.telegram.updateOffset", 5)).toMatchObject({ ok: false, error: "internal_key" });
    expect(validateConfigWrite("nope.key", 1)).toMatchObject({ ok: false, error: "unknown_key" });
    const bad: [string, unknown][] = [
      ["notify.quietHoursStart", "25:00"],
      ["schedule.visitEverySec", { min: 900, max: 100 }],
      ["match.minScore", 1.5],
      ["sources.classify.cron", "x"],
      ["app.tz", "Mars/Base"],
    ];
    for (const [k, v] of bad) expect(validateConfigWrite(k, v)).toMatchObject({ ok: false, error: "validation" });
    expect(validateConfigWrite("notify.quietHoursStart", "23:30").ok).toBe(true);
    expect(validateConfigWrite("schedule.visitEverySec", { min: 100, max: 900 }).ok).toBe(true);
    expect(validateConfigWrite("app.tz", "Asia/Tokyo").ok).toBe(true);
    expect(humanizeDuration(2700, "sec")).toBe("45 min");
    expect(humanizeDuration(90, "days")).toBe("90 days");
  });
});
