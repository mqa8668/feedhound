/** OpenAI-compatible `POST /chat/completions` mock for the e2e suite. */

export interface LlmMock {
  baseUrl: string;
  requests: { auth: string; body: unknown }[];
  /** Resolves when a request whose body contains `marker` arrives; that request is answered `ms` later. */
  holdNext(marker: string, ms: number): Promise<void>;
  close(): void;
}

const ANSWER = { intent: "sell", priceVnd: 1500000, condition: "used", categorySlug: null, itemName: null, confidence: 0.9 };

export function createLlmMock(): LlmMock {
  const requests: LlmMock["requests"] = [];
  const holds: { marker: string; ms: number; arrived: () => void }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (req.method !== "POST" || !new URL(req.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
      const raw = await req.text();
      let body: unknown = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        /* keep raw text */
      }
      requests.push({ auth: req.headers.get("authorization") ?? "", body });
      const idx = holds.findIndex((h) => raw.includes(h.marker));
      if (idx >= 0) {
        const [hold] = holds.splice(idx, 1);
        hold!.arrived();
        await new Promise((r) => setTimeout(r, hold!.ms));
      }
      return Response.json({
        choices: [{ message: { content: JSON.stringify(ANSWER) } }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    requests,
    holdNext: (marker, ms) => new Promise<void>((resolve) => holds.push({ marker, ms, arrived: resolve })),
    close: () => void server.stop(true),
  };
}
