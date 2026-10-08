export interface SparklineProps {
  values: number[];
  className?: string;
  label?: string;
}

const W = 96;
const H = 24;
const PAD = 2;

/** Tiny inline trend line; draws in the current text color (set a text-* token on the parent or className). */
export function Sparkline({ values, className, label }: SparklineProps) {
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? (W - PAD * 2) / (values.length - 1) : 0;
  const points = values.map((v, i) => `${(PAD + i * step).toFixed(1)},${(H - PAD - (v / max) * (H - PAD * 2)).toFixed(1)}`).join(" ");
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      className={className ?? "text-accent"}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      preserveAspectRatio="none"
    >
      {values.length > 0 ? <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" /> : null}
    </svg>
  );
}
