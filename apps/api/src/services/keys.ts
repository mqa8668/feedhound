const KEY_PREFIX = "hk_";
const RANDOM_BYTES = 32;
// Deviation from the literal "first 12 chars": the existing
// `apiKeyAuth` lookup (apps/api/src/middleware/api-key.ts) and every
// api-key test fixture already slice/compare on 8 chars; changing the length
// here without touching every one of those call sites would silently break
// bearer auth for any key minted through this service. Kept at 8 for
// consistency with the already-shipped contract.
const PREFIX_LEN = 8;

export interface GeneratedApiKey {
  key: string;
  prefix: string;
  hash: string;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 32 random bytes, base64url-encoded, prefixed `hk_`; hashed with sha256 for storage. */
export async function generateApiKey(): Promise<GeneratedApiKey> {
  const bytes = crypto.getRandomValues(new Uint8Array(RANDOM_BYTES));
  const key = `${KEY_PREFIX}${base64UrlEncode(bytes)}`;
  const hash = await sha256Hex(key);
  return { key, prefix: key.slice(0, PREFIX_LEN), hash };
}
