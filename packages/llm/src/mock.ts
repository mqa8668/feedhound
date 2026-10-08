import type { LlmClient, LlmCompleteRequest, LlmResult } from "./client";

export type ScriptedResponse = LlmResult<unknown> | ((req: LlmCompleteRequest<unknown>) => LlmResult<unknown>);

export interface MockLlmClient extends LlmClient {
  /** Every request seen by `complete`, in order. */
  calls: LlmCompleteRequest<unknown>[];
}

/**
 * Test double for `LlmClient`. `responses` is consumed in order; once
 * exhausted, the last entry repeats for further calls.
 */
export function createMockLlmClient(responses: ScriptedResponse[]): MockLlmClient {
  const calls: LlmCompleteRequest<unknown>[] = [];
  let i = 0;

  return {
    calls,
    async complete<T>(req: LlmCompleteRequest<T>): Promise<LlmResult<T>> {
      calls.push(req as LlmCompleteRequest<unknown>);
      const index = Math.min(i, responses.length - 1);
      const scripted = responses[index];
      i++;
      if (typeof scripted === "function") return scripted(req as LlmCompleteRequest<unknown>) as LlmResult<T>;
      return scripted as LlmResult<T>;
    },
  };
}
