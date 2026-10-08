export interface TelegramUpdate {
  update_id: number;
  message?: { chat: { id: number }; text: string; from?: { id: number } };
  callback_query?: { id: string; data: string; message: { chat: { id: number }; message_id: number }; from: { id: number } };
}

export interface TelegramApiClient {
  getUpdates(offset: number, timeoutSec: number): Promise<TelegramUpdate[]>;
  setMyCommands(commands: { command: string; description: string }[]): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text: string): Promise<void>;
  editMessageReplyMarkup(chatId: number, messageId: number, buttons: { text: string; url?: string; callback_data?: string }[][]): Promise<void>;
  /** Bot command reply — bypasses the agent's rate limiter. */
  sendMessage(chatId: number, html: string): Promise<void>;
}

interface TelegramApiEnvelope<T> {
  ok: boolean;
  result?: T;
}

/** Raw `fetch` client for the long-polling bot control calls. */
export function createTelegramApiClient(opts: { botToken: string; apiBase?: string }): TelegramApiClient {
  const apiBase = opts.apiBase ?? "https://api.telegram.org";

  async function call<T>(method: string, body?: unknown, timeoutMs = 35_000): Promise<T | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${apiBase}/bot${opts.botToken}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify(body ?? {}),
      });
      const json = (await res.json().catch(() => undefined)) as TelegramApiEnvelope<T> | undefined;
      return json?.result;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async getUpdates(offset, timeoutSec) {
      const result = await call<TelegramUpdate[]>("getUpdates", { offset, timeout: timeoutSec }, (timeoutSec + 5) * 1000);
      return result ?? [];
    },
    async setMyCommands(commands) {
      await call("setMyCommands", { commands });
    },
    async answerCallbackQuery(callbackQueryId, text) {
      await call("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
    },
    async editMessageReplyMarkup(chatId, messageId, buttons) {
      await call("editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: buttons },
      });
    },
    async sendMessage(chatId, html) {
      await call("sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML", disable_web_page_preview: true }, 10_000);
    },
  };
}
