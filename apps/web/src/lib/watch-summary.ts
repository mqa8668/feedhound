import { formatVndShort } from "./format";
import type { AttributeFilterDto, CatalogItemDto, CategoryDto, Intent, WatchDto } from "@/api/types";

export const MAX_WATCH_NAME = 80;

function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/đ/g, "d");
}

/** "m2" -> "M2", "automatic" -> "Automatic": short codes upper-cased, words capitalised. */
export function formatAttrValue(v: string | number): string {
  if (typeof v === "number") return String(v);
  if (v.length <= 3) return v.toUpperCase();
  return v.charAt(0).toUpperCase() + v.slice(1);
}

export const OP_SYMBOL: Record<AttributeFilterDto["op"], string> = { eq: "=", in: "in", gte: "≥", lte: "≤" };

/** Right-hand side of a filter: `M2`, or `A/B` for `in`. */
export function filterValueText(f: AttributeFilterDto): string {
  if (f.op === "in") return (f.values ?? []).map(formatAttrValue).join("/");
  return f.value === undefined ? "" : formatAttrValue(f.value);
}

export function humanizeKey(key: string): string {
  return key.replace(/_/g, " ");
}

/** "MacBook Air" in category "MacBook" -> "Air"; "Mac mini" -> "mini" (first word is a prefix of the category). */
export function shortItemName(item: Pick<CatalogItemDto, "name" | "categoryId">, categories: CategoryDto[]): string {
  const cat = categories.find((c) => c.id === item.categoryId);
  if (!cat) return item.name;
  const name = fold(item.name);
  const catName = fold(cat.name);
  const words = item.name.split(/\s+/);
  const first = fold(words[0] ?? "");
  if (name.startsWith(`${catName} `)) return item.name.slice(cat.name.length).trim();
  if (words.length > 1 && first.length >= 3 && catName.startsWith(first)) return words.slice(1).join(" ");
  return item.name;
}

export function priceText(min: number | null | undefined, max: number | null | undefined): string | null {
  if (min != null && max != null) return `${formatVndShort(min)}–${formatVndShort(max)}`;
  if (max != null) return `≤ ${formatVndShort(max)}`;
  if (min != null) return `≥ ${formatVndShort(min)}`;
  return null;
}

const INTENT_TEXT: Partial<Record<Intent, string>> = { sell: "selling", buy: "buying" };

type SummaryInput = Pick<WatchDto, "include" | "includeAll" | "categoryIds" | "itemIds" | "priceMin" | "priceMax" | "intents"> & {
  attributeFilters?: AttributeFilterDto[];
};

/** One-line card summary, parts joined " · ". */
export function summarizeWatch(w: SummaryInput, ctx: { categories: CategoryDto[]; items: CatalogItemDto[] }): string {
  const parts: string[] = [];
  const itemNames = w.itemIds
    .map((id) => ctx.items.find((i) => i.id === id))
    .filter((i): i is CatalogItemDto => i !== undefined)
    .map((i) => shortItemName(i, ctx.categories));
  const catNames = w.categoryIds.map((id) => ctx.categories.find((c) => c.id === id)?.name).filter((n): n is string => !!n);
  if (itemNames.length > 0) parts.push(itemNames.join(", "));
  else if (catNames.length > 0) parts.push(catNames.join(", "));
  for (const f of w.attributeFilters ?? []) parts.push(`${humanizeKey(f.key)} ${OP_SYMBOL[f.op]} ${filterValueText(f)}`);
  const price = priceText(w.priceMin, w.priceMax);
  if (price) parts.push(price);
  const intents = w.intents.map((i) => INTENT_TEXT[i]).filter((t): t is string => !!t);
  if (intents.length > 0) parts.push(intents.join("/"));
  if (itemNames.length === 0 && catNames.length === 0) {
    if (w.include.length > 0) parts.unshift(`any of: ${w.include.join(", ")}`);
    else if (w.includeAll.length > 0) parts.unshift(`all of: ${w.includeAll.join(", ")}`);
  }
  return parts.join(" · ");
}

/** Next 07:00 in the browser's local time, strictly after `now`. */
export function nextSevenAm(now: Date): Date {
  const d = new Date(now);
  d.setHours(7, 0, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

export function copyName(name: string): string {
  const suffix = " (copy)";
  return name.length + suffix.length <= MAX_WATCH_NAME ? name + suffix : name.slice(0, MAX_WATCH_NAME - suffix.length) + suffix;
}
