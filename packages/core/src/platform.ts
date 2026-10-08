export type PlatformKey = "web";

export interface PlatformInfo {
  key: PlatformKey;
  label: string;
  openLabel: string;
  phoneLabel: string;
  groupWord: string;
}

const WEB: PlatformInfo = { key: "web", label: "Web", openLabel: "Open original", phoneLabel: "Show phone at original post", groupWord: "source" };

/** Platform of a post/listing url. Pure; every url currently maps to the generic `web` platform. */
export function platformOfUrl(_url: string | null | undefined): PlatformInfo {
  return WEB;
}
