import { createDb, schema } from "@feedhound/db";
import { eq } from "drizzle-orm";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const LEN = 8;
const TTL_MS = 24 * 60 * 60 * 1000;

/** CSPRNG code generation (`crypto.getRandomValues`), rejection-sampled to avoid modulo bias. */
export function randomCode(): string {
  let out = "";
  const rejectAt = 256 - (256 % ALPHABET.length);
  const buf = new Uint8Array(1);
  while (out.length < LEN) {
    crypto.getRandomValues(buf);
    const b = buf[0]!;
    if (b >= rejectAt) continue;
    out += ALPHABET[b % ALPHABET.length];
  }
  return out;
}

/** `bun run --cwd apps/bot link-code <email>`. */
export async function generateLinkCode(email: string): Promise<string> {
  const handle = createDb();
  try {
    const code = randomCode();
    const linkCodeExpiresAt = new Date(Date.now() + TTL_MS);
    const [row] = await handle.db.update(schema.user).set({ linkCode: code, linkCodeExpiresAt }).where(eq(schema.user.email, email)).returning({ id: schema.user.id });
    if (!row) throw new Error(`no user with email ${email}`);
    return code;
  } finally {
    await handle.close();
  }
}

if (import.meta.main) {
  const email = process.argv[2];
  if (!email) {
    console.error("usage: link-code <email>");
    process.exit(1);
  }
  const code = await generateLinkCode(email);
  console.log(code);
}
