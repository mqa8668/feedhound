import { AsyncLocalStorage } from "node:async_hooks";
import { createLogger } from "./logger";

/** Label names any metric may use; source-neutral, low-cardinality. */
export const ALLOWED_LABELS = ["route", "status", "source", "outcome", "capture", "kind", "queue", "state", "collector"] as const;
export type Labels = Partial<Record<(typeof ALLOWED_LABELS)[number], string>>;
export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";
export const SLO_TARGETS = { coverageOk: 0.98, coverageComplete: 0.95, windowHours: 24 } as const;

export interface Counter {
  inc(labels?: Labels, by?: number): void;
}
export interface Gauge {
  set(labels: Labels | undefined, value: number): void;
}
export interface MetricsRegistry {
  counter(name: string, help: string, labelNames: readonly string[]): Counter;
  gauge(name: string, help: string, labelNames: readonly string[]): Gauge;
  /** Sets gauges before each render. */
  collector(name: string, fn: () => Promise<void>): void;
  render(): Promise<string>;
  names(): { name: string; type: "counter" | "gauge"; labelNames: readonly string[] }[];
}

const NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const allowed: readonly string[] = ALLOWED_LABELS;
const logger = createLogger({ service: "metrics" });

interface Metric {
  name: string;
  help: string;
  type: "counter" | "gauge";
  labelNames: readonly string[];
  samples: Map<string, number>; // rendered label string -> value (published)
}

/** Gauge writes made while one collector runs; discarded if that collector fails or times out. */
type Buffer = Map<Metric, Map<string, number>>;

function escapeValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function labelKey(m: Metric, labels: Labels | undefined): string {
  const entries = Object.entries(labels ?? {}).filter((e): e is [string, string] => e[1] !== undefined);
  for (const [k] of entries) {
    if (!m.labelNames.includes(k)) throw new Error(`metric ${m.name}: undeclared label "${k}"`);
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) return "";
  return `{${entries.map(([k, v]) => `${k}="${escapeValue(v)}"`).join(",")}}`;
}

/**
 * `collectTimeoutMs` bounds each collector (default 2 s). Collected gauge values are cached for
 * `cacheTtlMs` (default 15 s) and concurrent renders share one in-flight collection; counters are
 * always rendered live.
 */
export function createRegistry(opts: { collectTimeoutMs?: number; cacheTtlMs?: number } = {}): MetricsRegistry {
  const timeoutMs = opts.collectTimeoutMs ?? 2_000;
  const cacheTtlMs = opts.cacheTtlMs ?? 15_000;
  const metrics = new Map<string, Metric>();
  const collectors: { name: string; fn: () => Promise<void> }[] = [];
  const scope = new AsyncLocalStorage<Buffer>();

  function define(name: string, help: string, type: Metric["type"], labelNames: readonly string[]): Metric {
    if (!NAME_RE.test(name)) throw new Error(`invalid metric name "${name}"`);
    if (metrics.has(name)) throw new Error(`duplicate metric "${name}"`);
    for (const l of labelNames) {
      if (!allowed.includes(l)) throw new Error(`metric ${name}: label "${l}" is not allowed`);
    }
    const m: Metric = { name, help, type, labelNames, samples: new Map() };
    metrics.set(name, m);
    return m;
  }

  const up = define("metrics_collector_up", "1 if the collector ran within its timeout, else 0", "gauge", ["collector"]);

  async function runCollector(name: string, fn: () => Promise<void>): Promise<Buffer | undefined> {
    const buffer: Buffer = new Map();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        scope.run(buffer, fn),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`collector timed out after ${timeoutMs} ms`)), timeoutMs);
        }),
      ]);
      return buffer;
    } catch (err) {
      logger.warn({ err, collector: name }, "metrics collector failed");
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Runs every collector, then swaps the published gauge samples in one step. */
  async function collect(): Promise<void> {
    const results = await Promise.all(collectors.map(async (c) => ({ name: c.name, buffer: await runCollector(c.name, c.fn) })));
    const next = new Map<Metric, Map<string, number>>();
    for (const m of metrics.values()) if (m.type === "gauge") next.set(m, new Map());
    for (const { name, buffer } of results) {
      next.get(up)!.set(labelKey(up, { collector: name }), buffer ? 1 : 0);
      if (!buffer) continue;
      for (const [m, samples] of buffer) for (const [k, v] of samples) next.get(m)!.set(k, v);
    }
    for (const [m, samples] of next) m.samples = samples;
  }

  let inFlight: Promise<void> | undefined;
  let collectedAt = Number.NEGATIVE_INFINITY;

  function ensureCollected(): Promise<void> {
    if (inFlight) return inFlight;
    if (Date.now() - collectedAt < cacheTtlMs) return Promise.resolve();
    inFlight = collect()
      .then(() => {
        collectedAt = Date.now();
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  }

  return {
    counter(name, help, labelNames) {
      const m = define(name, help, "counter", labelNames);
      if (labelNames.length === 0) m.samples.set("", 0);
      return {
        inc(labels, by = 1) {
          const key = labelKey(m, labels);
          m.samples.set(key, (m.samples.get(key) ?? 0) + by);
        },
      };
    },
    gauge(name, help, labelNames) {
      const m = define(name, help, "gauge", labelNames);
      return {
        set(labels, value) {
          const key = labelKey(m, labels);
          const buffer = scope.getStore();
          if (!buffer) {
            m.samples.set(key, value);
            return;
          }
          let samples = buffer.get(m);
          if (!samples) buffer.set(m, (samples = new Map()));
          samples.set(key, value);
        },
      };
    },
    collector(name, fn) {
      collectors.push({ name, fn });
    },
    async render() {
      await ensureCollected();
      const lines: string[] = [];
      for (const m of metrics.values()) {
        lines.push(`# HELP ${m.name} ${m.help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n")}`, `# TYPE ${m.name} ${m.type}`);
        for (const key of [...m.samples.keys()].sort()) lines.push(`${m.name}${key} ${m.samples.get(key)}`);
      }
      return `${lines.join("\n")}\n`;
    },
    names() {
      return [...metrics.values()].map((m) => ({ name: m.name, type: m.type, labelNames: m.labelNames }));
    },
  };
}
