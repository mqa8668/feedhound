import type { NotifierKind, Notifier } from "@feedhound/core/notifiers";
import { createTelegramNotifier } from "./telegram";

export { createTelegramNotifier } from "./telegram";

/** Builds the `kind -> Notifier` map used by the `notify*` agent jobs. `botToken` undefined -> telegram omitted. */
export function buildNotifierMap(opts: { botToken?: string; apiBase?: string }): Partial<Record<NotifierKind, Notifier>> {
  const map: Partial<Record<NotifierKind, Notifier>> = {};
  if (opts.botToken) {
    map.telegram = createTelegramNotifier({ botToken: opts.botToken, apiBase: opts.apiBase });
  }
  return map;
}
