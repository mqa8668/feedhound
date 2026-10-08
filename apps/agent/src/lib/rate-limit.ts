/**
 * In-process token buckets for the Telegram send rate limits: 1 msg/s and 20/min per chat, 25/s global. An empty
 * bucket waits (never fails) — callers `await acquire(chatId)` before
 * calling `Notifier.send`. Clock is injectable so tests can drive it with a
 * fake `now()`/`sleep()` instead of real wall-clock waits.
 */

export interface RateLimiterOptions {
  perChatPerSec: number;
  perChatPerMin: number;
  globalPerSec: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface Bucket {
  /** timestamps (ms) of sends within the last window, oldest first. */
  sec: number[];
  min: number[];
}

export class RateLimiter {
  private readonly perChatPerSec: number;
  private readonly perChatPerMin: number;
  private readonly globalPerSec: number;
  private readonly now: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly chatBuckets = new Map<number, Bucket>();
  private readonly globalBucket: number[] = [];
  /** chatId -> ms timestamp until which this chat's bucket is paused (429 backoff). */
  private readonly pausedUntil = new Map<number, number>();

  constructor(opts: RateLimiterOptions) {
    this.perChatPerSec = opts.perChatPerSec;
    this.perChatPerMin = opts.perChatPerMin;
    this.globalPerSec = opts.globalPerSec;
    this.now = opts.now ?? (() => Date.now());
    this.sleepFn = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Pauses this chat's bucket for `ms` (429 handling). */
  pause(chatId: number, ms: number): void {
    const until = this.now() + ms;
    const existing = this.pausedUntil.get(chatId) ?? 0;
    if (until > existing) this.pausedUntil.set(chatId, until);
  }

  /** Resolves once it is safe to send to `chatId`, and records the send. */
  async acquire(chatId: number): Promise<void> {
    for (;;) {
      const now = this.now();
      const pausedUntil = this.pausedUntil.get(chatId) ?? 0;
      if (pausedUntil > now) {
        await this.sleepFn(pausedUntil - now);
        continue;
      }

      const bucket = this.getBucket(chatId);
      prune(bucket.sec, now, 1_000);
      prune(bucket.min, now, 60_000);
      prune(this.globalBucket, now, 1_000);

      const waits: number[] = [];
      if (bucket.sec.length >= this.perChatPerSec) waits.push(bucket.sec[0]! + 1_000 - now);
      if (bucket.min.length >= this.perChatPerMin) waits.push(bucket.min[0]! + 60_000 - now);
      if (this.globalBucket.length >= this.globalPerSec) waits.push(this.globalBucket[0]! + 1_000 - now);

      if (waits.length === 0) {
        bucket.sec.push(now);
        bucket.min.push(now);
        this.globalBucket.push(now);
        return;
      }
      await this.sleepFn(Math.max(1, Math.max(...waits)));
    }
  }

  private getBucket(chatId: number): Bucket {
    let bucket = this.chatBuckets.get(chatId);
    if (!bucket) {
      bucket = { sec: [], min: [] };
      this.chatBuckets.set(chatId, bucket);
    }
    return bucket;
  }
}

function prune(timestamps: number[], now: number, windowMs: number): void {
  while (timestamps.length > 0 && timestamps[0]! <= now - windowMs) timestamps.shift();
}
