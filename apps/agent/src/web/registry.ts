import { feedConnector } from "./connectors/feed";
import type { SiteConnector } from "./types";

/** A new site = one file in `connectors/` + one line here. */
export const CONNECTORS: ReadonlyMap<string, SiteConnector> = new Map<string, SiteConnector>([
  [feedConnector.id, feedConnector as SiteConnector],
]);

/** Connector for a source `platformId` (`<connectorId>:<query>`). */
export function connectorFor(platformId: string): SiteConnector | undefined {
  const i = platformId.indexOf(":");
  return CONNECTORS.get(i < 0 ? platformId : platformId.slice(0, i));
}
