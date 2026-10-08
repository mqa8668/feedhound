/**
 * Fake Telegram Bot API server for tests. Never call
 * api.telegram.org from a test — point `TG_API_BASE` at this instead.
 */

export type ScriptedResponse =
  | { status: 200 }
  | { status: 429; retryAfterSec: number }
  | { status: 400 }
  | { status: 403 }
  | { status: 500 };

export interface RecordedCall {
  method: string; // e.g. "sendMessage"
  body: unknown;
  at: number; // Date.now() at receipt
}

export interface TelegramUpdate {
  update_id: number;
  message?: { chat: { id: number }; text: string; from?: { id: number } };
  callback_query?: { id: string; data: string; message: { chat: { id: number }; message_id: number }; from: { id: number } };
}

let messageIdCounter = 1;

export class TelegramMock {
  readonly calls: RecordedCall[] = [];
  readonly baseUrl: string;
  private readonly server: ReturnType<typeof Bun.serve>;
  /** Per-method queue of scripted responses; consumed FIFO, last one repeats. */
  private readonly scripts = new Map<string, ScriptedResponse[]>();
  private readonly pendingUpdates: TelegramUpdate[] = [];

  constructor() {
    this.server = Bun.serve({
      port: 0,
      fetch: (req) => this.handle(req),
    });
    this.baseUrl = `http://127.0.0.1:${this.server.port}`;
  }

  /** Queues one scripted response for the next call to `method` (`sendMessage`, etc). */
  script(method: string, response: ScriptedResponse): void {
    const list = this.scripts.get(method) ?? [];
    list.push(response);
    this.scripts.set(method, list);
  }

  /** Clears every scripted response (all methods revert to the default 200 OK). */
  resetScripts(): void {
    this.scripts.clear();
  }

  /** Feeds an update for the next `getUpdates` poll to return. */
  pushUpdate(update: Omit<TelegramUpdate, "update_id">): void {
    this.pendingUpdates.push({ update_id: this.pendingUpdates.length + 1, ...update });
  }

  callsFor(method: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  async close(): Promise<void> {
    this.server.stop(true);
  }

  private nextScripted(method: string): ScriptedResponse {
    const list = this.scripts.get(method);
    if (!list || list.length === 0) return { status: 200 };
    return list.length > 1 ? list.shift()! : list[0]!;
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // Path shape: /bot<token>/<method>
    const parts = url.pathname.split("/").filter(Boolean);
    const method = parts[1] ?? "";

    let body: unknown = {};
    if (req.method === "POST") {
      body = await req.json().catch(() => ({}));
    }
    this.calls.push({ method, body, at: Date.now() });

    if (method === "getUpdates") {
      const updates = this.pendingUpdates.splice(0, this.pendingUpdates.length);
      return Response.json({ ok: true, result: updates });
    }

    const scripted = this.nextScripted(method);
    if (scripted.status === 200) {
      if (method === "sendMessage") {
        return Response.json({ ok: true, result: { message_id: messageIdCounter++ } });
      }
      return Response.json({ ok: true, result: true });
    }
    if (scripted.status === 429) {
      return Response.json(
        { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: scripted.retryAfterSec } },
        { status: 429 },
      );
    }
    return Response.json({ ok: false, error_code: scripted.status, description: `mocked ${scripted.status}` }, { status: scripted.status });
  }
}
