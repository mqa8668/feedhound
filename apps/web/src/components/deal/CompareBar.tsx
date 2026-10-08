import { Button } from "@/components/ui/button";

export const COMPARE_MAX = 4;

/** Sticky bar shown while 1+ listings are ticked for comparison. */
export function CompareBar({ count, onOpen, onClear }: { count: number; onOpen: () => void; onClear: () => void }) {
  if (count === 0) return null;
  return (
    <div className="sticky bottom-3 z-10 flex items-center justify-between gap-2 rounded-lg border bg-card p-2 shadow-md">
      <Button type="button" size="sm" disabled={count < 2} onClick={onOpen}>
        Compare ({count})
      </Button>
      <span className="text-fs-sm text-muted-foreground">{count < 2 ? "Select at least 2 listings" : `Up to ${COMPARE_MAX} listings`}</span>
      <Button type="button" size="sm" variant="ghost" onClick={onClear}>
        Clear
      </Button>
    </div>
  );
}
