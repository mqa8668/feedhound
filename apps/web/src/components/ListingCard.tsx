import { useEffect, useRef, useState, type ReactNode } from "react";
import { platformOfUrl } from "@feedhound/core/platform";
import { Link, useNavigate } from "react-router-dom";
import { AlertTriangle, Bookmark, EyeOff, ImageOff, Phone, Undo2, Plus } from "lucide-react";
import { CAR_CHIP_KEYS, dealBadge, formatKm, watchDraftFromListing, type ListingFields } from "@feedhound/core/listing";
import { Icon } from "@/components/ui/Icon";
import { SourceAvatar } from "@/components/SourceAvatar";
import { displayTitle } from "@/components/feed-grammar";
import { formatAbsolute, formatPriceQualified, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { usePostFlag } from "@/api/queries";
import { MarketStrip } from "@/components/deal/MarketStrip";
import type { Intent, PriceQualifier } from "@/api/types";

/** What `ListingCard` needs: the listing fields plus the post columns the card prints. */
export interface ListingCardRow extends ListingFields {
  id: string;
  sourceId: string;
  url: string;
  title: string | null;
  snippet?: string | null;
  priceVnd: number | null;
  priceQualifier?: PriceQualifier | null;
  priceMaxVnd?: number | null;
  dealMedianVnd?: number | null;
  dealN?: number | null;
  intent: Intent | null;
  firstSeenAt: string;
}

/** Listing fields for rows that only know the post (WS `post.new` frames). */
export const EMPTY_LISTING: ListingFields = {
  displayTitle: null,
  thumbUrl: null,
  categoryId: null,
  attributes: null,
  region: null,
  dealPct: null,
  priceSuspect: false,
  hasPhone: false,
  repostKey: null,
  alsoIn: [],
  saved: false,
};

const UNDO_MS = 5000;
const INTENT_DOT: Record<Intent, string> = { sell: "bg-good", buy: "bg-info", other: "bg-faint" };
const UPPER_CHIPS = new Set(["transmission"]);
const SPECIAL_LABELS: Record<string, string> = { ev: "EV", hcm: "HCMC", bmw: "BMW", vinfast: "VinFast", mercedes_benz: "Mercedes-Benz", ha_noi: "Hanoi", da_nang: "Da Nang", hai_phong: "Hai Phong", can_tho: "Can Tho" };

export function humanize(value: string): string {
  const special = SPECIAL_LABELS[value.toLowerCase()];
  if (special) return special;
  const text = value.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Chip texts in `CAR_CHIP_KEYS` order, then the region. */
export function chipsFor(row: Pick<ListingFields, "attributes" | "region">): string[] {
  const a = row.attributes ?? {};
  const out: string[] = [];
  for (const key of CAR_CHIP_KEYS) {
    const v = a[key];
    if (v === undefined || v === "") continue;
    if (key === "odo_km" && typeof v === "number") out.push(formatKm(v));
    else if (UPPER_CHIPS.has(key) && typeof v === "string") out.push(v.toUpperCase());
    else out.push(typeof v === "string" ? humanize(v) : String(v));
  }
  if (row.region) out.push(humanize(row.region));
  return out;
}

function Thumb({ url, broken, onBroken }: { url: string | null; broken: boolean; onBroken: () => void }) {
  if (!url || broken) {
    return (
      <div data-thumb-placeholder="true" className="flex h-[72px] w-24 shrink-0 items-center justify-center rounded-md bg-surface-2 max-sm:col-start-1 max-sm:row-span-6 max-sm:row-start-1">
        <Icon icon={ImageOff} />
      </div>
    );
  }
  return <img src={url} alt="" width={96} height={72} loading="lazy" onError={onBroken} className="h-[72px] w-24 shrink-0 rounded-md object-cover max-sm:col-start-1 max-sm:row-span-6 max-sm:row-start-1" />;
}

function PriceBlock({ row }: { row: ListingCardRow }) {
  if (row.priceSuspect) return null;
  if (row.priceVnd == null) return <span aria-hidden="true" className="hidden h-6 sm:block" />;
  return <span className="text-fs-md font-medium leading-6 tabular-nums text-foreground">{formatPriceQualified(row.priceVnd, row.priceQualifier, row.priceMaxVnd)}</span>;
}

const CTA = "inline-flex h-7 items-center gap-1 rounded-md border border-transparent px-2 text-fs-sm text-muted-foreground hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const ICON_CTA = "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-transparent text-muted-foreground hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export interface ListingCardProps {
  row: ListingCardRow;
  sourceName: string;
  /** Fixed clock for tests. */
  now?: Date;
  /** Extra line under the meta line (matches: watch name, terms, notification state). */
  footer?: ReactNode;
  /** Compare checkbox; absent = no checkbox. */
  compare?: { checked: boolean; disabled: boolean; onChange: (checked: boolean) => void };
}

/** Listing card: thumbnail, title, chips, price and deal badge, one-click actions. */
export function ListingCard({ row, sourceName, now, footer, compare }: ListingCardProps) {
  const navigate = useNavigate();
  const flag = usePostFlag();
  const [savedOverride, setSaved] = useState<boolean | null>(null);
  const saved = savedOverride ?? row.saved;
  const [hidden, setHidden] = useState(false);
  const [undoOpen, setUndoOpen] = useState(false);
  const [broken, setBroken] = useState(false);
  const putRef = useRef<Promise<boolean>>(Promise.resolve(true));

  useEffect(() => {
    if (!undoOpen) return;
    const t = setTimeout(() => setUndoOpen(false), UNDO_MS);
    return () => clearTimeout(t);
  }, [undoOpen]);

  if (hidden) {
    if (!undoOpen) return null;
    return (
      <li data-listing-hidden="true" className="flex items-center gap-2 border-t border-line py-2 text-fs-sm text-muted-foreground first:border-t-0">
        <span>Listing hidden.</span>
        <button
          type="button"
          className={CTA}
          onClick={() => {
            setHidden(false);
            setUndoOpen(false);
            // The DELETE goes out only after the PUT has settled, so the server never sees them reordered.
            void putRef.current.then((putOk) => {
              if (putOk) flag.mutate({ id: row.id, kind: "hidden", on: false, repostKey: row.repostKey }, { onError: () => setHidden(true) });
            });
          }}
        >
          <Icon icon={Undo2} />
          Undo
        </button>
      </li>
    );
  }

  const text = row.displayTitle?.trim() || displayTitle(row.title, row.snippet ?? null);
  const dim = row.intent === "other";
  const clock = now ?? new Date();
  const seen = { relative: formatRelative(row.firstSeenAt, clock), absolute: formatAbsolute(row.firstSeenAt) };
  const chips = chipsFor(row);
  const badge = dealBadge(row.dealPct);
  const platform = platformOfUrl(row.url);
  const groups = new Set([row.sourceId, ...row.alsoIn.map((a) => a.sourceId)]).size;
  const meta = [sourceName, row.region ? humanize(row.region) : null].filter((x): x is string => x !== null);

  const toggleSaved = () => {
    const next = !saved;
    setSaved(next);
    flag.mutate({ id: row.id, kind: "saved", on: next }, { onError: () => setSaved(!next) });
  };
  const hide = () => {
    setHidden(true);
    setUndoOpen(true);
    putRef.current = flag.mutateAsync({ id: row.id, kind: "hidden", on: true, repostKey: row.repostKey }).then(
      () => true,
      () => {
        setHidden(false);
        return false;
      },
    );
  };

  return (
    <li
      data-listing-card={row.id}
      data-dim={dim ? "true" : undefined}
      className={cn("group grid grid-cols-[6rem_minmax(0,1fr)] items-start gap-x-3 border-t border-line py-3 first:border-t-0 sm:flex sm:gap-3", dim && "text-muted-foreground")}
    >
      <Thumb url={row.thumbUrl} broken={broken} onBroken={() => setBroken(true)} />
      <div className="contents sm:block sm:min-w-0 sm:flex-1">
        <div className="flex min-w-0 items-center gap-2 max-sm:col-start-2">
          {!row.thumbUrl || broken ? <SourceAvatar sourceId={row.sourceId} name={sourceName} /> : null}
          <Link
            to={`/posts/${row.id}`}
            title={text ?? "(no text)"}
            className={cn("block min-w-0 truncate text-fs-md hover:underline", dim ? "text-muted-foreground" : "text-foreground")}
          >
            {text ?? <span className="text-muted-foreground">(no text)</span>}
          </Link>
        </div>
        {chips.length > 0 ? (
          <ul aria-label="Attributes" className="mt-1 flex flex-wrap gap-1 max-sm:col-start-2">
            {chips.map((c, i) => (
              <li key={`${c}-${i}`} data-chip="true" className="rounded-full bg-surface-2 px-1.5 py-px text-xs text-muted-foreground">
                {c}
              </li>
            ))}
          </ul>
        ) : null}
        <p className="mt-1 flex min-w-0 items-center gap-1 text-fs-sm text-muted-foreground max-sm:col-start-2">
          <span className="truncate" title={meta.join(" · ")}>
            {meta.join(" · ")}
          </span>
          <span className="shrink-0" title={seen.absolute}>
            &middot; {seen.relative}
          </span>
        </p>
        {footer ? <div className="max-sm:col-start-2">{footer}</div> : null}
        <div className="mt-1 flex flex-wrap items-center gap-1 max-sm:col-span-2 max-sm:col-start-1 max-sm:row-start-7 max-sm:mt-2">
          <a
            href={row.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-primary px-2.5 text-fs-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {platform.openLabel} ↗
          </a>
          {compare ? (
            <label className="inline-flex h-7 items-center gap-1 px-1 text-fs-sm text-muted-foreground">
              <input type="checkbox" checked={compare.checked} disabled={compare.disabled && !compare.checked} onChange={(e) => compare.onChange(e.target.checked)} />
              Compare
            </label>
          ) : null}
          <button type="button" aria-label="Save" title="Save" aria-pressed={saved} onClick={toggleSaved} className={cn(ICON_CTA, saved && "text-foreground")}>
            <Icon icon={Bookmark} tone={saved ? "accent" : "muted"} />
          </button>
          <button type="button" aria-label="Not interested" title="Not interested" onClick={hide} className={ICON_CTA}>
            <Icon icon={EyeOff} />
          </button>
          <button
            type="button"
            aria-label="Add to watch"
            title="Add to watch"
            onClick={() => navigate("/watches/new", { state: { draft: watchDraftFromListing(row) } })}
            className={ICON_CTA}
          >
            <Icon icon={Plus} />
          </button>
          {row.hasPhone ? (
            <a href={row.url} target="_blank" rel="noopener noreferrer" aria-label={platform.phoneLabel} title={platform.phoneLabel} className={ICON_CTA}>
              <Icon icon={Phone} tone="muted" />
            </a>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 flex-row flex-wrap items-center gap-x-3 gap-y-0.5 max-sm:col-start-2 max-sm:row-start-2 sm:w-auto sm:flex-col sm:items-end sm:text-right">
        <PriceBlock row={row} />
        {row.priceSuspect ? (
          <span className="inline-flex items-center gap-1 text-xs text-warn">
            <Icon icon={AlertTriangle} tone="warn" />
            Price unclear
          </span>
        ) : null}
        {row.intent ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span data-intent-dot={row.intent} aria-hidden="true" className={cn("h-1.5 w-1.5 rounded-full", INTENT_DOT[row.intent])} />
            {row.intent}
          </span>
        ) : null}
        {row.priceSuspect ? null : <MarketStrip medianVnd={row.dealMedianVnd} n={row.dealN} />}
        {badge && !row.priceSuspect ? (
          <span
            data-deal-badge={badge.tone}
            className={cn("rounded-full px-2 py-0.5 text-fs-sm tabular-nums", badge.tone === "good" ? "bg-good-soft text-good" : "bg-surface-2 text-muted-foreground")}
          >
            {badge.text}
          </span>
        ) : null}
        {groups >= 2 ? <span className="text-fs-sm text-muted-foreground">posted in {groups} {platform.groupWord}s</span> : null}
      </div>
    </li>
  );
}
