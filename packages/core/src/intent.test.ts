import { describe, expect, test } from "bun:test";
import { detectIntent } from "./intent";

describe("detectIntent", () => {
  test("earliest cue wins; a seller addressing buyers is a sale", () => {
    expect(detectIntent("cần bán kia morning, ai cần mua ib").intent).toBe("sell");
    expect(detectIntent("ban xe, ai co nhu cau lien he").intent).toBe("sell");
  });
  test("buy cues", () => {
    expect(detectIntent("cần mua vios 2016").intent).toBe("buy");
    expect(detectIntent("thu mua xe cũ giá cao").intent).toBe("buy");
    expect(detectIntent("cần mua xe, ai bán ib").intent).toBe("buy");
  });
  test("bare mua is a weak buy; no cue is other", () => {
    expect(detectIntent("mua iphone").confidence).toBe(0.55);
    expect(detectIntent("hello world").intent).toBe("other");
  });
});
