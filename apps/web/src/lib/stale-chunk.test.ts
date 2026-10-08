import { describe, expect, test, vi } from "vitest";
import { installStaleChunkReload } from "./stale-chunk";

function fakeWindow() {
  const store = new Map<string, string>();
  let handler: ((e: Event) => void) | undefined;
  const reload = vi.fn();
  const win = {
    sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    location: { reload },
    addEventListener: (_: string, h: (e: Event) => void) => {
      handler = h;
    },
    removeEventListener: vi.fn(),
  } as unknown as Window;
  return { win, reload, fire: (e: Event) => handler?.(e) };
}

describe("installStaleChunkReload", () => {
  test("skips reload when sessionStorage throws", () => {
    const { win, reload, fire } = fakeWindow();
    (win as unknown as { sessionStorage: unknown }).sessionStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    installStaleChunkReload(win, () => 1);
    fire({ preventDefault: vi.fn() } as unknown as Event);
    expect(reload).not.toHaveBeenCalled();
  });

  test("reloads once within 60 s, again after", () => {
    const { win, reload, fire } = fakeWindow();
    let t = 1_000_000;
    installStaleChunkReload(win, () => t);
    const preventDefault = vi.fn();
    const ev = { preventDefault } as unknown as Event;
    fire(ev);
    t += 10_000;
    fire(ev);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    t += 51_000; // 61 s after the first
    fire(ev);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
