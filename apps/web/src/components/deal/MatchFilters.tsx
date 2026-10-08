import { useState } from "react";
import type { Capabilities } from "@feedhound/core/deal-decision";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type FilterParams = Record<string, string>;

/** URL keys owned by the filter bar. */
export const FILTER_KEYS = ["sort", "priceMin", "priceMax", "yearMin", "yearMax", "odoMax", "region", "saved"] as const;

const SORT_LABEL: Record<string, string> = { newest: "Newest", deal: "Best deal", price: "Lowest price", drop: "Price drop" };
const MILLION = 1_000_000;

/** Pick the filter keys out of URL params. */
export function filtersFromParams(sp: URLSearchParams): FilterParams {
  const out: FilterParams = {};
  for (const k of FILTER_KEYS) {
    const v = sp.get(k);
    if (v) out[k] = v;
  }
  return out;
}

interface FieldProps {
  label: string;
  value: string;
  placeholder?: string;
  inputMode?: "numeric" | "text";
  onApply: (v: string) => void;
  className?: string;
}

/** Text field that applies on Enter or blur. */
function Field({ label, value, placeholder, inputMode = "numeric", onApply, className }: FieldProps) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setDraft(value);
  }
  const apply = () => {
    if (draft !== value) onApply(draft.trim());
  };
  return (
    <label className="flex flex-col gap-1 text-fs-sm text-muted-foreground">
      {label}
      <Input
        aria-label={label}
        value={draft}
        placeholder={placeholder}
        inputMode={inputMode}
        className={className ?? "h-8 w-24"}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={apply}
        onKeyDown={(e) => {
          if (e.key === "Enter") apply();
        }}
      />
    </label>
  );
}

export interface MatchFiltersProps {
  value: FilterParams;
  capabilities?: Capabilities;
  onChange: (next: FilterParams) => void;
}

/** Filter bar for /matches. Price is typed in millions and stored in VND. Controls of a false capability are not rendered. */
export function MatchFilters({ value, capabilities, onChange }: MatchFiltersProps) {
  const set = (key: string, v: string | null) => {
    const next = { ...value };
    if (v === null || v === "") delete next[key];
    else next[key] = v;
    onChange(next);
  };
  const million = (key: string): string => {
    const v = value[key];
    if (!v) return "";
    const n = Number(v);
    return Number.isFinite(n) ? String(n / MILLION) : v;
  };
  const setMillion = (key: string) => (text: string) => {
    if (text === "") return set(key, null);
    const n = Number(text.replace(",", "."));
    set(key, Number.isFinite(n) && n >= 0 ? String(Math.round(n * MILLION)) : text);
  };
  const sorts = ["newest", "deal", "price", ...(capabilities?.listing ? ["drop"] : [])];
  return (
    <div role="search" aria-label="Filters" className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-fs-sm text-muted-foreground">
        Sort
        <Select value={value.sort ?? "newest"} onValueChange={(v) => set("sort", v === "newest" ? null : v)}>
          <SelectTrigger className="h-8 w-40" aria-label="Sort">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {sorts.map((s) => (
              <SelectItem key={s} value={s}>
                {SORT_LABEL[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <Field label="Price from (M)" value={million("priceMin")} onApply={setMillion("priceMin")} />
      <Field label="Price to (M)" value={million("priceMax")} onApply={setMillion("priceMax")} />
      <Field label="Year from" value={value.yearMin ?? ""} className="h-8 w-20" onApply={(v) => set("yearMin", v)} />
      <Field label="Year to" value={value.yearMax ?? ""} className="h-8 w-20" onApply={(v) => set("yearMax", v)} />
      <Field label="Max odometer (km)" value={value.odoMax ?? ""} className="h-8 w-28" onApply={(v) => set("odoMax", v)} />
      <Field label="Region" value={value.region ?? ""} inputMode="text" className="h-8 w-32" onApply={(v) => set("region", v)} />
      <label className="flex h-8 items-center gap-2 text-fs-sm text-foreground">
        <input type="checkbox" checked={value.saved === "1"} onChange={(e) => set("saved", e.target.checked ? "1" : null)} />
        Saved only
      </label>
    </div>
  );
}
