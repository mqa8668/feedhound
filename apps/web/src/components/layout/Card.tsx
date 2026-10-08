import type { ReactNode } from "react";
import {
  Card as CardPrimitive,
  CardContent as CardPrimitiveContent,
  CardFooter as CardPrimitiveFooter,
  CardHeader as CardPrimitiveHeader,
  CardTitle as CardPrimitiveTitle,
  CardDescription as CardPrimitiveDescription,
} from "@/components/ui/card";
import type { LucideIcon } from "lucide-react";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/utils";

export interface CardProps {
  title?: string;
  /** Header glyph (16 px, muted). */
  icon?: LucideIcon;
  /** Small count next to the title. */
  count?: ReactNode;
  description?: string;
  actions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  /**
   * Content is a DataTable: below 640px the DataTable's own stacked card
   * list is the surface, so the wrapping Card must not add a second
   * border/background/padding around it (that double chrome is what clips
   * content on narrow screens). At >=640px (table view) the Card chrome
   * renders as normal.
   */
  bleedMobile?: boolean;
}

/** Layout-level card: title/description/actions header, body, optional footer. Padding 16px < 768, 20px >= 768. */
export function Card({ title, icon, count, description, actions, footer, children, className, bleedMobile }: CardProps) {
  return (
    <CardPrimitive
      className={cn("gap-0 py-0", bleedMobile && "rounded-none border-0 bg-transparent shadow-none sm:rounded-lg sm:border sm:bg-card sm:shadow-sm", className)}
    >
      {title || actions ? (
        <CardPrimitiveHeader
          className={cn(
            "flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 p-4 sm:p-5",
            bleedMobile && "px-0 sm:px-5",
          )}
        >
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              {icon ? <Icon icon={icon} /> : null}
              {title ? <CardPrimitiveTitle className="truncate text-sm font-semibold">{title}</CardPrimitiveTitle> : null}
              {count != null ? (
                <span data-slot="count" className="shrink-0 text-fs-sm tabular-nums text-muted-foreground">
                  {count}
                </span>
              ) : null}
            </div>
            {description ? <CardPrimitiveDescription>{description}</CardPrimitiveDescription> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </CardPrimitiveHeader>
      ) : null}
      <CardPrimitiveContent className={cn("p-4 pt-0 sm:p-5 sm:pt-0", bleedMobile && "px-0 sm:px-5")}>{children}</CardPrimitiveContent>
      {footer ? <CardPrimitiveFooter className="border-t p-4 sm:p-5">{footer}</CardPrimitiveFooter> : null}
    </CardPrimitive>
  );
}
