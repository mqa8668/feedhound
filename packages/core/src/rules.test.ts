import { buildAliasDict, type CatalogItem, type Category } from "./classify";
import { normalizeText } from "./normalize";
import { runRules } from "./rules";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FIXTURE_PATH = fileURLToPath(new URL("../../../tests/fixtures/enrich-sample.jsonl", import.meta.url));

interface LabelledCase {
  text: string;
  expectedCategorySlug: string;
  expectedIntent: "sell" | "buy" | "other";
}

const CATEGORY_DEFS: { slug: string; names: string[] }[] = [
  { slug: "iphone", names: ["iphone 15", "iphone 14", "ip15", "ip14 pm", "iphone 13"] },
  { slug: "samsung", names: ["samsung s24", "samsung s23", "galaxy s24", "samsung a54"] },
  { slug: "macbook", names: ["macbook air", "macbook pro", "macbook m1"] },
  { slug: "ipad", names: ["ipad gen 9", "ipad pro", "ipad air"] },
  { slug: "earbuds", names: ["airpods pro", "airpods 3", "tai nghe bluetooth"] },
];

const categories: Category[] = CATEGORY_DEFS.map((def, i) => ({
  id: `cat-${i}`,
  parentId: null,
  slug: def.slug,
  name: def.slug,
}));

const items: CatalogItem[] = CATEGORY_DEFS.map((def, i) => ({
  id: `item-${i}`,
  categoryId: `cat-${i}`,
  name: def.names[0] as string,
  aliases: def.names,
}));

const categoryBySlug = new Map(categories.map((c) => [c.slug, c.id]));

describe("runRules", () => {
  const lines = readFileSync(FIXTURE_PATH, "utf8").trim().split("\n");
  const cases: LabelledCase[] = lines.map((line) => JSON.parse(line) as LabelledCase);
  const dict = buildAliasDict(categories, items);

  test("fixture has at least 200 labelled posts", () => {
    expect(cases.length).toBeGreaterThanOrEqual(200);
  });

  test("category accuracy >= 90% and intent accuracy >= 92%", () => {
    let categoryCorrect = 0;
    let intentCorrect = 0;

    for (const c of cases) {
      const textNormalized = normalizeText(c.text).nfc;
      const result = runRules({ text: c.text, textNormalized }, dict);
      const expectedCategoryId = categoryBySlug.get(c.expectedCategorySlug);
      if (result.categoryId === expectedCategoryId) categoryCorrect++;
      if (result.intent === c.expectedIntent) intentCorrect++;
    }

    const categoryAccuracy = categoryCorrect / cases.length;
    const intentAccuracy = intentCorrect / cases.length;
    console.log(`runRules accuracy: category=${categoryAccuracy}, intent=${intentAccuracy}`);

    expect(categoryAccuracy).toBeGreaterThanOrEqual(0.9);
    expect(intentAccuracy).toBeGreaterThanOrEqual(0.92);
  });

  test("masked price -> priceMasked flag set and confidence capped at 0.5", () => {
    const text = "e mới pick đc cây 18 pro max màu băng thanh giá 5x.000.000";
    const result = runRules({ text, textNormalized: normalizeText(text).nfc }, dict);
    expect(result.priceVnd).toBe(50_000_000);
    expect(result.priceRaw).toBe("5x.000.000");
    expect(result.priceMasked).toBe(true);
    expect(result.confidence).toBeLessThanOrEqual(0.5);
  });

  test("unmasked price -> priceMasked is false", () => {
    const text = "ban macbook air gia 15tr";
    const result = runRules({ text, textNormalized: normalizeText(text).nfc }, dict);
    expect(result.priceMasked).toBe(false);
    expect(result).toMatchObject({ priceQualifier: "exact", priceMaxVnd: null, priceConfidence: 0.9 });
  });

  test("Qualifier, max and confidence follow the picked price; no price -> null / 0", () => {
    const run = (text: string) => runRules({ text, textNormalized: normalizeText(text).nfc }, dict);
    expect(run("ban macbook air hon 20 trieu")).toMatchObject({ priceVnd: 20_000_000, priceQualifier: "floor", priceConfidence: 0.5 });
    expect(run("macbook air gia 15-18tr")).toMatchObject({ priceVnd: 15_000_000, priceMaxVnd: 18_000_000, priceQualifier: "range" });
    expect(run("ban macbook air")).toMatchObject({ priceVnd: null, priceQualifier: null, priceMaxVnd: null, priceConfidence: 0 });
    expect(run("macbook air da coc 5tr")).toMatchObject({ priceVnd: null, priceQualifier: null, priceConfidence: 0 });
  });
});
