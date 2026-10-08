import { useSyncExternalStore } from "react";

let expired = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function markSessionExpired(): void {
  if (expired) return;
  expired = true;
  emit();
}

/** Tests only. */
export function resetSessionExpired(): void {
  expired = false;
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useSessionExpired(): boolean {
  return useSyncExternalStore(subscribe, () => expired, () => false);
}
