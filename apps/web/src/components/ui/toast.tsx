import * as React from "react";
import { cn } from "@/lib/utils";

export interface ToastItem {
  id: string;
  title: string;
  description?: string;
  variant?: "default" | "destructive" | "success";
  /** Auto-dismiss delay in ms; defaults to 5s. Match bursts pass 10s. */
  duration?: number;
  /** When set, the toast is clickable (role="button", Enter/Space) and clicking also dismisses it. */
  onClick?: () => void;
}

interface ToastContextValue {
  toasts: ToastItem[];
  toast: (t: Omit<ToastItem, "id">) => string;
  /**
   * Replaces title/description/onClick of a live toast and restarts its auto-dismiss timer.
   * Returns false (no-op) if the toast was already dismissed, so callers can open a
   * replacement toast instead of silently losing the update.
   */
  update: (id: string, patch: Omit<ToastItem, "id">) => boolean;
  dismiss: (id: string) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastItem[]>([]);

  const timersRef = React.useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = React.useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const armTimer = React.useCallback(
    (id: string, duration: number | undefined) => {
      const existing = timersRef.current.get(id);
      if (existing) clearTimeout(existing);
      timersRef.current.set(
        id,
        setTimeout(() => dismiss(id), duration ?? 5000),
      );
    },
    [dismiss],
  );

  const toast = React.useCallback(
    (t: Omit<ToastItem, "id">) => {
      const id = crypto.randomUUID();
      setToasts((prev) => [...prev, { ...t, id }]);
      armTimer(id, t.duration);
      return id;
    },
    [armTimer],
  );

  const update = React.useCallback(
    (id: string, patch: Omit<ToastItem, "id">): boolean => {
      // timersRef is the synchronous source of truth for "still live": dismiss()
      // (manual or auto-timeout) always removes the entry, so we don't need to
      // wait for the setToasts updater to run to know whether the toast survived.
      const live = timersRef.current.has(id);
      if (live) {
        setToasts((prev) => prev.map((t) => (t.id === id ? { ...patch, id } : t)));
        armTimer(id, patch.duration);
      }
      return live;
    },
    [armTimer],
  );

  return (
    <ToastContext.Provider value={{ toasts, toast, update, dismiss }}>
      {children}
      <div className="fixed bottom-4 right-4 z-[100] flex w-[calc(100%-2rem)] max-w-sm flex-col gap-2 sm:bottom-6 sm:right-6">
        {toasts.map((t) => (
          <Toast key={t.id} toast={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function Toast({ toast: t, onDismiss }: { toast: ToastItem; onDismiss: (id: string) => void }) {
  const activate = () => {
    onDismiss(t.id);
    t.onClick?.();
  };
  const interactive = t.onClick != null;
  return (
    <div
      role={interactive ? "button" : "status"}
      tabIndex={interactive ? 0 : undefined}
      onClick={interactive ? activate : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                activate();
              }
            }
          : undefined
      }
      className={cn(
        "rounded-md border bg-card p-3 shadow-lg text-card-foreground",
        t.variant === "destructive" && "border-destructive bg-destructive text-destructive-foreground",
        t.variant === "success" && "border-success",
        interactive && "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
      )}
    >
      <p className="text-sm font-medium">{t.title}</p>
      {t.description ? <p className="text-xs opacity-80 mt-1">{t.description}</p> : null}
    </div>
  );
}

export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
