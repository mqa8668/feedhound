import { Plus } from "lucide-react";
import { Icon } from "@/components/ui/Icon";
import { formatVndShort } from "@/lib/format";
import type { WatchParseResponseDto } from "@/api/types";

export interface SuggestionsProps {
  suggestions: WatchParseResponseDto["suggestions"];
  include: string[];
  exclude: string[];
  onAddInclude: (term: string) => void;
  onAddExclude: (term: string) => void;
}

const CHIP = "inline-flex h-8 items-center gap-1 rounded-full border border-dashed border-line-strong px-3 text-fs-sm hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Suggested chips; clicking one adds it to the draft. */
export function Suggestions({ suggestions, include, exclude, onAddInclude, onAddExclude }: SuggestionsProps) {
  const aliases = suggestions.aliases.filter((a) => !include.includes(a));
  const excludes = suggestions.exclude.filter((e) => !exclude.includes(e));
  const range = suggestions.priceRange;
  if (aliases.length === 0 && excludes.length === 0 && !range) return null;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">Suggestions</p>
      <div className="flex flex-wrap gap-2">
        {aliases.map((a) => (
          <button key={`a-${a}`} type="button" className={CHIP} onClick={() => onAddInclude(a)}>
            <Icon icon={Plus} />
            Keyword: {a}
          </button>
        ))}
        {excludes.map((e) => (
          <button key={`e-${e}`} type="button" className={CHIP} onClick={() => onAddExclude(e)}>
            <Icon icon={Plus} />
            Exclude: {e}
          </button>
        ))}
      </div>
      {range ? (
        <p className="text-xs text-muted-foreground">
          Typical price {formatVndShort(range.p25)}–{formatVndShort(range.p75)} (median {formatVndShort(range.median)}, {range.n} listings in 30 days).
        </p>
      ) : null}
    </div>
  );
}
