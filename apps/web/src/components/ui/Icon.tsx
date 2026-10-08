import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type IconTone = "muted" | "accent" | "good" | "warn" | "bad";

const TONE_CLASS: Record<IconTone, string> = {
  muted: "text-muted-foreground",
  accent: "text-accent",
  good: "text-good",
  warn: "text-warn",
  bad: "text-bad",
};

export interface IconProps {
  icon: LucideIcon;
  tone?: IconTone;
  label?: string;
  className?: string;
}

/** The only way edited files render a Lucide glyph: 16 px, stroke 1.6, muted unless it carries state. */
export function Icon({ icon: Glyph, tone = "muted", label, className }: IconProps) {
  return (
    <Glyph
      size={16}
      strokeWidth={1.6}
      className={cn("shrink-0", TONE_CLASS[tone], className)}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
    />
  );
}
