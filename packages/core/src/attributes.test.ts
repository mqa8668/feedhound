import { describe, expect, test } from "bun:test";
import {
  attributeFilterSchema,
  canonValue,
  checkFilter,
  canonFilter,
  evalFilter,
  extractAttributes,
  isExpiryYearOnly,
  renderValue,
  resolvePriceBounds,
  resolveSchema,
  validateAttributes,
  type AttributeDef,
  type AttributeFilter,
  type AttributeSchema,
} from "./attributes";
import { carPosts, taxonomySchema } from "./fixtures/car-posts";

const mac = taxonomySchema("macbook");
const iphone = taxonomySchema("iphone");
const cars = taxonomySchema("cars");
const def = (s: AttributeSchema, key: string): AttributeDef => {
  const d = s.find((x) => x.key === key);
  if (!d) throw new Error(`no def ${key}`);
  return d;
};

describe("resolveSchema / resolvePriceBounds", () => {
  const tree = new Map([
    ["a", "root"],
    ["b", "root.mid"],
    ["c", "root.mid.leaf"],
  ]);
  test("nearest ancestor wins per key; bounds per side", () => {
    const num = (key: string, max: number): AttributeDef => ({ key, label: key, keyAttr: false, kind: "number", unit: "gb", min: 0, max });
    const schemas = new Map<string, AttributeSchema>([
      ["a", [num("x", 1), num("y", 1)]],
      ["c", [num("x", 9)]],
    ]);
    const r = resolveSchema("c", tree, schemas);
    expect(r.map((d) => d.key)).toEqual(["x", "y"]);
    expect((r[0] as { max: number }).max).toBe(9);
    const bounds = new Map([
      ["a", { min: 10, max: 100 }],
      ["b", { min: null, max: 50 }],
    ]);
    expect(resolvePriceBounds("c", tree, bounds)).toEqual({ min: 10, max: 50 });
    expect(resolvePriceBounds("c", tree, new Map())).toBeNull();
  });
});

describe("canonValue / validateAttributes", () => {
  test("snake-case, numeric strings, ranges", () => {
    expect(canonValue(def(mac, "chip"), "M2 Pro")).toBe("m2_pro");
    expect(canonValue(def(iphone, "market"), "VN/A")).toBe("vn");
    expect(canonValue(def(mac, "ram_gb"), "16")).toBe(16);
    expect(canonValue(def(mac, "battery_pct"), 150)).toBeUndefined();
    expect(canonValue(def(mac, "chip"), "m9")).toBeUndefined();
  });
  test("aliases resolve for enum/text; year upper bound is current year + 1", () => {
    expect(canonValue(def(cars, "model"), "Santa Fe")).toBe("santa_fe");
    expect(canonValue(def(cars, "model"), "CR-V")).toBe("cr_v");
    expect(canonValue(def(cars, "make"), "Huyndai")).toBe("hyundai");
    expect(canonValue(def(cars, "year"), 2100)).toBeUndefined();
    expect(canonValue(def(cars, "year"), new Date().getUTCFullYear() + 1)).toBeDefined();
  });
  test("validateAttributes drops unknown keys and invalid values, never throws", () => {
    expect(validateAttributes({ chip: "M2 Pro", ram_gb: "16", foo: 1, battery_pct: 150, ssd_gb: 512 }, mac)).toEqual({
      chip: "m2_pro",
      ram_gb: 16,
      ssd_gb: 512,
    });
    expect(validateAttributes(null, mac)).toEqual({});
    expect(validateAttributes([1], mac)).toEqual({});
  });
});

describe("extractAttributes", () => {
  test("MacBook fixtures", () => {
    expect(extractAttributes("Bán MacBook Air M2 16/256 pin 92%", mac)).toEqual({ chip: "m2", ram_gb: 16, ssd_gb: 256, battery_pct: 92 });
    expect(extractAttributes("MBP 14 M3 Pro 18/512 fullbox", mac)).toEqual({ chip: "m3_pro", ram_gb: 18, ssd_gb: 512 });
    expect(extractAttributes("m2p 16/1tb", mac)).toEqual({ chip: "m2_pro", ram_gb: 16, ssd_gb: 1024 });
    expect(extractAttributes("mba ssd 256 bán gấp", mac)).toEqual({ ssd_gb: 256 });
  });
  test("iPhone fixtures", () => {
    expect(extractAttributes("tân phú, 16 128gb Zd/a bản khe sim vl, nguyên zin, pin 87", iphone)).toEqual({
      storage_gb: 128,
      market: "zd",
      battery_pct: 87,
    });
    expect(extractAttributes("ip 15 pro 256 VN/A pin 100", iphone)).toEqual({ storage_gb: 256, market: "vn", battery_pct: 100 });
  });
});

describe("extractAttributes cars", () => {
  test.each(carPosts.map((p) => [p.name, p] as const))("%s", (_n, p) => {
    expect(extractAttributes(p.text, cars)).toEqual(p.expected);
  });
  test("fixtures cover at least 12 posts", () => {
    expect(carPosts.length).toBeGreaterThanOrEqual(12);
  });
});

describe("filters (pieces)", () => {
  const chip = def(mac, "chip");
  const f = (o: AttributeFilter): AttributeFilter => o;
  test("gte/in on ordered; missing fails; unknown value fails", () => {
    const gte = f({ key: "chip", op: "gte", value: "m2" });
    expect(["m2", "m3_pro", "m1_max", undefined].map((v) => evalFilter(chip, gte, v))).toEqual([true, true, false, false]);
    const inn = f({ key: "chip", op: "in", values: ["m1_max", "m4"] });
    expect(["m2", "m3_pro", "m1_max"].map((v) => evalFilter(chip, inn, v))).toEqual([false, false, true]);
    expect(evalFilter(chip, gte, "zz")).toBe(false);
    expect(evalFilter(def(mac, "ram_gb"), f({ key: "ram_gb", op: "gte", value: 16 }), 8)).toBe(false);
  });
  test("checkFilter rejects bad ops/values; canonFilter canonicalises", () => {
    expect(checkFilter(def(mac, "line"), f({ key: "line", op: "gte", value: "air" }))).not.toBeNull();
    expect(checkFilter(def(cars, "model"), f({ key: "model", op: "gte", value: "vios" }))).not.toBeNull();
    expect(checkFilter(chip, f({ key: "chip", op: "gte", value: "nope" }))).not.toBeNull();
    const ok = f({ key: "chip", op: "gte", value: "M2" });
    expect(checkFilter(chip, ok)).toBeNull();
    expect(canonFilter(chip, ok)).toEqual({ key: "chip", op: "gte", value: "m2" });
    expect(canonFilter(def(cars, "model"), f({ key: "model", op: "eq", value: "Vios" }))).toEqual({ key: "model", op: "eq", value: "vios" });
  });
  test("zod: `in` needs values, others need value", () => {
    expect(attributeFilterSchema.safeParse({ key: "chip", op: "in" }).success).toBe(false);
    expect(attributeFilterSchema.safeParse({ key: "chip", op: "eq" }).success).toBe(false);
    expect(attributeFilterSchema.safeParse({ key: "chip", op: "in", values: [] }).success).toBe(false);
    expect(attributeFilterSchema.safeParse({ key: "chip", op: "in", values: ["m1"] }).success).toBe(true);
  });
});

describe("renderValue", () => {
  test("labels, units", () => {
    expect(renderValue(def(cars, "make"), "mercedes_benz")).toBe("Mercedes-Benz");
    expect(renderValue(def(cars, "model"), "cr_v")).toBe("CR-V");
    expect(renderValue(def(cars, "transmission"), "mt")).toBe("MT");
    expect(renderValue(def(cars, "odo_km"), 60000)).toBe("60.000 km");
    expect(renderValue(def(mac, "ram_gb"), 16)).toBe("16GB");
    expect(renderValue(def(mac, "ssd_gb"), 1024)).toBe("1TB");
    expect(renderValue(def(mac, "chip"), "m2_pro")).toBe("M2 Pro");
  });
});

describe("year and odometer wording", () => {
  const now = new Date("2026-10-05T00:00:00Z");
  const year = (t: string): unknown => extractAttributes(t, cars, now).year;
  const odo = (t: string): unknown => extractAttributes(t, cars, now).odo_km;

  test("expiry dates are not the model year", () => {
    expect(year("VinFast VF3 2025 đăng kiểm 2027")).toBe(2025);
    expect(year("đk 2027")).toBeUndefined();
    expect(year("hạn bảo hiểm đến 03/2027")).toBeUndefined();
  });
  test("year is capped at the post year + 1", () => {
    expect(year("đời 2028")).toBeUndefined();
    expect(year("model 2027")).toBe(2027);
  });
  test("a colour word is not an until cue", () => {
    expect(year("xe màu đen 2018")).toBe(2018);
    expect(year("bảo hiểm 03/2026 đến 2027")).toBeUndefined();
  });
  test("isExpiryYearOnly", () => {
    expect(isExpiryYearOnly("vf3 2025 đăng kiểm 2027", 2027)).toBe(true);
    expect(isExpiryYearOnly("vf3 2027 đăng kiểm 2027", 2027)).toBe(false);
    expect(isExpiryYearOnly("vf3 2025", 2027)).toBe(false);
  });
  test("odometer wordings", () => {
    expect(odo("xe đi 3,5 vạn")).toBe(35_000);
    expect(odo("odo 35k")).toBe(35_000);
    expect(odo("đi 12 nghìn km")).toBe(12_000);
    expect(odo("odo 3v")).toBe(30_000);
    expect(odo("5 vạn km")).toBe(50_000);
  });
});
