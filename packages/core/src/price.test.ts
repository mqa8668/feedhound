import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { detectMaskedPrice, isComparablePrice, isPhoneShapedPrice, isPriceGrounded, parsePrice, priceCandidates } from "./price";

const FIXTURE_PATH = fileURLToPath(new URL("../../../tests/fixtures/price-cases.json", import.meta.url));

interface PriceCase {
  text: string;
  priceVnd: number | null;
}

describe("parsePrice", () => {
  const cases = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as PriceCase[];

  test("fixture has at least 50 cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(50);
  });

  test("matches expected priceVnd on >= 95% of cases", () => {
    let matched = 0;
    const failures: string[] = [];
    for (const c of cases) {
      const result = parsePrice(c.text);
      if (result.priceVnd === c.priceVnd) {
        matched++;
      } else {
        failures.push(`"${c.text}": expected ${c.priceVnd}, got ${result.priceVnd}`);
      }
    }
    const rate = matched / cases.length;
    if (rate < 0.95) {
      console.log("parsePrice failures:", failures);
    }
    expect(rate).toBeGreaterThanOrEqual(0.95);
  });
});

describe("parsePrice: masked digit prices (Vietnamese marketplace convention)", () => {
  test("5x.000.000 -> lower bound 50000000, masked", () => {
    expect(parsePrice("e mới pick đc cây 18 pro max màu băng thanh giá 5x.000.000")).toMatchObject({
      priceVnd: 50_000_000,
      priceRaw: "5x.000.000",
      masked: true,
    });
  });

  test("1x.xxx.xxx -> lower bound 10000000, masked", () => {
    expect(parsePrice("gia 1x.xxx.xxx")).toMatchObject({
      priceVnd: 10_000_000,
      priceRaw: "1x.xxx.xxx",
      masked: true,
    });
  });

  test("5xtr -> lower bound 50000000, masked", () => {
    expect(parsePrice("ban 5xtr")).toMatchObject({ priceVnd: 50_000_000, priceRaw: "5xtr", masked: true });
  });

  test("2x triệu -> lower bound 20000000, masked", () => {
    expect(parsePrice("gia 2x triệu")).toMatchObject({ priceVnd: 20_000_000, priceRaw: "2x triệu", masked: true });
  });

  test("2xtr -> lower bound 20000000, masked", () => {
    expect(parsePrice("gia 2xtr")).toMatchObject({ priceVnd: 20_000_000, priceRaw: "2xtr", masked: true });
  });

  test("masked price with no separators (bare digits) -> lower bound, masked", () => {
    expect(parsePrice("gia 5x000000 dong")).toMatchObject({ priceVnd: 50_000_000, priceRaw: "5x000000", masked: true });
  });

  test("a bare run with an x but too short to be a masked price is not treated as one", () => {
    // e.g. "2x16" (RAM spec, "2x16GB") must not be mistaken for a masked price.
    expect(detectMaskedPrice("ram 2x16gb")).toBeNull();
  });

  test("unmasked prices are unaffected by the masked-price detector", () => {
    expect(detectMaskedPrice("gia 15tr")).toBeNull();
    expect(parsePrice("gia 15tr")).toMatchObject({ priceVnd: 15_000_000, priceRaw: "15tr" });
  });

  test("regression: normal unmasked prices keep parsing exactly as before", () => {
    expect(parsePrice("4tr5").priceVnd).toBe(4_500_000);
    expect(parsePrice("24.000.000").priceVnd).toBe(24_000_000);
    // "19tr500" is 19.5tr in the current parser; "8>10m" stays unsupported.
    expect(parsePrice("8>10m").priceVnd).toBeNull();
  });

  describe("sanity checks (phones, years, bounds)", () => {
    test("phone number with spaces / dots is not a price", () => {
      expect(parsePrice("Thu iPhone cũ tận nhà giá cao TP HCM 0982 990 099").priceVnd).toBeNull();
      expect(parsePrice("Thu iPhone cũ tận nhà giá cao TP HCM 0982.990.099").priceVnd).toBeNull();
      expect(parsePrice("liên hệ +84 982 990 099").priceVnd).toBeNull();
      expect(parsePrice("iPhone X 0354.305.693").priceVnd).toBeNull();
    });
    test("9-digit run after contact keyword without unit is not a price", () => {
      expect(parsePrice("zalo: 982.990.099").priceVnd).toBeNull();
      expect(parsePrice("LH 354305693").priceVnd).toBeNull();
    });
    test("years are not prices", () => {
      expect(parsePrice("iPhone 2.019").priceVnd).toBeNull();
      expect(parsePrice("đời 2027").priceVnd).toBeNull();
      expect(parsePrice("2019").priceVnd).toBeNull();
    });
    test("out-of-range values are rejected", () => {
      expect(parsePrice("giá 6.000.000.000đ").priceVnd).toBeNull();
      expect(parsePrice("giá 500đ").priceVnd).toBeNull();
    });
    test("real price next to a phone number is picked", () => {
      expect(parsePrice("iPhone 12 giá 17.900.000đ lh 0982 990 099").priceVnd).toBe(17_900_000);
      expect(parsePrice("sđt 0982.990.099 bán 17.900.000đ").priceVnd).toBe(17_900_000);
      expect(parsePrice("iPhone đời 2019 giá 6tr").priceVnd).toBe(6_000_000);
    });
  });

  describe("phone-like 9-digit values", () => {
    test("unmarked phone without leading 0 is not a price", () => {
      expect(parsePrice("liên hệ 952.941.444").priceVnd).toBeNull();
      expect(parsePrice("354.305.693").priceVnd).toBeNull();
    });
    test("round unmarked and explicit-marker prices still parse", () => {
      expect(parsePrice("Bán xe 195.000.000").priceVnd).toBe(195_000_000);
      expect(parsePrice("giá 952.941.444đ").priceVnd).toBe(952_941_444);
    });
  });

  describe("tỷ units", () => {
    test("1 tỷ 2, 1,2 tỷ, 1ty250, 3 tỷ", () => {
      expect(parsePrice("Bán Mercedes giá 1 tỷ 2").priceVnd).toBe(1_200_000_000);
      expect(parsePrice("giá 1,2 tỷ").priceVnd).toBe(1_200_000_000);
      expect(parsePrice("giá 1ty250").priceVnd).toBe(1_250_000_000);
      expect(parsePrice("giá 3 tỷ").priceVnd).toBe(3_000_000_000);
    });
    test("5 tỷ cap: above is rejected", () => {
      expect(parsePrice("giá 6 tỷ").priceVnd).toBeNull();
    });
  });

  describe("isPhoneShapedPrice", () => {
    test("9 unmarked digits not ending in 000", () => {
      expect(isPhoneShapedPrice("952.941.444")).toBe(true);
      expect(isPhoneShapedPrice("952941444")).toBe(true);
      expect(isPhoneShapedPrice("185.000.000")).toBe(false);
      expect(isPhoneShapedPrice("952.941.444đ")).toBe(false);
      expect(isPhoneShapedPrice(null)).toBe(false);
    });
    test("parsePrice keeps the raw text of a phone-shaped number but no price", () => {
      expect(parsePrice("Vios 2017 giá 952.941.444")).toMatchObject({ priceVnd: null, priceRaw: "952.941.444" });
    });
  });
});

describe("review r1: củ / tỷ forms", () => {
  test("củ is triệu", () => {
    expect(parsePrice("Vios 2016 giá 185 củ").priceVnd).toBe(185_000_000);
    expect(parsePrice("giá 9,5 củ").priceVnd).toBe(9_500_000);
    expect(parsePrice("Vios 2016 giá 185 củ, 909.123.456 Tuấn").priceVnd).toBe(185_000_000);
  });
  test("tỷ followed by triệu is millions; tỉ folds to tỷ", () => {
    expect(parsePrice("giá 1 tỷ 200 triệu").priceVnd).toBe(1_200_000_000);
    expect(parsePrice("giá 1 tỷ 200tr").priceVnd).toBe(1_200_000_000);
    expect(parsePrice("giá 1 tỉ 2").priceVnd).toBe(1_200_000_000);
    expect(parsePrice("giá 1 tỷ 2").priceVnd).toBe(1_200_000_000);
  });
});

describe("parsePrice: qualifiers, roles, 19tr500", () => {
  test("floor: hơn 200 triệu", () => {
    expect(parsePrice("Kia Morning bán hơn 200 triệu")).toMatchObject({ priceVnd: 200_000_000, qualifier: "floor", confidence: 0.5 });
  });
  test("ceiling: dưới 200tr", () => {
    expect(parsePrice("Kia Morning dưới 200tr")).toMatchObject({ priceVnd: 200_000_000, qualifier: "ceiling" });
  });
  test("approx: tầm / khoảng 350tr", () => {
    for (const t of ["xe tầm 350tr", "xe khoảng 350tr"]) {
      expect(parsePrice(t)).toMatchObject({ priceVnd: 350_000_000, qualifier: "approx", confidence: 0.6 });
    }
  });
  test("range: giá 180-200tr", () => {
    expect(parsePrice("giá 180-200tr")).toMatchObject({ priceVnd: 180_000_000, maxVnd: 200_000_000, qualifier: "range" });
  });
  test("19tr500 is 19.5tr, exact", () => {
    expect(parsePrice("iphone 16 Pro Max 19tr500")).toMatchObject({ priceVnd: 19_500_000, qualifier: "exact" });
    expect(parsePrice("bán 19 triệu 500")).toMatchObject({ priceVnd: 19_500_000 });
    expect(parsePrice("bán 19tr5")).toMatchObject({ priceVnd: 19_500_000 });
  });
  test("1,1 tỷ stays 1.1 tỷ", () => {
    expect(parsePrice("Lexus ES250 2016 giá 1,1 tỷ")).toMatchObject({ priceVnd: 1_100_000_000, qualifier: "exact" });
  });
  test("asking price wins over deposit", () => {
    expect(parsePrice("Toyota Rush 2019 trả trước 50tr bán 390tr")).toMatchObject({
      priceVnd: 390_000_000,
      confidence: 0.9,
    });
    const roles = priceCandidates("Toyota Rush 2019 trả trước 50tr bán 390tr").map((c) => c.role);
    expect(roles).toEqual(["excluded", "asking"]);
  });
  test("only excluded amounts -> null price, confidence 0", () => {
    expect(parsePrice("đã cọc 20tr")).toMatchObject({ priceVnd: null, qualifier: null, confidence: 0, priceRaw: "20tr" });
  });
  test("masked -> floor", () => {
    expect(parsePrice("5x.000.000")).toMatchObject({ priceVnd: 50_000_000, qualifier: "floor", masked: true, confidence: 0.5 });
  });
  test("isComparablePrice", () => {
    expect(isComparablePrice("exact", 0.7)).toBe(true);
    expect(isComparablePrice("approx", 0.6)).toBe(true);
    expect(isComparablePrice("floor", 0.9)).toBe(false);
    expect(isComparablePrice("exact", 0.5)).toBe(false);
    expect(isComparablePrice(null, null)).toBe(false);
  });
});

describe("parsePrice: tỷ prefix is never dropped (051 regression)", () => {
  test("masked 1 tỷ 1XX triệu -> range 1.1B-1.199B", () => {
    expect(parsePrice("Kia Carnival Giá 1 tỷ 1XX triệu")).toMatchObject({
      priceVnd: 1_100_000_000,
      maxVnd: 1_199_999_999,
      qualifier: "range",
      masked: true,
    });
    expect(parsePrice("Kia Carnival Giá 1 tỷ 1XX triệu").confidence).toBeLessThan(0.9);
  });
  test("1 tỷ 2 / 1ty150 / 1,1 tỷ", () => {
    expect(parsePrice("giá 1 tỷ 2").priceVnd).toBe(1_200_000_000);
    expect(parsePrice("giá 1ty150").priceVnd).toBe(1_150_000_000);
    expect(parsePrice("giá 1,1 tỷ").priceVnd).toBe(1_100_000_000);
  });
});

describe("parsePrice: edge cases", () => {
  const one = (t: string) => {
    const p = parsePrice(t);
    return [p.priceVnd, p.qualifier];
  };
  test("'Pro Max' is not a ceiling cue, even at the qualifier window edge", () => {
    expect(one("Bán iPhone 14 Pro Max 128gb 15tr")).toEqual([15_000_000, "exact"]);
    expect(one("giá max 15tr")).toEqual([15_000_000, "ceiling"]);
  });
  test("'lượng' in dung lượng / chất lượng is not a salary cue", () => {
    expect(one("iPhone 15 dung lượng 256GB 15tr")[0]).toBe(15_000_000);
    expect(one("Bán xe chất lượng 350tr")[0]).toBe(350_000_000);
    expect(parsePrice("lương 15tr").priceVnd).toBeNull();
  });
  test("masked tỷ does not swallow the x of a word", () => {
    expect(one("Bán Lexus giá 1 tỷ xe đẹp")).toEqual([1_000_000_000, "exact"]);
  });
  test("19tr500 rule rejects a space-separated count tail", () => {
    expect(one("giá 450tr 1 chủ từ đầu")).toEqual([450_000_000, "exact"]);
    expect(one("giá 450tr 2 đời chủ")[0]).toBe(450_000_000);
    expect(parsePrice("giá 19tr500").priceVnd).toBe(19_500_000);
    expect(parsePrice("giá 19 triệu 500").priceVnd).toBe(19_500_000);
  });
  test("a date or model number before a dash is not a range start", () => {
    expect(one("Mazda 3 - 550tr")).toEqual([550_000_000, "exact"]);
    expect(one("đời 2019 - 450tr")).toEqual([450_000_000, "exact"]);
    expect(one("Vios 2017 - 380tr")).toEqual([380_000_000, "exact"]);
    expect(one("xe 7 chỗ - 650tr")).toEqual([650_000_000, "exact"]);
  });
  test("a small-start range with a large end stays a range", () => {
    expect(one("giá 5-60tr")).toEqual([5_000_000, "range"]);
    expect(one("giá 90-950k")).toEqual([90_000, "range"]);
    expect(one("5 - 7tr")[1]).toBe("range");
    expect(one("180-200tr")[1]).toBe("range");
  });
  test("'lượng' in số lượng / trong lượng / khối lượng is not a salary cue", () => {
    expect(one("số lượng 2 cái 15tr")[0]).toBe(15_000_000);
    expect(one("khối lượng 2kg 15tr")[0]).toBe(15_000_000);
  });
  test("isPriceGrounded does not ground billions by their leading digit", () => {
    expect(isPriceGrounded("giá 1 tỷ 200", 1_500_000_000)).toBe(false);
    expect(isPriceGrounded("giá 1 tỷ", 1_000_000_000)).toBe(false);
  });
  test("a 40k-digit input is capped and parses in < 50 ms", () => {
    const t0 = performance.now();
    parsePrice(`${"1".repeat(40_000)} - ${"2".repeat(40_000)}tr`);
    parsePrice(`${"9".repeat(40_000)}`);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});
