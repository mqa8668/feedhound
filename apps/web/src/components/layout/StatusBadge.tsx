import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const STATUS_TONE: Record<string, string> = {
  active: "bg-success",
  healthy: "bg-success",
  enabled: "bg-success",
  linked: "bg-success",
  ok: "bg-success",
  paused: "bg-warning",
  pending: "bg-warning",
  degraded: "bg-warning",
  error: "bg-destructive",
  failed: "bg-destructive",
  down: "bg-destructive",
  revoked: "bg-destructive",
  disabled: "bg-muted-foreground",
};

/** Dot + label, tone driven by a single status -> colour map. Unknown statuses fall back to neutral.
 * Pass `children` to render custom label content (e.g. a name) instead of the raw status string. */
export function StatusBadge({ status, children }: { status: string; children?: ReactNode }) {
  const dotClass = STATUS_TONE[status.toLowerCase()] ?? "bg-muted-foreground";
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs font-medium">
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotClass)} aria-hidden="true" title={status} />
      <span className="truncate">{children ?? status}</span>
    </span>
  );
}
