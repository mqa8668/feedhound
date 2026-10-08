import type { ReactNode } from "react";

export interface PageHeaderProps {
  title: string;
  description?: string;
  meta?: string;
  actions?: ReactNode;
}

/** Renders the page's single `h1`. Actions sit right of the title at >=640px, stacked full-width below it. */
export function PageHeader({ title, description, meta, actions }: PageHeaderProps) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold leading-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
        {meta ? <p className="mt-1 text-xs text-muted-foreground">{meta}</p> : null}
      </div>
      {actions ? (
        <div className="flex w-full shrink-0 flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center">
          {actions}
        </div>
      ) : null}
    </div>
  );
}
