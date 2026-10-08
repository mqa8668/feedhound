import pino from "pino";

export interface LoggerOptions {
  service: string;
  level?: string;
}

/** pino JSON logger; level from `LOG_LEVEL` env unless overridden. */
export function createLogger({ service, level }: LoggerOptions): pino.Logger {
  return pino({
    name: service,
    level: level ?? process.env.LOG_LEVEL ?? "info",
  });
}
