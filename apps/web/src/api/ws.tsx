import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useToast } from "@/components/ui/toast";
import { invalidateAfterMatchBurst } from "./queries";
import { createMatchBurstCollector, matchBurstHref, MATCH_TOAST_TTL_MS } from "./match-toasts";
import type { WsFrame } from "./types";

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

export type WsStatus = "connecting" | "open" | "closed";

type FrameHandler = (frame: WsFrame) => void;

interface LiveContextValue {
  status: WsStatus;
  subscribe: (type: WsFrame["type"], handler: FrameHandler) => () => void;
}

const LiveContext = createContext<LiveContextValue | null>(null);

// Coalesces a burst of `thumb.ready` frames into one feed/matches refetch.
const THUMB_READY_DEBOUNCE_MS = 1500;

function invalidateForFrame(qc: QueryClient, frame: WsFrame) {
  switch (frame.type) {
    case "post.new":
    case "post.updated":
      qc.invalidateQueries({ queryKey: ["feed"] });
      break;
    case "match.new":
      qc.invalidateQueries({ queryKey: ["feed"] });
      // Badge; the fetched count is the only truth. The
      // ["matches"] list is invalidated at most once per burst window, from
      // the match-toasts aggregator's onWindowFlush — not per frame, to avoid
      // refetching every loaded page on each WS message.
      qc.invalidateQueries({ queryKey: ["unseen-matches"] });
      break;
    case "source.health":
      qc.invalidateQueries({ queryKey: ["sources"] });
      qc.invalidateQueries({ queryKey: ["ops-health"] });
      break;
    case "config.changed":
      qc.invalidateQueries({ queryKey: ["config"] });
      qc.invalidateQueries({ queryKey: ["config-versions"] });
      break;
  }
}

/** Invalidate everything the shell cares about after a reconnect (009 adds the badge). */
function invalidateAfterReconnect(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ["feed"] });
  qc.invalidateQueries({ queryKey: ["sources"] });
  qc.invalidateQueries({ queryKey: ["ops-health"] });
  qc.invalidateQueries({ queryKey: ["config"] });
  qc.invalidateQueries({ queryKey: ["config-versions"] });
  qc.invalidateQueries({ queryKey: ["unseen-matches"] });
  qc.invalidateQueries({ queryKey: ["matches"] });
  qc.invalidateQueries({ queryKey: ["dashboard", "overview"] });
}

/**
 * Owns the single `/ws` connection for the whole app, reconnects with 1s->30s
 * backoff, and invalidates the relevant TanStack Query caches per frame type
 *. Mount once at the shell level; consumers use
 * `useLive()` to read status and subscribe to frame types without opening
 * their own socket.
 */
export function LiveProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { toast, update: updateToast } = useToast();
  const navigate = useNavigate();
  const backoffRef = useRef(MIN_BACKOFF_MS);
  const [status, setStatus] = useState<WsStatus>("connecting");
  const listenersRef = useRef(new Map<WsFrame["type"], Set<FrameHandler>>());

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closedByUs = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hasConnectedBefore = false;
    let thumbTimer: ReturnType<typeof setTimeout> | undefined;

    // `match.new` frames collapse into one toast per 5 s burst: the first
    // frame opens it, later frames in the same window update it in place
    // instead of waiting for the window to close. The
    // burst toast lives 10 s and clicking it opens the (filtered) matches
    // inbox. Each window gets at most one live toast id.
    let currentToastId: string | null = null;
    const matchCollector = createMatchBurstCollector({
      onBurst: (burst) => {
        const payload = { title: burst.label, description: burst.firstTitle, duration: MATCH_TOAST_TTL_MS, onClick: () => navigate(matchBurstHref(burst)) };
        // update() returns false if the user already dismissed/clicked the
        // toast (or it auto-expired); a dead id must not swallow later frames
        // in the same window, so fall back to opening a fresh toast.
        if (burst.isNew || !currentToastId || !updateToast(currentToastId, payload)) {
          currentToastId = toast(payload);
        }
      },
      // At most one ["matches"] refetch per burst window, fired
      // once the window actually closes rather than on every frame.
      onWindowFlush: () => {
        currentToastId = null;
        invalidateAfterMatchBurst(qc);
      },
    });

    const connect = () => {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${window.location.host}/ws`);

      ws.onopen = () => {
        // React StrictMode mounts effects twice in dev; if cleanup already
        // ran before the socket finished opening, close it now instead of
        // reporting a spurious "open" status for a socket we're discarding.
        if (closedByUs) {
          ws?.close();
          return;
        }
        backoffRef.current = MIN_BACKOFF_MS;
        setStatus("open");
        if (hasConnectedBefore) {
          invalidateAfterReconnect(qc);
        }
        hasConnectedBefore = true;
      };

      ws.onmessage = (event) => {
        let frame: WsFrame;
        try {
          frame = JSON.parse(event.data as string) as WsFrame;
        } catch {
          return;
        }

        // Not in the shared WsFrame union (apps/web/src/api/types.ts); matched by tag.
        if ((frame as { type: string }).type === "thumb.ready") {
          if (thumbTimer) clearTimeout(thumbTimer);
          thumbTimer = setTimeout(() => {
            qc.invalidateQueries({ queryKey: ["feed"] });
            qc.invalidateQueries({ queryKey: ["matches"] });
          }, THUMB_READY_DEBOUNCE_MS);
          return;
        }

        invalidateForFrame(qc, frame);
        if (frame.type === "match.new") {
          matchCollector.push({ watchId: frame.data.watchId, postId: frame.data.postId, title: frame.data.title });
        }

        const handlers = listenersRef.current.get(frame.type);
        handlers?.forEach((handler) => handler(frame));
      };

      ws.onclose = () => {
        if (closedByUs) return;
        setStatus("closed");
        timer = setTimeout(connect, backoffRef.current);
        backoffRef.current = Math.min(backoffRef.current * 2, MAX_BACKOFF_MS);
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    connect();

    return () => {
      closedByUs = true;
      matchCollector.dispose();
      if (thumbTimer) clearTimeout(thumbTimer);
      if (timer) clearTimeout(timer);
      // Closing a socket still in CONNECTING state is what triggers the
      // "WebSocket is closed before the connection is established" console
      // warning; let onopen above close it once (or never, if it never
      // opens) instead of forcing it here.
      if (ws && ws.readyState !== WebSocket.CONNECTING) ws.close();
    };
  }, [qc, toast, updateToast, navigate]);

  const value = useMemo<LiveContextValue>(
    () => ({
      status,
      subscribe: (type, handler) => {
        const listeners = listenersRef.current;
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(handler);
        return () => {
          listeners.get(type)?.delete(handler);
        };
      },
    }),
    [status],
  );

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

/** Read live connection status and/or subscribe to a specific frame type from the shared socket. */
export function useLive(type?: WsFrame["type"], onFrame?: FrameHandler): { status: WsStatus } {
  const ctx = useContext(LiveContext);
  if (!ctx) throw new Error("useLive must be used within a LiveProvider");
  const onFrameRef = useRef(onFrame);
  useEffect(() => {
    onFrameRef.current = onFrame;
  });

  useEffect(() => {
    if (!type) return;
    return ctx.subscribe(type, (frame) => onFrameRef.current?.(frame));
  }, [ctx, type]);

  return { status: ctx.status };
}
