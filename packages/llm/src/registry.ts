import type { RenderedPrompt } from "./client";

/** Structural view of core's `AttributeDef` (llm must not depend on core). */
export interface AttributeDefInput {
  key: string;
  label: string;
  kind: string;
  values?: string[];
  unit?: string;
  min?: number;
  max?: number;
  maxLen?: number;
}

export interface EnrichPromptInput {
  text: string;
  /** Candidate categories that carry an attribute schema; omitted/empty when none. */
  attributeSchemas?: { categorySlug: string; schema: AttributeDefInput[] }[];
  candidates: {
    categories: { slug: string; name: string }[];
    items: { name: string; categorySlug: string }[];
  };
  ruleHint: {
    intent: "sell" | "buy" | "other";
    priceVnd: number | null;
    condition: string;
    categoryId: string | null;
    itemId: string | null;
    confidence: number;
    hits: string[];
  };
}

export interface WatchParsePromptInput {
  text: string;
  categories: { slug: string; name: string }[];
  /** Attribute schemas of categories that declare one. */
  attributeSchemas: { categorySlug: string; schema: AttributeDefInput[] }[];
}

export interface HuntBootstrapPromptInput {
  target: string;
  categories: { slug: string; name: string }[];
}

export interface TrendCuratePromptInput {
  terms: { key: string; display: string; count: number }[];
}

export interface PromptDefinition<I = EnrichPromptInput> {
  id: string;
  version: number;
  render(input: I): RenderedPrompt;
}

// Heterogeneous store: callers pick the input type through `getPrompt<I>`.
const registry = new Map<string, PromptDefinition<unknown>[]>();

/** Registers a prompt version. Called once by each `prompts/*.ts` module at import time. */
export function registerPrompt<I>(def: PromptDefinition<I>): void {
  const list = registry.get(def.id) ?? [];
  list.push(def as PromptDefinition<unknown>);
  registry.set(def.id, list);
}

/** Highest-version prompt registered for `id`. Throws if none is registered. */
export function getPrompt<I = EnrichPromptInput>(id: string): PromptDefinition<I> {
  const list = registry.get(id);
  if (!list || list.length === 0) throw new Error(`no prompt registered for id: ${id}`);
  return list.reduce((best, candidate) => (candidate.version > best.version ? candidate : best)) as PromptDefinition<I>;
}

export function promptVersionOf<I>(def: PromptDefinition<I>): string {
  return `${def.id}@${def.version}`;
}
