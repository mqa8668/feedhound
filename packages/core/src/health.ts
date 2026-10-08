export type CheckResult = "ok" | "fail";
export type ReadinessChecks = Record<string, () => Promise<boolean> | boolean>;

const DEFAULT_TIMEOUT_MS = 1_000;

async function runOne(check: () => Promise<boolean> | boolean, timeoutMs: number): Promise<CheckResult> {
  try {
    const ok = await Promise.race([
      Promise.resolve().then(() => check()),
      new Promise<boolean>((_resolve, reject) => setTimeout(() => reject(new Error("readiness check timed out")), timeoutMs)),
    ]);
    return ok ? "ok" : "fail";
  } catch {
    return "fail";
  }
}

/** Runs every named readiness check (each bounded by `timeoutMs`, default 1s) in parallel. */
export async function runReadiness(checks: ReadinessChecks, opts?: { timeoutMs?: number }): Promise<{ ok: boolean; checks: Record<string, CheckResult> }> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const names = Object.keys(checks);
  const results = await Promise.all(names.map((name) => runOne(checks[name]!, timeoutMs)));
  const out: Record<string, CheckResult> = {};
  names.forEach((name, i) => {
    out[name] = results[i]!;
  });
  return { ok: results.every((r) => r === "ok"), checks: out };
}
