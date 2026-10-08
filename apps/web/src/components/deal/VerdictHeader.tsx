import { useState } from "react";
import { platformOfUrl } from "@feedhound/core/platform";
import { Bookmark, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DecisionDto } from "@/api/decision";
import { usePostFlag } from "@/api/queries";
import { formatPriceQualified } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Verdict + price + actions. */
export function VerdictHeader({ postId, url, decision }: { postId: string; url: string; decision: DecisionDto }) {
  const flag = usePostFlag();
  const [saved, setSaved] = useState(false);
  const { verdict, price } = decision;
  const tone = verdict.pct !== null && verdict.pct <= -1 ? "text-good" : verdict.pct !== null && verdict.pct >= 1 ? "text-warn" : "text-foreground";
  const toggle = () => {
    const next = !saved;
    setSaved(next);
    flag.mutate({ id: postId, kind: "saved", on: next }, { onError: () => setSaved(!next) });
  };
  return (
    <section aria-label="Verdict" className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <p data-verdict="true" className={cn("text-lg font-semibold", tone)}>
        {verdict.text}
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-2xl font-semibold tabular-nums">{price.suspect ? "Price unclear" : formatPriceQualified(price.vnd, price.qualifier)}</span>
        {verdict.medianVnd !== null ? <span className="text-sm text-muted-foreground">Median {formatPriceQualified(verdict.medianVnd)}</span> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" aria-pressed={saved} onClick={toggle}>
          <Bookmark className="mr-1 h-4 w-4" aria-hidden="true" />
          Save
        </Button>
        <Button asChild size="sm">
          <a href={url} target="_blank" rel="noopener noreferrer">
            {platformOfUrl(url).openLabel} <ExternalLink className="ml-1 h-3 w-3" aria-hidden="true" />
          </a>
        </Button>
      </div>
    </section>
  );
}
