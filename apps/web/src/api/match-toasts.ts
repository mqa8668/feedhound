// Pure burst aggregator for `match.new` WS frames.
// The first frame of a burst opens a toast immediately (`isNew: true`); every
// further frame inside the same 5 s window updates that same toast in place
// (`isNew: false`) instead of waiting for the window to close. A frame that
// arrives after the window has elapsed starts a new burst (a new toast).
// Match toasts live 10 s (other toasts keep 5 s) and navigate on
// click (single frame: the post permalink, else the inbox). No React/WS imports — unit-tested with fake timers in
// match-toasts.test.ts.

export const MATCH_BURST_WINDOW_MS = 5000;
export const MATCH_TOAST_TTL_MS = 10000;

export interface MatchFrameInput {
  watchId: string;
  postId: string;
  title: string;
}

/** Current state of one burst: what the toast shows and where clicking it goes. */
export interface MatchBurst {
  count: number;
  /** Unique watch ids in the burst, in arrival order. */
  watchIds: string[];
  /** Post ids in arrival order (one per frame). */
  postIds: string[];
  firstTitle: string;
  label: string;
  /** True only for the frame that opens the burst — the caller creates a toast; false updates it in place. */
  isNew: boolean;
}

export interface MatchBurstCollector {
  push: (frame: MatchFrameInput, now?: number) => void;
  dispose: () => void;
}

export function createMatchBurstCollector(options: {
  onBurst: (burst: MatchBurst) => void;
  /** Fires once per window that actually held frames, when the window closes (timer fires or a later frame starts a new burst) — never on `dispose()`. Callers use this to invalidate the matches list at most once per burst. */
  onWindowFlush?: () => void;
  windowMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}): MatchBurstCollector {
  const { onBurst, onWindowFlush, windowMs = MATCH_BURST_WINDOW_MS, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = options;

  let open: { firstAt: number; frames: MatchFrameInput[] } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const closeWindow = (notify: boolean) => {
    clearTimeoutFn(timer);
    timer = undefined;
    const hadFrames = open !== null && open.frames.length > 0;
    open = null;
    if (notify && hadFrames) onWindowFlush?.();
  };

  const emit = (frames: MatchFrameInput[], isNew: boolean) => {
    const watchIds = [...new Set(frames.map((f) => f.watchId))];
    onBurst({
      count: frames.length,
      watchIds,
      postIds: frames.map((f) => f.postId),
      firstTitle: frames[0]!.title,
      label: frames.length === 1 ? "New match" : `New matches (${frames.length})`,
      isNew,
    });
  };

  return {
    push(frame, now = Date.now()) {
      if (open && now - open.firstAt > windowMs) {
        // The window elapsed while idle (no timer work needed in tests that
        // never advance clocks): close it, then start a fresh burst below.
        closeWindow(true);
      }
      if (!open) {
        open = { firstAt: now, frames: [frame] };
        timer = setTimeoutFn(() => closeWindow(true), windowMs);
        emit(open.frames, true);
        return;
      }
      open.frames.push(frame);
      emit(open.frames, false);
    },
    dispose() {
      closeWindow(false);
    },
  };
}

/** A single-frame burst opens its post; single-watch bursts deep-link to that watch's filtered inbox; mixed bursts to the inbox root. */
export function matchBurstHref(burst: Pick<MatchBurst, "count" | "watchIds" | "postIds">): string {
  if (burst.count === 1 && burst.postIds[0]) return `/posts/${encodeURIComponent(burst.postIds[0])}`;
  return burst.watchIds.length === 1 ? `/matches?watch=${encodeURIComponent(burst.watchIds[0]!)}` : "/matches";
}
