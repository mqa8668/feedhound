// After a release swaps the image, open tabs reference chunks that no longer
// exist. Vite fires `vite:preloadError`; reload once (guarded for 60 s so a
// genuinely broken chunk cannot cause a reload loop).
const KEY = "feedhound:chunk-reload";
const WINDOW_MS = 60_000;

export function installStaleChunkReload(win: Window = window, now: () => number = Date.now): () => void {
  const handler = (event: Event): void => {
    const t = now();
    try {
      const last = Number(win.sessionStorage.getItem(KEY));
      if (last && t - last <= WINDOW_MS) return;
      win.sessionStorage.setItem(KEY, String(t));
    } catch {
      return; // storage unavailable: the loop guard cannot hold, so do not reload
    }
    event.preventDefault();
    win.location.reload();
  };
  win.addEventListener("vite:preloadError", handler);
  return () => win.removeEventListener("vite:preloadError", handler);
}
