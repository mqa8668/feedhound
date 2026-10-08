// Server-only (node:crypto); keep out of browser bundles. Pure text helpers live in ./normalize.
import { createHash } from "node:crypto";
import { authorKey, fingerprintText } from "./normalize";

/** sha256 hex of scope + author + text; null when the text has no fingerprintable content. */
export function postFingerprint(i: {
  scopeId: string;
  authorId?: string | null;
  authorName?: string | null;
  text: string;
}): string | null {
  const t = fingerprintText(i.text);
  if (t === "") return null;
  return createHash("sha256").update(`${i.scopeId}\u001f${authorKey(i)}\u001f${t}`).digest("hex");
}
