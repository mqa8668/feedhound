import type { ZodType } from "zod";

/** Strips a single wrapping markdown code fence; anything else is returned unchanged. */
function stripCodeFence(text: string): string {
  const m = /^\s*```(?:[A-Za-z0-9_-]+(?=[\s{[]))?\s*([\s\S]*?)\s*```\s*$/.exec(text);
  return m ? (m[1] ?? text) : text;
}

export interface RenderedPrompt {
  system: string;
  user: string;
  version: string;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LlmCompleteRequest<T> {
  model: string;
  prompt: RenderedPrompt;
  schema: ZodType<T>;
}

export type LlmResult<T> =
  | { ok: true; data: T; usage: LlmUsage; model: string; latencyMs: number }
  | { ok: false; reason: "schema" | "http" | "timeout" | "network"; status?: number; raw?: string; usage?: LlmUsage };

export interface LlmClient {
  complete<T>(req: LlmCompleteRequest<T>): Promise<LlmResult<T>>;
}

export interface CreateLlmClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs: number;
  maxRetries: number;
}

/** 500ms base, doubling per retry (0 -> 500ms, 1 -> 1000ms, ...). */
function backoffMs(attempt: number): number {
  return 500 * 2 ** attempt;
}

function isRetryable(result: Extract<LlmResult<unknown>, { ok: false }>): boolean {
  if (result.reason === "network" || result.reason === "timeout") return true;
  if (result.reason === "http") return result.status === undefined || result.status >= 500 || result.status === 429;
  return false;
}

/**
 * OpenAI-compatible chat-completions client. Never throws for model/HTTP
 * errors -- callers always get a discriminated `LlmResult`. `LLM_API_KEY`
 * is only ever placed in the `Authorization` header, never logged here.
 */
export function createLlmClient(opts: CreateLlmClientOptions): LlmClient {
  const fetchImpl = opts.fetch ?? fetch;

  async function attempt<T>(req: LlmCompleteRequest<T>): Promise<LlmResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    const start = performance.now();
    try {
      const res = await fetchImpl(`${opts.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify({
          model: req.model,
          response_format: { type: "json_object" },
          stream: false,
          messages: [
            { role: "system", content: req.prompt.system },
            { role: "user", content: req.prompt.user },
          ],
        }),
        signal: controller.signal,
      });
      const latencyMs = performance.now() - start;

      if (!res.ok) {
        const raw = await res.text().catch(() => "");
        return { ok: false, reason: "http", status: res.status, raw };
      }

      const json = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      const usage: LlmUsage = {
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
        totalTokens: json.usage?.total_tokens ?? 0,
      };
      const content = json.choices?.[0]?.message?.content;
      if (!content) return { ok: false, reason: "schema", raw: "", usage };

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(stripCodeFence(content));
      } catch {
        return { ok: false, reason: "schema", raw: content, usage };
      }

      const parsed = req.schema.safeParse(parsedJson);
      if (!parsed.success) return { ok: false, reason: "schema", raw: content, usage };

      return { ok: true, data: parsed.data, usage, model: req.model, latencyMs };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return { ok: false, reason: "timeout" };
      return { ok: false, reason: "network" };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async complete<T>(req: LlmCompleteRequest<T>): Promise<LlmResult<T>> {
      let last: LlmResult<T> | undefined;
      for (let i = 0; i <= opts.maxRetries; i++) {
        const result = await attempt(req);
        if (result.ok) return result;
        last = result;
        if (i === opts.maxRetries || !isRetryable(result)) break;
        await new Promise((resolve) => setTimeout(resolve, backoffMs(i)));
      }
      return last as LlmResult<T>;
    },
  };
}
