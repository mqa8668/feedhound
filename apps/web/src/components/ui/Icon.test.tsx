import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { render } from "@testing-library/react";
import { Inbox } from "lucide-react";
import { describe, expect, test } from "vitest";
import { Icon } from "./Icon";

describe("Icon", () => {
  test("16px, stroke 1.6, muted, aria-hidden", () => {
    const { container } = render(createElement(Icon, { icon: Inbox }));
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("16");
    expect(svg.getAttribute("height")).toBe("16");
    expect(svg.getAttribute("stroke-width")).toBe("1.6");
    expect(svg.getAttribute("class")).toContain("text-muted-foreground");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
  });
  test("tone bad", () => {
    const { container } = render(createElement(Icon, { icon: Inbox, tone: "bad" }));
    expect(container.querySelector("svg")!.getAttribute("class")).toContain("text-bad");
  });
  test("lucide-react is the only icon package", () => {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "../../../package.json"), "utf8")) as { dependencies?: Record<string, string> };
    const icons = Object.keys(pkg.dependencies ?? {}).filter((d) => /icon|lucide|heroicons|phosphor|tabler|fontawesome/i.test(d));
    expect(icons).toEqual(["lucide-react"]);
  });
});
