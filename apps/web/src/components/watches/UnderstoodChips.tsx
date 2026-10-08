import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Icon } from "@/components/ui/Icon";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { filterValueText, formatAttrValue, OP_SYMBOL, priceText, shortItemName } from "@/lib/watch-summary";
import type { AttributeDefDto, AttributeFilterDto, CatalogItemDto, CategoryDto, Intent } from "@/api/types";

export interface UnderstoodValues {
  categoryIds: string[];
  itemIds: string[];
  attributeFilters: AttributeFilterDto[];
  priceMin?: number;
  priceMax?: number;
  intents: Intent[];
}

export interface UnderstoodChipsProps {
  values: UnderstoodValues;
  categories: CategoryDto[];
  items: CatalogItemDto[];
  onChange: (patch: Partial<UnderstoodValues>) => void;
}

const CHIP = "inline-flex h-8 items-center rounded-full border border-line-strong bg-surface-2 text-fs-sm";
const CHIP_MAIN = "h-8 rounded-l-full px-3 hover:bg-surface-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const CHIP_X = "inline-flex h-8 w-8 items-center justify-center rounded-r-full hover:bg-surface-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const CHIP_ADD = "inline-flex h-8 items-center gap-1 rounded-full border border-dashed border-line-strong px-3 text-fs-sm text-muted-foreground hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const INTENT_LABEL: Record<Intent, string> = { sell: "sell", buy: "buy", other: "other" };
const INTENTS: Intent[] = ["sell", "buy", "other"];

function Chip({ label, onEdit, onRemove, active }: { label: string; onEdit?: () => void; onRemove: () => void; active?: boolean }) {
  return (
    <span className={cn(CHIP, active && "border-accent")}>
      {onEdit ? (
        <button type="button" className={CHIP_MAIN} onClick={onEdit} aria-expanded={active}>
          {label}
        </button>
      ) : (
        <span className="px-3">{label}</span>
      )}
      <button type="button" className={CHIP_X} aria-label={`Remove ${label}`} onClick={onRemove}>
        <Icon icon={X} />
      </button>
    </span>
  );
}

function opsFor(def: AttributeDefDto | undefined): AttributeFilterDto["op"][] {
  if (!def) return ["eq"];
  if (def.kind === "enum") return ["eq", "in"];
  if (def.kind === "text") return ["eq"];
  return ["gte", "lte", "eq"];
}

function defaultFilter(def: AttributeDefDto): AttributeFilterDto | null {
  if (def.kind === "enum") return def.values[0] ? { key: def.key, op: "in", values: [def.values[0]] } : null;
  if (def.kind === "ordered") return def.values[0] ? { key: def.key, op: "gte", value: def.values[0] } : null;
  if (def.kind === "number") return { key: def.key, op: "gte", value: def.min };
  return null;
}

function AttributeEditor({ filter, def, onChange }: { filter: AttributeFilterDto; def: AttributeDefDto | undefined; onChange: (f: AttributeFilterDto | null) => void }) {
  if (def?.kind === "enum") {
    const chosen = filter.op === "in" ? (filter.values ?? []) : filter.value !== undefined ? [filter.value] : [];
    return (
      <fieldset className="flex flex-wrap gap-3">
        <legend className="sr-only">{def.label}</legend>
        {def.values.map((v) => (
          <label key={v} className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={chosen.includes(v)}
              onChange={() => {
                const next = chosen.includes(v) ? chosen.filter((c) => c !== v) : [...chosen, v];
                onChange(next.length === 0 ? null : { key: filter.key, op: "in", values: next });
              }}
            />
            {formatAttrValue(v)}
          </label>
        ))}
      </fieldset>
    );
  }
  const ops = opsFor(def);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={filter.op} onValueChange={(op) => onChange({ ...filter, op: op as AttributeFilterDto["op"] })}>
        <SelectTrigger className="w-20" aria-label="Comparison">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ops.map((op) => (
            <SelectItem key={op} value={op}>
              {OP_SYMBOL[op]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {def?.kind === "ordered" ? (
        <Select value={String(filter.value ?? "")} onValueChange={(value) => onChange({ ...filter, value })}>
          <SelectTrigger className="w-32" aria-label="Value">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {def.values.map((v) => (
              <SelectItem key={v} value={v}>
                {formatAttrValue(v)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          aria-label="Value"
          className="w-32"
          type={def?.kind === "number" ? "number" : "text"}
          value={filter.value ?? ""}
          onChange={(e) => {
            const raw = e.target.value;
            if (def?.kind === "number") {
              const n = Number(raw);
              if (raw !== "" && !Number.isNaN(n)) onChange({ ...filter, value: n });
            } else onChange({ ...filter, value: raw });
          }}
        />
      )}
    </div>
  );
}

/** "Understood as" chips: click edits, x removes, "+" adds. */
export function UnderstoodChips({ values, categories, items, onChange }: UnderstoodChipsProps) {
  const [editing, setEditing] = useState<string | null>(null);

  const defs = new Map<string, AttributeDefDto>();
  for (const id of values.categoryIds) {
    for (const d of categories.find((c) => c.id === id)?.attributeSchema ?? []) if (!defs.has(d.key)) defs.set(d.key, d);
  }
  const unusedDefs = [...defs.values()].filter((d) => d.kind !== "text" && !values.attributeFilters.some((f) => f.key === d.key));

  const setFilters = (next: AttributeFilterDto[]) => onChange({ attributeFilters: next });
  const toggle = (key: string) => setEditing((cur) => (cur === key ? null : key));
  const price = priceText(values.priceMin, values.priceMax);

  const editor = (() => {
    if (!editing) return null;
    if (editing === "price") {
      return (
        <div className="grid grid-cols-2 gap-2 sm:max-w-sm">
          <Input
            aria-label="Price from (VND)"
            type="number"
            value={values.priceMin ?? ""}
            onChange={(e) => onChange({ priceMin: e.target.value === "" ? undefined : Number(e.target.value) })}
          />
          <Input
            aria-label="Price to (VND)"
            type="number"
            value={values.priceMax ?? ""}
            onChange={(e) => onChange({ priceMax: e.target.value === "" ? undefined : Number(e.target.value) })}
          />
        </div>
      );
    }
    if (editing === "intent") {
      return (
        <div className="flex gap-3">
          {INTENTS.map((i) => (
            <label key={i} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={values.intents.includes(i)}
                onChange={() => onChange({ intents: values.intents.includes(i) ? values.intents.filter((x) => x !== i) : [...values.intents, i] })}
              />
              {INTENT_LABEL[i]}
            </label>
          ))}
        </div>
      );
    }
    const idx = Number(editing.replace("attr:", ""));
    const f = values.attributeFilters[idx];
    if (!f) return null;
    return (
      <AttributeEditor
        filter={f}
        def={defs.get(f.key)}
        onChange={(next) => {
          if (next === null) {
            setFilters(values.attributeFilters.filter((_, i) => i !== idx));
            setEditing(null);
          } else setFilters(values.attributeFilters.map((x, i) => (i === idx ? next : x)));
        }}
      />
    );
  })();

  const hasAny = values.categoryIds.length + values.itemIds.length + values.attributeFilters.length > 0 || price !== null || values.intents.length > 0;

  return (
    <div className="flex flex-col gap-2" aria-label="Understood as">
      <p className="text-xs text-muted-foreground">{hasAny ? "Understood as" : "No conditions yet. Describe above or add below."}</p>
      <div className="flex flex-wrap gap-2">
        {values.categoryIds.map((id) => (
          <Chip key={`c-${id}`} label={`Line: ${categories.find((c) => c.id === id)?.name ?? "?"}`} onRemove={() => onChange({ categoryIds: values.categoryIds.filter((x) => x !== id) })} />
        ))}
        {values.itemIds.map((id) => {
          const item = items.find((i) => i.id === id);
          return (
            <Chip key={`i-${id}`} label={`Item: ${item ? shortItemName(item, categories) : "?"}`} onRemove={() => onChange({ itemIds: values.itemIds.filter((x) => x !== id) })} />
          );
        })}
        {values.attributeFilters.map((f, idx) => {
          const def = defs.get(f.key);
          const key = `attr:${idx}`;
          const label = `${def?.label ?? formatAttrValue(f.key.replace(/_/g, " "))} ${OP_SYMBOL[f.op]} ${filterValueText(f)}`;
          return (
            <Chip
              key={`${key}-${f.key}`}
              label={label}
              active={editing === key}
              onEdit={() => toggle(key)}
              onRemove={() => {
                setFilters(values.attributeFilters.filter((_, i) => i !== idx));
                setEditing(null);
              }}
            />
          );
        })}
        {price ? (
          <Chip
            label={`Price ${price}`}
            active={editing === "price"}
            onEdit={() => toggle("price")}
            onRemove={() => {
              onChange({ priceMin: undefined, priceMax: undefined });
              setEditing(null);
            }}
          />
        ) : null}
        {values.intents.length > 0 ? (
          <Chip
            label={`Intent: ${values.intents.map((i) => INTENT_LABEL[i]).join("/")}`}
            active={editing === "intent"}
            onEdit={() => toggle("intent")}
            onRemove={() => {
              onChange({ intents: [] });
              setEditing(null);
            }}
          />
        ) : null}
        {unusedDefs.map((d) => (
          <button
            key={`add-${d.key}`}
            type="button"
            className={CHIP_ADD}
            onClick={() => {
              const f = defaultFilter(d);
              if (!f) return;
              setFilters([...values.attributeFilters, f]);
              setEditing(`attr:${values.attributeFilters.length}`);
            }}
          >
            <Icon icon={Plus} />
            {d.label}
          </button>
        ))}
        {!price ? (
          <button type="button" className={CHIP_ADD} onClick={() => setEditing("price")}>
            <Icon icon={Plus} />
            Price
          </button>
        ) : null}
        {values.intents.length === 0 ? (
          <button
            type="button"
            className={CHIP_ADD}
            onClick={() => {
              onChange({ intents: ["sell"] });
              setEditing("intent");
            }}
          >
            <Icon icon={Plus} />
            Intent
          </button>
        ) : null}
      </div>
      {editor ? <div className="rounded-md border border-line bg-surface-1 p-3">{editor}</div> : null}
    </div>
  );
}
