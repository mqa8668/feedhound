import { z } from "zod";
import type { RenderedPrompt } from "../client";
import { registerPrompt, type EnrichPromptInput, type PromptDefinition } from "../registry";
import { EnrichOutput } from "../schema";
import { enrichV1 } from "./enrich.v1";

// llm must not depend on core: the tag list is mirrored from core `INTENT_TAGS`.
const KNOWN_TAGS: readonly string[] = ["buy", "sell", "ask", "complain", "review"];
const SENTIMENTS = ["neg", "neu", "pos"] as const;

const V2_SENTENCE =
  " `sentiment` is the overall tone of the post toward its subject: neg, neu or pos. `intentTags` lists which of buy, sell, ask, complain, review apply (0-5 values, no others).";

/** v1 output plus sentiment and intent tags; both are advisory (bad values never reject the output). */
export const EnrichOutputV2 = EnrichOutput.extend({
  sentiment: z
    .enum(SENTIMENTS)
    .nullish()
    .transform((s) => s ?? null)
    .catch(null),
  intentTags: z
    .array(z.string())
    .transform((tags) => [...new Set(tags.filter((t) => KNOWN_TAGS.includes(t)))])
    .catch([]),
});

export const enrichV2: PromptDefinition<EnrichPromptInput> = {
  id: "enrich",
  version: 4,
  render(input: EnrichPromptInput): RenderedPrompt {
    const base = enrichV1.render(input);
    const parsed = JSON.parse(base.user) as { schema: Record<string, string> };
    parsed.schema.sentiment = "neg | neu | pos";
    parsed.schema.intentTags = "array of buy | sell | ask | complain | review (0-5)";
    return { system: base.system + V2_SENTENCE, user: JSON.stringify(parsed), version: "4" };
  },
};

registerPrompt(enrichV2);
