import { describe, expect, test } from "bun:test";
import { acceptLlmTitle, MAX_TITLE, ruleTitle } from "./display-title";
import { normalizeText } from "./normalize";
import { taxonomySchema } from "./fixtures/car-posts";

const cars = taxonomySchema("cars");
const mac = taxonomySchema("macbook");
const viosText = normalizeText("Bán Toyota Vios 1.5E số sàn sx 2016, odo 6v, xe gia đình Q7").folded;
const viosAttrs = { make: "toyota", model: "vios", body: "sedan", year: 2016, odo_km: 60000, transmission: "mt", region: "hcm" };

describe("ruleTitle", () => {
  test("cars: make model year + up to 2 extras", () => {
    expect(ruleTitle({ itemName: null, attributes: viosAttrs, schema: cars, isCar: true })).toBe("Toyota Vios 2016 · MT · 60.000 km");
  });
  test("cars: null when neither make nor model", () => {
    expect(ruleTitle({ itemName: null, attributes: { year: 2016 }, schema: cars, isCar: true })).toBeNull();
  });
  test("others: item name + key attrs", () => {
    expect(ruleTitle({ itemName: "MacBook Air", attributes: { chip: "m2", ram_gb: 16, ssd_gb: 256, line: "air" }, schema: mac, isCar: false })).toBe(
      "MacBook Air · M2 · 16GB · 256GB",
    );
    expect(ruleTitle({ itemName: null, attributes: { chip: "m2" }, schema: mac, isCar: false })).toBeNull();
  });
});

describe("acceptLlmTitle", () => {
  test("keeps a title whose digit runs occur in the text", () => {
    expect(acceptLlmTitle("Toyota Vios 2016 1.5E · số sàn", viosText, viosAttrs, cars)).toBe("Toyota Vios 2016 1.5E · số sàn");
  });
  test("rejects an invented year", () => {
    expect(acceptLlmTitle("Toyota Vios 2018 · số sàn", viosText, viosAttrs, cars)).toBeNull();
  });
  test("accepts digits that come from a rendered attribute value", () => {
    expect(acceptLlmTitle("Vios 60.000 km", "ban vios", { odo_km: 60000 }, cars)).toBe("Vios 60.000 km");
  });
  test("cuts a long title to <= 80 chars at a separator or word", () => {
    const long = `Toyota Vios 2016 · ${"số sàn rất đẹp ".repeat(8)}`.trim();
    const out = acceptLlmTitle(long, viosText, viosAttrs, cars);
    expect(out).not.toBeNull();
    expect((out as string).length).toBeLessThanOrEqual(MAX_TITLE);
    expect(acceptLlmTitle("  ", viosText, viosAttrs, cars)).toBeNull();
  });
  test("digit runs match whole runs only (phone digits / longer numbers do not vouch)", () => {
    expect(acceptLlmTitle("Vios 2018", "ban vios lh 0912018555", {}, cars)).toBeNull();
    expect(acceptLlmTitle("Vios 201", "ban vios doi 2016", {}, cars)).toBeNull();
    expect(acceptLlmTitle("Vios 2016", "ban vios doi 2016", {}, cars)).toBe("Vios 2016");
  });
  test("sanitises control chars and whitespace; rejects markup and URLs", () => {
    expect(acceptLlmTitle("Toyota\nVios \u0007  2016\t", viosText, viosAttrs, cars)).toBe("Toyota Vios 2016");
    expect(acceptLlmTitle("Vios <b>2016</b>", viosText, viosAttrs, cars)).toBeNull();
    expect(acceptLlmTitle("Vios 2016 https://x.example", viosText, viosAttrs, cars)).toBeNull();
    expect(acceptLlmTitle("Vios 2016 xe-ban.com", viosText, viosAttrs, cars)).toBeNull();
    expect(acceptLlmTitle("Vios 2016 www.foo", viosText, viosAttrs, cars)).toBeNull();
  });
});
