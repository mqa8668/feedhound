import { z } from "zod";
import type { RenderedPrompt } from "../client";
import { registerPrompt, type PromptDefinition, type TrendCuratePromptInput } from "../registry";

/** Merge spelling variants of one entity, drop generic or non-entity keys. */
export const TrendCurateOutput = z.object({
  merge: z.array(z.object({ canonical: z.string().min(1).max(48), keys: z.array(z.string().max(64)).min(1).max(50) })).max(50),
  drop: z.array(z.string().max(64)).max(100),
});
export type TrendCurateOutputT = z.infer<typeof TrendCurateOutput>;

const SYSTEM =
  "You curate trending terms from a Vietnamese social marketplace feed. Each term has a `key` (lower-case, no spaces), a `display` form and a mention `count`. " +
  "Return JSON `{\"merge\":[{\"canonical\":string,\"keys\":string[]}],\"drop\":string[]}`. " +
  "`merge` groups keys that name the same product, brand or event (spelling variants, missing spaces); `canonical` is its best display name in the original language. " +
  "`drop` lists keys that are generic words, phone numbers, prices, person names or a place alone. Use only keys from the input; leave good, distinct terms out of both lists.";

export const trendCurateV1: PromptDefinition<TrendCuratePromptInput> = {
  id: "trend-curate",
  version: 1,
  render(input: TrendCuratePromptInput): RenderedPrompt {
    return { system: SYSTEM, user: JSON.stringify({ terms: input.terms }), version: "1" };
  },
};

registerPrompt(trendCurateV1);
