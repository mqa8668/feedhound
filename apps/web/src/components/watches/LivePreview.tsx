import { Fragment } from "react";
import { Card } from "@/components/layout/Card";
import { Sparkline } from "./Sparkline";
import { formatVndShort } from "@/lib/format";
import { highlight } from "@/lib/highlight";
import { PREVIEW_DAYS } from "@/lib/watch-lint";
import type { WatchTestResultDto } from "@/api/types";
import { Eye } from "lucide-react";

export const PREVIEW_SAMPLE_LIMIT = 5;

export interface LivePreviewProps {
  /** No valid draft yet (nothing to match on). */
  idle: boolean;
  loading: boolean;
  error: boolean;
  result: WatchTestResultDto | undefined;
}

function Marked({ text, terms }: { text: string; terms: string[] }) {
  return (
    <>
      {highlight(text, terms).map((seg, i) =>
        seg.match ? (
          <mark key={i} className="rounded-sm bg-warn-soft px-0.5 text-foreground">
            {seg.text}
          </mark>
        ) : (
          <Fragment key={i}>{seg.text}</Fragment>
        ),
      )}
    </>
  );
}

/** 7-day preview with total, ~N/day, trend, and highlighted samples (React nodes only). */
export function LivePreview({ idle, loading, error, result }: LivePreviewProps) {
  return (
    <Card title="7-day preview" icon={Eye}>
      {idle ? (
        <p className="text-sm text-muted-foreground">Enter a description or keywords to see how many posts this watch would catch.</p>
      ) : error ? (
        <p className="text-sm text-muted-foreground">Could not load the preview. You can still save the watch.</p>
      ) : loading || !result ? (
        <div className="h-24 animate-pulse rounded-md bg-surface-2" aria-label="Calculating" />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-end justify-between gap-3">
            <div>
              <p className="text-2xl font-semibold tabular-nums">{result.total}</p>
              <p className="text-xs text-muted-foreground">matches · ~{Math.round((result.total / PREVIEW_DAYS) * 10) / 10}/day</p>
            </div>
            <Sparkline values={result.daily} label="Matches per day" />
          </div>
          {result.truncated ? <p className="text-xs text-warn">Only part of the data was scanned; the real number may be higher.</p> : null}
          {result.posts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No matching posts yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {result.posts.slice(0, PREVIEW_SAMPLE_LIMIT).map((p) => (
                <li key={p.id} className="flex items-start justify-between gap-3 py-2">
                  <a href={p.url} target="_blank" rel="noreferrer" className="min-w-0 break-words text-sm hover:underline">
                    <Marked text={p.title ?? "(no title)"} terms={p.matchedTerms} />
                  </a>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{p.priceVnd != null ? formatVndShort(p.priceVnd) : "—"}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
