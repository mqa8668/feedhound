import type { Button, Notifier, NotifierTarget, OutgoingMessage, SendResult } from "@feedhound/core/notifiers";
import { telegramNotifierConfigSchema } from "@feedhound/core/notifiers";

const SEND_TIMEOUT_MS = 10_000;

function toInlineKeyboard(buttons: Button[][] | undefined): { inline_keyboard: { text: string; url?: string; callback_data?: string }[][] } | undefined {
  if (!buttons || buttons.length === 0) return undefined;
  return {
    inline_keyboard: buttons.map((row) =>
      row.map((b) => ({ text: b.text, ...(b.url ? { url: b.url } : {}), ...(b.callback ? { callback_data: b.callback } : {}) })),
    ),
  };
}

interface TelegramApiOk<T> {
  ok: true;
  result: T;
}
interface TelegramApiErr {
  ok: false;
  error_code: number;
  description: string;
  parameters?: { retry_after?: number };
}

/**
 * Telegram notifier: raw `fetch` to
 * `${TG_API_BASE}/bot${TG_BOT_TOKEN}/sendMessage`, HTML parse mode, link
 * preview disabled, 10s timeout.
 */
export function createTelegramNotifier(opts: { botToken: string; apiBase?: string }): Notifier {
  const apiBase = opts.apiBase ?? "https://api.telegram.org";

  return {
    kind: "telegram",
    async send(target: NotifierTarget, msg: OutgoingMessage): Promise<SendResult> {
      const parsed = telegramNotifierConfigSchema.safeParse(target);
      if (!parsed.success) return { ok: false, retryable: false, error: "invalid telegram target config" };
      const { chatId } = parsed.data;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
      try {
        const res = await fetch(`${apiBase}/bot${opts.botToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            chat_id: chatId,
            text: msg.html,
            parse_mode: "HTML",
            disable_web_page_preview: true,
            reply_markup: toInlineKeyboard(msg.buttons),
          }),
        });
        const json = (await res.json().catch(() => undefined)) as TelegramApiOk<{ message_id: number }> | TelegramApiErr | undefined;

        if (res.status === 200 && json?.ok) {
          return { ok: true, providerMessageId: String(json.result.message_id) };
        }
        if (res.status === 429) {
          const retryAfterSec = (json as TelegramApiErr | undefined)?.parameters?.retry_after ?? 1;
          return { ok: false, retryable: true, retryAfterSec, error: "rate limited" };
        }
        if (res.status === 403) {
          return { ok: false, retryable: false, error: "forbidden (bot blocked)" };
        }
        if (res.status >= 500) {
          return { ok: false, retryable: true, error: `telegram 5xx: ${res.status}` };
        }
        return { ok: false, retryable: false, error: `telegram ${res.status}: ${(json as TelegramApiErr | undefined)?.description ?? "error"}` };
      } catch (err) {
        return { ok: false, retryable: true, error: err instanceof Error ? err.message : String(err) };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
