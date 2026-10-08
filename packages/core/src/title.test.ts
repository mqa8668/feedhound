import { describe, expect, test } from "bun:test";
import { splitTitle } from "./title";

describe("splitTitle", () => {
  test("a joined multi-line title consumes its source lines; the rest keeps the others", () => {
    expect(splitTitle("ạh\nSantafe 2019 máy dầu\n\ngiá 680tr thương lượng\nliên hệ 09xx")).toEqual({
      title: "ạh · Santafe 2019 máy dầu · giá 680tr thương lượng",
      rest: "liên hệ 09xx",
    });
  });
  test("a long single line keeps the cut tail in rest; empty text gives empty parts", () => {
    const line = "x".repeat(100);
    expect(splitTitle(`${line}\nnext`)).toEqual({ title: "x".repeat(80), rest: `${"x".repeat(20)}\nnext` });
    expect(splitTitle("\n \n")).toEqual({ title: "", rest: "" });
  });
});
