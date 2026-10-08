import type { AttributeFilterDto, Intent } from "@/api/types";

export interface WatchTemplate {
  id: string;
  title: string;
  hint: string;
  name: string;
  /** Category slug; skipped silently when `/api/categories` has no such slug. */
  categorySlug?: string;
  include: string[];
  attributeFilters: AttributeFilterDto[];
  intents: Intent[];
  priceMax?: number;
}

export const WATCH_TEMPLATES: WatchTemplate[] = [
  { id: "macbook", title: "MacBook M-series", hint: "M2 chip or newer, for sale", name: "MacBook M-series", categorySlug: "macbook", include: [], attributeFilters: [{ key: "chip", op: "gte", value: "m2" }], intents: ["sell"] },
  { id: "iphone", title: "Used iPhone under 15M", hint: "Used iPhone under 15M, for sale", name: "Used iPhone under 15M", categorySlug: "iphone", include: [], attributeFilters: [], intents: ["sell"], priceMax: 15_000_000 },
  { id: "espresso", title: "Espresso machines", hint: "Espresso coffee machines", name: "Espresso machines", categorySlug: "espresso", include: ["espresso machine", "coffee machine", "espresso", "máy pha cà phê", "máy pha cafe"], attributeFilters: [], intents: ["sell"] },
  { id: "blank", title: "Blank", hint: "Start from scratch", name: "", include: [], attributeFilters: [], intents: [] },
];
