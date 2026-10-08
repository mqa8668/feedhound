/** Release tag baked into the image (`APP_VERSION` build arg); "dev" outside a release build. */
export function appVersion(env: Record<string, string | undefined> = process.env): string {
  return env.APP_VERSION?.trim() || "dev";
}
