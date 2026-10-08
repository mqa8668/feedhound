import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/Icon";
import type { LintItem } from "@/lib/watch-lint";

export interface LintListProps {
  items: LintItem[];
  onAction: (item: LintItem) => void;
}

/** Warnings above Save. Never blocks saving. */
export function LintList({ items, onAction }: LintListProps) {
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2" aria-label="Warnings">
      {items.map((item) => (
        <li key={item.code} className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-warn-soft px-3 py-2 text-sm">
          <Icon icon={AlertTriangle} tone="warn" />
          <span className="min-w-0 flex-1">{item.message}</span>
          {item.action ? (
            <Button type="button" size="sm" variant="outline" onClick={() => onAction(item)}>
              {item.action.label}
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
