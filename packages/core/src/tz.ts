export const DEFAULT_TZ = "Asia/Ho_Chi_Minh";

/** IANA-style Area/Location names only (Postgres would read "+07:00" as a flipped POSIX offset); canonicalised via Intl. Never throws. */
export function validTz(v: string | null | undefined): string {
  if (!v || /^[+-]/.test(v) || /^(UTC|GMT)[+-]/i.test(v) || !v.includes("/")) return DEFAULT_TZ;
  try {
    return new Intl.DateTimeFormat("en", { timeZone: v }).resolvedOptions().timeZone;
  } catch {
    return DEFAULT_TZ;
  }
}
