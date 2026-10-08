import { Check, HelpCircle, X } from "lucide-react";
import { Card } from "@/components/layout/Card";
import type { DecisionDto } from "@/api/decision";
import { cn } from "@/lib/utils";

const ICON = { ok: Check, fail: X, unknown: HelpCircle } as const;
const TONE = { ok: "text-good", fail: "text-destructive", unknown: "text-muted-foreground" } as const;
const WORD = { ok: "pass", fail: "fail", unknown: "unknown" } as const;

/** Fit of this post against each matched watch. */
export function WatchFitList({ fit }: { fit: DecisionDto["fit"] }) {
  if (fit.length === 0) return null;
  return (
    <Card title="Fit with watches">
      <ul className="flex flex-col gap-3">
        {fit.map((w) => (
          <li key={w.watchId}>
            <p className="mb-1 text-sm font-medium">{w.watchName}</p>
            <ul className="flex flex-col gap-1">
              {w.items.map((it, i) => {
                const I = ICON[it.status];
                return (
                  <li key={`${it.label}-${i}`} data-fit={it.status} className={cn("flex items-center gap-2 text-sm", TONE[it.status])}>
                    <I className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="text-foreground">{it.label}</span>
                    <span className="sr-only">{WORD[it.status]}</span>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
    </Card>
  );
}
