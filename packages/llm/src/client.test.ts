import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createLlmClient } from "./client";

const SCHEMA = z.object({ ok: z.boolean() }).strict();
const PROMPT = { system: "sys", user: "user", version: "1" };
const API_KEY = "secret-test-key-123";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("createLlmClient", () => {
  test("requests non-streaming completions", async () => {
    let body: { stream?: unknown } = {};
    const fetchMock = (async (_u: unknown, init?: RequestInit): Promise<Response> => {
      body = JSON.parse(String(init?.body)) as { stream?: unknown };
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({ ok: true }) } }] });
    }) as unknown as typeof fetch;
    const client = createLlmClient({ baseUrl: "http://example.invalid", apiKey: API_KEY, fetch: fetchMock, timeoutMs: 5000, maxRetries: 0 });
    await client.complete({ model: "m", prompt: PROMPT, schema: SCHEMA });
    expect(body.stream).toBe(false);
  });

  test.each([
    ["fenced with lang", "```json\n{\"ok\":true}\n```", true],
    ["fenced without lang", "  ```\n{\"ok\":true}\n```  ", true],
    ["one-line fence with lang and space", "```json {\"ok\":true}```", true],
    ["one-line fence with lang, no space", "```json{\"ok\":true}```", true],
    ["one-line fence without lang", "```{\"ok\":true}```", true],
    ["unfenced", "{\"ok\":true}", true],
    ["prose around json", "Here you go: {\"ok\":true}", false],
    ["prose before fence", "Sure!\n```json\n{\"ok\":true}\n```", false],
  ])("fence handling: %s", async (_n, content, expected) => {
    const fetchMock = (async (): Promise<Response> => jsonResponse({ choices: [{ message: { content } }] })) as unknown as typeof fetch;
    const client = createLlmClient({ baseUrl: "http://example.invalid", apiKey: API_KEY, fetch: fetchMock, timeoutMs: 5000, maxRetries: 0 });
    const r = await client.complete({ model: "m", prompt: PROMPT, schema: SCHEMA });
    expect(r.ok).toBe(expected);
  });

  test("retries HTTP 5xx up to maxRetries then succeeds", async () => {
    let calls = 0;
    const fetchMock = (async (): Promise<Response> => {
      calls++;
      if (calls < 3) return new Response("server error", { status: 500 });
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify({ ok: true }) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }) as unknown as typeof fetch;

    const client = createLlmClient({ baseUrl: "http://example.invalid", apiKey: API_KEY, fetch: fetchMock, timeoutMs: 5000, maxRetries: 2 });
    const result = await client.complete({ model: "m", prompt: PROMPT, schema: SCHEMA });

    expect(result.ok).toBe(true);
    expect(calls).toBe(3);
  }, 10_000);

  test("gives up after maxRetries and does not throw", async () => {
    const fetchMock = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const client = createLlmClient({ baseUrl: "http://example.invalid", apiKey: API_KEY, fetch: fetchMock, timeoutMs: 5000, maxRetries: 1 });
    const result = await client.complete({ model: "m", prompt: PROMPT, schema: SCHEMA });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("http");
  }, 10_000);

  test("does not retry non-429 4xx", async () => {
    let calls = 0;
    const fetchMock = (async () => {
      calls++;
      return new Response("bad request", { status: 400 });
    }) as unknown as typeof fetch;
    const client = createLlmClient({ baseUrl: "http://example.invalid", apiKey: API_KEY, fetch: fetchMock, timeoutMs: 5000, maxRetries: 3 });
    const result = await client.complete({ model: "m", prompt: PROMPT, schema: SCHEMA });
    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
  });

  test("hanging fetch times out within timeoutMs + 100ms", async () => {
    const timeoutMs = 200;
    const fetchMock = ((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }) as unknown as typeof fetch;

    const client = createLlmClient({ baseUrl: "http://example.invalid", apiKey: API_KEY, fetch: fetchMock, timeoutMs, maxRetries: 0 });
    const start = performance.now();
    const result = await client.complete({ model: "m", prompt: PROMPT, schema: SCHEMA });
    const elapsed = performance.now() - start;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("timeout");
    expect(elapsed).toBeLessThan(timeoutMs + 100);
  });

  test("network error is reported as reason=network", async () => {
    const fetchMock = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const client = createLlmClient({ baseUrl: "http://example.invalid", apiKey: API_KEY, fetch: fetchMock, timeoutMs: 1000, maxRetries: 0 });
    const result = await client.complete({ model: "m", prompt: PROMPT, schema: SCHEMA });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("network");
  });

  test("failures never leak the API key", async () => {
    const fetchMock = (async () => new Response("unauthorized body", { status: 401 })) as unknown as typeof fetch;
    const client = createLlmClient({ baseUrl: "http://example.invalid", apiKey: API_KEY, fetch: fetchMock, timeoutMs: 1000, maxRetries: 0 });
    const result = await client.complete({ model: "m", prompt: PROMPT, schema: SCHEMA });
    const serialized = JSON.stringify(result);
    expect(serialized.includes(API_KEY)).toBe(false);
  });
});
