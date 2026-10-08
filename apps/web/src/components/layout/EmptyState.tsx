import type { ComponentType, ReactNode } from "react";
import { Inbox } from "lucide-react";

export interface EmptyStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
  /** Defaults to a generic inbox glyph; pass a lucide icon for a more specific hint. */
  icon?: ComponentType<{ className?: string }>;
}

/** Consistent empty-state block: muted icon + title + one-line hint, centered, fixed min-height. */
export function EmptyState({ title, description, action, icon: Icon = Inbox }: EmptyStateProps) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-2 py-10 text-center">
      <Icon className="h-8 w-8 text-muted-foreground/50" aria-hidden="true" />
      <p className="text-sm font-medium">{title}</p>
      {description ? <p className="max-w-sm text-sm text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
