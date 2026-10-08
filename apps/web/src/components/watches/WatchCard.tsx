import { useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, BellOff, Send, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/Icon";
import { Switch } from "@/components/ui/switch";
import { Sparkline } from "./Sparkline";
import { WatchCardMenu } from "./WatchCardMenu";
import { formatRelative, formatVndShort } from "@/lib/format";
import type { NotifierKindDto, WatchDto } from "@/api/types";

const ROUTE_ICON: Record<NotifierKindDto, { icon: LucideIcon; label: string }> = {
  telegram: { icon: Send, label: "Telegram" },
};

export interface WatchCardProps {
  watch: WatchDto;
  summary: string;
  now?: Date;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onSnooze1h: () => void;
  onSnoozeTomorrow: () => void;
  onUnsnooze: () => void;
  onDelete: () => void;
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-fs-sm text-muted-foreground">{label}</p>
      <p className="text-sm font-medium tabular-nums">{value}</p>
    </div>
  );
}

export function WatchCard({ watch, summary, now = new Date(), onToggle, onEdit, onDuplicate, onSnooze1h, onSnoozeTomorrow, onUnsnooze, onDelete }: WatchCardProps) {
  const [confirming, setConfirming] = useState(false);
  const stats = watch.stats;
  const snoozed = watch.mutedUntil !== null && new Date(watch.mutedUntil).getTime() > now.getTime();
  const deal = stats?.bestDeal ?? null;

  return (
    <li className="flex flex-col gap-3 rounded-lg border border-line bg-card p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <Link to={`/watches/${watch.id}`} className="block truncate font-medium hover:underline">
            {watch.name}
          </Link>
          <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{summary || "No conditions yet"}</p>
        </div>
        <Switch className="mt-1.5" checked={watch.enabled} onCheckedChange={onToggle} aria-label={`Enable ${watch.name}`} />
        <WatchCardMenu
          name={watch.name}
          snoozed={snoozed}
          onEdit={onEdit}
          onDuplicate={onDuplicate}
          onSnooze1h={onSnooze1h}
          onSnoozeTomorrow={onSnoozeTomorrow}
          onUnsnooze={onUnsnooze}
          onDelete={() => setConfirming(true)}
        />
      </div>

      {stats ? (
        <div className="flex items-end justify-between gap-3">
          <div className="grid min-w-0 grid-cols-3 gap-3">
            <Stat label="Today" value={String(stats.today)} />
            <Stat label="7 days" value={String(stats.last7d)} />
            <Stat label="Last hit" value={stats.lastHitAt ? formatRelative(stats.lastHitAt, now) : "—"} />
          </div>
          <Sparkline values={stats.daily} label="Matches over the last 7 days" />
        </div>
      ) : null}

      {deal ? (
        <p className="text-sm">
          <span className="font-medium">{deal.title ?? "(no title)"}</span>{" "}
          <span className="text-muted-foreground">· {formatVndShort(deal.priceVnd)} ·</span>{" "}
          <span className="font-medium text-good">{deal.dealPct < 0 ? "−" : "+"}{Math.abs(Math.round(deal.dealPct))}% vs median</span>
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-fs-sm">
        {stats && stats.routes.length === 0 ? (
          <span className="inline-flex items-center gap-1 text-warn">
            <Icon icon={AlertTriangle} tone="warn" />
            No route
          </span>
        ) : (
          <>
            {stats?.routesFallback ? (
              <span className="text-muted-foreground" title="No notifier picked: sends to all of the owner's enabled notifiers">
                All notifiers
              </span>
            ) : null}
            {stats?.routes.map((k) => (
              <span key={k} className="inline-flex items-center gap-1 text-muted-foreground">
                <Icon icon={ROUTE_ICON[k].icon} label={ROUTE_ICON[k].label} />
                {ROUTE_ICON[k].label}
              </span>
            ))}
          </>
        )}
        {stats && stats.last7d === 0 ? (
          <span className="inline-flex items-center gap-1 text-warn">
            <Icon icon={AlertTriangle} tone="warn" />
            No matches in the last 7 days
          </span>
        ) : null}
        {snoozed && watch.mutedUntil ? (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <Icon icon={BellOff} />
            Snoozed until {hhmm(watch.mutedUntil)}
          </span>
        ) : null}
      </div>

      {confirming ? (
        <div role="alertdialog" aria-label={`Delete ${watch.name}?`} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-bad-soft px-3 py-2 text-sm">
          <span>Delete this watch? This cannot be undone.</span>
          <span className="flex gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              onClick={() => {
                setConfirming(false);
                onDelete();
              }}
            >
              Delete
            </Button>
          </span>
        </div>
      ) : null}
    </li>
  );
}
