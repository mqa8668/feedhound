import { describe, expect, test } from "bun:test";
import { createRegistry } from "./metrics";

describe("metrics registry", () => {
  test("renders counters, escaped gauge labels, no stale gauge samples", async () => {
    const r = createRegistry({ cacheTtlMs: 0 });
    const c = r.counter("c", "a counter", ["route", "status"]);
    c.inc({ route: "/x", status: "200" });
    c.inc({ route: "/x", status: "200" });
    const g = r.gauge("g", "a gauge", ["source"]);
    let first = true;
    r.collector("k", async () => {
      g.set({ source: first ? 'a"b\n' : "other" }, 1);
      first = false;
    });
    const out1 = await r.render();
    expect(out1.match(/# HELP c /g)?.length).toBe(1);
    expect(out1.match(/# TYPE c counter/g)?.length).toBe(1);
    expect(out1).toContain('c{route="/x",status="200"} 2');
    expect(out1).toContain('g{source="a\\"b\\n"} 1');
    expect(out1).toContain('metrics_collector_up{collector="k"} 1');
    const out2 = await r.render();
    expect(out2).not.toContain('a\\"b');
    expect(out2).toContain('g{source="other"} 1');
  });

  test("rejects bad definitions and undeclared labels", () => {
    const r = createRegistry();
    expect(() => r.gauge("bad name", "h", [])).toThrow();
    expect(() => r.gauge("p", "h", ["path"])).toThrow();
    const c = r.counter("ok_total", "h", ["route"]);
    expect(() => c.inc({ status: "200" })).toThrow();
    expect(() => r.counter("ok_total", "h", [])).toThrow();
  });

  test("failing and hanging collectors yield up 0, others still render", async () => {
    const r = createRegistry({ collectTimeoutMs: 50, cacheTtlMs: 0 });
    const g = r.gauge("good", "h", []);
    r.collector("good", async () => g.set(undefined, 7));
    r.collector("x", async () => {
      throw new Error("boom");
    });
    r.collector("slow", () => new Promise<void>(() => {}));
    const out = await r.render();
    expect(out).toContain('metrics_collector_up{collector="x"} 0');
    expect(out).toContain('metrics_collector_up{collector="slow"} 0');
    expect(out).toContain('metrics_collector_up{collector="good"} 1');
    expect(out).toContain("good 7");
  });

  test("concurrent renders share one collection; result is cached within the TTL", async () => {
    const r = createRegistry({ cacheTtlMs: 60_000 });
    const g = r.gauge("g", "h", []);
    let runs = 0;
    r.collector("k", async () => {
      runs++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      g.set(undefined, runs);
    });
    const [a, b, c] = await Promise.all([r.render(), r.render(), r.render()]);
    expect(runs).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    await r.render();
    expect(runs).toBe(1);
  });

  test("a timed-out collector reports up 0 and its late writes never reach a later render", async () => {
    const r = createRegistry({ collectTimeoutMs: 30, cacheTtlMs: 0 });
    const g = r.gauge("late", "h", []);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    r.collector("slow", async () => {
      if (first) {
        first = false;
        await gate;
        g.set(undefined, 99); // lands after the timeout
        return;
      }
    });
    const out1 = await r.render();
    expect(out1).toContain('metrics_collector_up{collector="slow"} 0');
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const out2 = await r.render();
    expect(out2).toContain('metrics_collector_up{collector="slow"} 1');
    expect(out2).not.toContain("late 99");
    expect(out1).not.toContain("late 99");
  });
});
