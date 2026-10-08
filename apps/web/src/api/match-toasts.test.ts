import { useRef } from "react";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";
import { ToastProvider, useToast } from "@/components/ui/toast";
import { createMatchBurstCollector, MATCH_BURST_WINDOW_MS, MATCH_TOAST_TTL_MS, matchBurstHref, type MatchBurst, type MatchFrameInput } from "./match-toasts";

// aggregation + navigation target: Fake timers drive the 5 s window.
describe("createMatchBurstCollector", () => {
  let bursts: MatchBurst[];
  let collector: ReturnType<typeof createMatchBurstCollector>;

  beforeEach(() => {
    vi.useFakeTimers();
    bursts = [];
    collector = createMatchBurstCollector({ onBurst: (b) => bursts.push(b) });
  });

  afterEach(() => {
    collector.dispose();
    vi.useRealTimers();
  });

  test("3 frames for one watch within 5 s: exactly one toast is opened, updated in place, ending 'New matches (3)'", () => {
    collector.push({ watchId: "w1", postId: "p1", title: "First" }, 0);
    expect(bursts).toHaveLength(1);
    expect(bursts[0]).toMatchObject({ count: 1, isNew: true, label: "New match" });

    collector.push({ watchId: "w1", postId: "p1", title: "Second" }, 1000);
    collector.push({ watchId: "w1", postId: "p1", title: "Third" }, 2000);
    // Still one toast — the first frame opened it, the rest updated it.
    expect(bursts.filter((b) => b.isNew)).toHaveLength(1);
    expect(bursts).toHaveLength(3);

    const last = bursts.at(-1)!;
    expect(last).toMatchObject({ count: 3, watchIds: ["w1"], firstTitle: "First", label: "New matches (3)", isNew: false });

    vi.advanceTimersByTime(MATCH_BURST_WINDOW_MS);
    expect(bursts).toHaveLength(3); // the window closing itself does not emit another burst
  });

  test("a frame 6 s after the first opens a new toast", () => {
    collector.push({ watchId: "w1", postId: "p1", title: "First" }, 0);
    collector.push({ watchId: "w1", postId: "p1", title: "Second" }, 1000);
    collector.push({ watchId: "w1", postId: "p1", title: "Third" }, 2000);
    expect(bursts.filter((b) => b.isNew)).toHaveLength(1);

    collector.push({ watchId: "w1", postId: "p1", title: "Fourth" }, 6000);

    const isNewBursts = bursts.filter((b) => b.isNew);
    expect(isNewBursts).toHaveLength(2);
    expect(isNewBursts[1]).toMatchObject({ count: 1, label: "New match", firstTitle: "Fourth" });
  });

  test("a single frame is titled 'New match', opens the toast, and keeps the first title as description", () => {
    collector.push({ watchId: "w1", postId: "p1", title: "Only" }, 0);
    expect(bursts).toHaveLength(1);
    expect(bursts[0]).toMatchObject({ count: 1, label: "New match", firstTitle: "Only", isNew: true });
  });

  test("onWindowFlush fires once per window with frames, never on dispose", () => {
    const flushes: number[] = [];
    const c2 = createMatchBurstCollector({ onBurst: () => {}, onWindowFlush: () => flushes.push(1) });
    c2.push({ watchId: "w1", postId: "p1", title: "A" }, 0);
    c2.push({ watchId: "w1", postId: "p1", title: "B" }, 1000);
    expect(flushes).toHaveLength(0);
    vi.advanceTimersByTime(MATCH_BURST_WINDOW_MS);
    expect(flushes).toHaveLength(1);

    c2.push({ watchId: "w1", postId: "p1", title: "C" }, 6000);
    c2.dispose();
    expect(flushes).toHaveLength(1); // dispose never flushes
  });

  test("dispose stops the window without emitting a further burst", () => {
    collector.push({ watchId: "w1", postId: "p1", title: "First" }, 0);
    expect(bursts).toHaveLength(1); // the open toast already emitted
    collector.dispose();
    vi.advanceTimersByTime(MATCH_BURST_WINDOW_MS * 2);
    expect(bursts).toHaveLength(1); // no further burst from the (cleared) window timer
  });
});

// A dismissed toast must not swallow later frames
// in the same burst window — the wiring below mirrors LiveProvider's onBurst
// handler in ws.tsx (isNew || !id || !update(...) -> open a fresh toast).
describe("dead-toast recovery (ws.tsx onBurst wiring)", () => {
  function useBurstToastWiring() {
    const { toast, update, dismiss, toasts } = useToast();
    const idRef = useRef<string | null>(null);
    const collectorRef = useRef<ReturnType<typeof createMatchBurstCollector> | null>(null);
    if (!collectorRef.current) {
      collectorRef.current = createMatchBurstCollector({
        onBurst: (burst) => {
          const payload = { title: burst.label, description: burst.firstTitle, duration: MATCH_TOAST_TTL_MS };
          if (burst.isNew || !idRef.current || !update(idRef.current, payload)) {
            idRef.current = toast(payload);
          }
        },
      });
    }
    return {
      push: (frame: MatchFrameInput, now?: number) => collectorRef.current!.push(frame, now),
      dismiss,
      toasts,
    };
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("frame at t=0, dismiss at t=1s, 3 frames at t=2-4s: a second toast shows the running count", () => {
    const { result } = renderHook(() => useBurstToastWiring(), { wrapper: ToastProvider });

    act(() => result.current.push({ watchId: "w1", postId: "p1", title: "A" }, 0));
    expect(result.current.toasts).toHaveLength(1);
    const firstId = result.current.toasts[0]!.id;

    act(() => {
      vi.advanceTimersByTime(1000);
      result.current.dismiss(firstId);
    });
    expect(result.current.toasts).toHaveLength(0);

    act(() => result.current.push({ watchId: "w1", postId: "p1", title: "B" }, 2000));
    act(() => result.current.push({ watchId: "w1", postId: "p1", title: "C" }, 3000));
    act(() => result.current.push({ watchId: "w1", postId: "p1", title: "D" }, 4000));

    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0]!.id).not.toBe(firstId);
    expect(result.current.toasts[0]!.title).toBe("New matches (4)");
  });
});

describe("matchBurstHref", () => {
  test("single-frame burst links to the post permalink", () => {
    expect(matchBurstHref({ count: 1, watchIds: ["abc-123"], postIds: ["post-1"] })).toBe("/posts/post-1");
  });

  test("multi-frame single-watch burst deep-links to the filtered inbox", () => {
    expect(matchBurstHref({ count: 2, watchIds: ["abc-123"], postIds: ["p1", "p2"] })).toBe("/matches?watch=abc-123");
  });

  test("mixed-watch burst goes to the inbox root", () => {
    expect(matchBurstHref({ count: 2, watchIds: ["w1", "w2"], postIds: ["p1", "p2"] })).toBe("/matches");
  });
});
