// LLM access for the API process (same env contract as the agent: LLM_BASE_URL / LLM_API_KEY).

import type { DbHandle } from "@feedhound/db";
import { schema } from "@feedhound/db";
import { createLlmClient, type LlmClient } from "@feedhound/llm";
import { desc, eq } from "drizzle-orm";

/** Resolves the LLM client, or `null` when the env is not configured. Injectable for tests. */
export type LlmProvider = () => Promise<LlmClient | null>;

/** Latest value of a Config key, `undefined` when unset. */
export async function readConfigValue(handle: DbHandle, key: string): Promise<unknown> {
  const [row] = await handle.db
    .select({ value: schema.config.value })
    .from(schema.config)
    .where(eq(schema.config.key, key))
    .orderBy(desc(schema.config.version))
    .limit(1);
  return row?.value;
}

export async function readConfigNumber(handle: DbHandle, key: string, fallback: number): Promise<number> {
  const v = await readConfigValue(handle, key);
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export async function readConfigString(handle: DbHandle, key: string, fallback: string): Promise<string> {
  const v = await readConfigValue(handle, key);
  return typeof v === "string" ? v : fallback;
}

/** Client built from `LLM_BASE_URL` / `LLM_API_KEY` (created on first use, timeouts from Config); `null` if either is unset. */
export function envLlmProvider(handle: DbHandle): LlmProvider {
  let client: LlmClient | undefined;
  return async () => {
    const baseUrl = process.env.LLM_BASE_URL;
    const apiKey = process.env.LLM_API_KEY;
    if (!baseUrl || !apiKey) return null;
    client ??= createLlmClient({
      baseUrl,
      apiKey,
      timeoutMs: await readConfigNumber(handle, "llm.timeoutMs", 30_000),
      maxRetries: await readConfigNumber(handle, "llm.maxRetries", 2),
    });
    return client;
  };
}
