import { z } from "zod";

/** Telegram notifier config. Other kinds: `{}`. */
export const telegramNotifierConfigSchema = z.object({
  chatId: z.number(),
  mode: z.enum(["instant", "digest"]).default("instant"),
  digestEveryMin: z.number().int().min(1).max(1440).optional(),
});
export type TelegramNotifierConfig = z.infer<typeof telegramNotifierConfigSchema>;

export const emptyNotifierConfigSchema = z.object({}).passthrough();

export type NotifierTarget = TelegramNotifierConfig | Record<string, unknown>;

export const buttonSchema = z.object({
  text: z.string(),
  url: z.string().optional(),
  callback: z.string().max(64).optional(),
});
export type Button = z.infer<typeof buttonSchema>;

export const outgoingMessageSchema = z.object({
  kind: z.enum(["alert", "digest", "ops"]),
  html: z.string(),
  buttons: z.array(z.array(buttonSchema)).optional(),
  dedupeKey: z.string(),
});
export type OutgoingMessage = z.infer<typeof outgoingMessageSchema>;

export type SendResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; retryable: boolean; retryAfterSec?: number; error: string };

export type NotifierKind = "telegram";

export interface Notifier {
  kind: NotifierKind;
  send(target: NotifierTarget, msg: OutgoingMessage): Promise<SendResult>;
}

/** Thrown when a notifier kind has no adapter yet. */
export class NotImplementedError extends Error {
  constructor(kind: NotifierKind) {
    super(`notifier kind not implemented: ${kind}`);
    this.name = "NotImplementedError";
  }
}
