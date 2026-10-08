import type { Logger } from "pino";

export type ShutdownFn = () => Promise<void> | void;

interface Hook {
  name: string;
  fn: ShutdownFn;
  timeoutMs: number;
}

const DEFAULT_HOOK_TIMEOUT_MS = 5_000;

const hooks: Hook[] = [];
let shuttingDown = false;
let shutdownPromise: Promise<0 | 1> | undefined;

/** Registers a hook run (in registration order, FIFO) by `runShutdown`. */
export function onShutdown(name: string, fn: ShutdownFn, opts?: { timeoutMs?: number }): void {
  hooks.push({ name, fn, timeoutMs: opts?.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS });
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

function withTimeout(fn: ShutdownFn, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`shutdown hook timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    Promise.resolve()
      .then(() => fn())
      .then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      })
      .catch((err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
  });
}

/**
 * Runs every registered hook sequentially in registration order, each
 * bounded by its own `timeoutMs`. A throwing/timed-out hook is logged and
 * the next hook still runs. Idempotent: a second call returns the first
 * call's promise. Resolves `0` if every hook resolved in time, else `1`.
 */
export function runShutdown(reason: string, logger?: Logger): Promise<0 | 1> {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = (async () => {
    let ok = true;
    for (const hook of hooks) {
      try {
        await withTimeout(hook.fn, hook.timeoutMs);
      } catch (err) {
        ok = false;
        logger?.error({ err, hook: hook.name, reason }, "shutdown hook failed");
      }
    }
    return ok ? 0 : 1;
  })();
  return shutdownPromise;
}

/**
 * Installs SIGTERM/SIGINT handlers that trigger `runShutdown` once. A hard
 * deadline timer forces `exit(1)` if hooks have not all settled by then.
 * Further signals after the first are logged and ignored.
 */
export function installShutdownHandlers(opts: { logger: Logger; hardDeadlineMs: number; exit?: (code: number) => never }): void {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let handling = false;

  const onSignal = (signal: string) => {
    if (handling) {
      opts.logger.warn({ signal }, "shutdown already in progress; ignoring signal");
      return;
    }
    handling = true;
    opts.logger.info({ signal }, "shutdown: signal received");

    const hardTimer = setTimeout(() => {
      opts.logger.error("shutdown: hard deadline exceeded; forcing exit(1)");
      exit(1);
    }, opts.hardDeadlineMs);
    // Bun/Node keep the process alive while a timer is pending; this timer
    // must not itself block a clean exit once shutdown finishes in time.
    if (typeof hardTimer.unref === "function") hardTimer.unref();

    void runShutdown(signal, opts.logger).then((code) => {
      clearTimeout(hardTimer);
      exit(code);
    });
  };

  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));
}

/**
 * Runs `attempt` up to `delaysMs.length + 1` times, waiting `delaysMs[n]`
 * between attempt `n+1` and `n+2`. Rejects with the last error once every
 * attempt has failed.
 */
export async function bootWithRetry<T>(
  attempt: (n: number) => Promise<T>,
  opts: { delaysMs: number[]; logger: Logger; onFail?: (err: unknown, n: number) => Promise<void> },
): Promise<T> {
  const totalAttempts = opts.delaysMs.length + 1;
  let lastErr: unknown;
  for (let n = 1; n <= totalAttempts; n++) {
    try {
      return await attempt(n);
    } catch (err) {
      lastErr = err;
      opts.logger.warn({ err, attempt: n, totalAttempts }, "boot attempt failed");
      if (opts.onFail) await opts.onFail(err, n);
      if (n < totalAttempts) {
        const delay = opts.delaysMs[n - 1] ?? 0;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

const DEFAULT_BOOT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];

/** `BOOT_RETRY_DELAYS_MS="a,b,..."` (tests only) else the default 5-step ladder. */
export function bootDelaysFromEnv(): number[] {
  const raw = process.env.BOOT_RETRY_DELAYS_MS;
  if (!raw) return DEFAULT_BOOT_DELAYS_MS;
  const parsed = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0);
  return parsed.length > 0 ? parsed : DEFAULT_BOOT_DELAYS_MS;
}

/** Test-only: clears registered hooks and shutdown state between test cases. */
export function __resetShutdownForTests(): void {
  hooks.length = 0;
  shuttingDown = false;
  shutdownPromise = undefined;
}
