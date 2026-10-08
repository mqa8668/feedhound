import { cn } from "@/lib/utils";

/** Crosshair mark; same glyph as public/favicon.svg, coloured via currentColor. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      data-testid="logo-mark"
      aria-hidden="true"
      className={cn("shrink-0", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={5}
      strokeLinecap="round"
    >
      <circle cx="32" cy="32" r="16" />
      <path d="M32 6V18M32 46V58M6 32H18M46 32H58" />
      <circle cx="32" cy="32" r="4" fill="currentColor" stroke="none" />
    </svg>
  );
}
