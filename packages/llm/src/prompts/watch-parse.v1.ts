import type { RenderedPrompt } from "../client";
import { registerPrompt, type AttributeDefInput, type PromptDefinition, type WatchParsePromptInput } from "../registry";

const SYSTEM_PROMPT =
  "You turn a Vietnamese secondhand-marketplace hunter's one-line request into a structured watch. Reply with a single strict JSON object matching the given schema, no prose, no markdown fences. " +
  "`categorySlugs` must be exactly values from `categories[].slug`; leave the array empty when none fits. " +
  "`itemNames` are the specific product lines or models the hunter named (e.g. \"MacBook Air\"), one entry per line, in the hunter's wording. " +
  "`include` holds extra free-text keywords that fit neither a category nor an item; `exclude` only words the hunter explicitly wants excluded. " +
  "`intents`: `sell` when the hunter wants to find listings of things for sale (\"bán\", \"cần tìm\", or no verb at all), `buy` only when they want posts from people who want to buy. Leave empty when unspecified. " +
  "Prices are integer VND: `25tr`, `25M` and `25 million` = 25000000, `500k` = 500000; use null when no bound is stated. \"dưới\" gives priceMaxVnd, \"trên\"/\"từ\" gives priceMinVnd. " +
  "`attributeFilters` use only keys and values from `attributeSchemas` of the chosen categories. Ops: `eq`, `in` (with `values`), `gte`/`lte` (ordered or number attributes only; \"trở lên\" = gte, \"trở xuống\" = lte). An attribute schema listed under a category is inherited by all its descendants. Never invent a key or value. " +
  "`name` is a short title (max 60 chars) for the watch.";

function describeDef(d: AttributeDefInput): string {
  switch (d.kind) {
    case "enum":
    case "ordered":
      return `${d.kind === "ordered" ? "one of (ascending) " : "one of "}${(d.values ?? []).join(" | ")}`;
    case "text":
      return `free text, max ${d.maxLen ?? 40} chars`;
    case "number":
      return `number${d.unit ? ` (${d.unit})` : ""} ${d.min ?? ""}..${d.max ?? ""}`;
    default:
      return d.kind;
  }
}

export const watchParseV1: PromptDefinition<WatchParsePromptInput> = {
  id: "watch_parse",
  version: 1,
  render(input: WatchParsePromptInput): RenderedPrompt {
    const user = JSON.stringify({
      request: input.text,
      categories: input.categories,
      attributeSchemas: input.attributeSchemas.map((s) => ({
        categorySlug: s.categorySlug,
        attributes: Object.fromEntries(s.schema.map((d) => [d.key, describeDef(d)])),
      })),
      schema: {
        name: "string, 1..60 chars",
        categorySlugs: "array of categories[].slug",
        itemNames: "array of strings",
        include: "array of strings",
        exclude: "array of strings",
        intents: "array of sell | buy | other",
        priceMinVnd: "integer VND or null",
        priceMaxVnd: "integer VND or null",
        attributeFilters: "array of { key, op: eq|in|gte|lte, value?, values? }",
      },
    });
    return { system: SYSTEM_PROMPT, user, version: "1" };
  },
};

registerPrompt(watchParseV1);
