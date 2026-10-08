import { z } from "zod";
import type { RenderedPrompt } from "../client";
import { registerPrompt, type EnrichPromptInput, type PromptDefinition } from "../registry";
import { EnrichOutputV2, enrichV2 } from "./enrich.v2";

const V3_SENTENCE =
  " `trendTerms` lists up to 5 canonical names of what the post is about: a product model with variant or year, a brand, a product type of at least two words, or a notable event. Use the original language and canonical capitalisation. Never phone numbers, prices, person names, a place alone or generic words.";

/** v2 output plus entity trend terms; advisory, bad values never reject the output. */
export const EnrichOutputV3 = EnrichOutputV2.extend({
  trendTerms: z.array(z.string().max(48)).max(8).catch([]),
});

export const enrichV3: PromptDefinition<EnrichPromptInput> = {
  id: "enrich",
  version: 5,
  render(input: EnrichPromptInput): RenderedPrompt {
    const base = enrichV2.render(input);
    const parsed = JSON.parse(base.user) as { schema: Record<string, string> };
    parsed.schema.trendTerms = "array of up to 5 canonical entity names (model + variant/year, brand, product type, event)";
    return { system: base.system + V3_SENTENCE, user: JSON.stringify(parsed), version: "5" };
  },
};

registerPrompt(enrichV3);
