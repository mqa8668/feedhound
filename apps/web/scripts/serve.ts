// Production static server for the built dashboard (replaces `vite preview` in the image).
// Serves ./dist with SPA fallback, proxies /api and /ws to the api so the browser sees a
// single origin (cookie auth works without CORS), and answers /healthz.
import { existsSync } from "node:fs";
import { join, normalize } from "node:path";

const PORT = Number(process.env.WEB_PORT ?? 4823);
const API_URL = (process.env.API_URL ?? "http://127.0.0.1:4820").replace(/\/+$/, "");
const DIST = process.env.WEB_DIST ?? join(import.meta.dir, "dist");
const VERSION = process.env.APP_VERSION?.trim() || "dev";

interface WsData {
  target: string;
  headers: Record<string, string>;
  upstream?: WebSocket;
  pending: (string | ArrayBuffer | Uint8Array)[];
}

function staticFile(pathname: string): Bun.BunFile | undefined {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const full = join(DIST, rel);
  if (!full.startsWith(DIST) || rel === "/" || rel === ".") return undefined;
  return existsSync(full) ? Bun.file(full) : undefined;
}

async function proxyHttp(req: Request, url: URL): Promise<Response> {
  const headers = new Headers(req.headers);
  headers.delete("host"); // fetch() sets the upstream host; Origin/Cookie pass through untouched.
  headers.set("x-forwarded-host", req.headers.get("host") ?? "");
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
  try {
    const res = await fetch(`${API_URL}${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      redirect: "manual",
      // @ts-expect-error Bun-specific: allow streaming request bodies.
      duplex: "half",
    });
    return res;
  } catch {
    return Response.json({ error: "api_unreachable" }, { status: 502 });
  }
}

const server = Bun.serve<WsData>({
  port: PORT,
  idleTimeout: 120,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return Response.json({ ok: true, service: "web", version: VERSION });
    if (url.pathname === "/ws") {
      const headers: Record<string, string> = {};
      for (const k of ["cookie", "origin", "user-agent"]) {
        const v = req.headers.get(k);
        if (v) headers[k] = v;
      }
      // The api's same-origin check compares Origin with the public host, not the internal upstream host.
      headers["x-forwarded-host"] = req.headers.get("host") ?? "";
      headers["x-forwarded-proto"] = url.protocol.replace(":", "");
      const target = `${API_URL.replace(/^http/, "ws")}/ws${url.search}`;
      return srv.upgrade(req, { data: { target, headers, pending: [] } })
        ? (undefined as unknown as Response)
        : new Response("upgrade failed", { status: 400 });
    }
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return proxyHttp(req, url);

    const file = staticFile(url.pathname);
    if (file) {
      const immutable = url.pathname.startsWith("/assets/");
      return new Response(file, { headers: { "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" } });
    }
    if (url.pathname.startsWith("/assets/")) return new Response("not found", { status: 404 });
    return new Response(Bun.file(join(DIST, "index.html")), { headers: { "cache-control": "no-cache" } });
  },
  websocket: {
    open(ws) {
      const upstream = new WebSocket(ws.data.target, { headers: ws.data.headers } as unknown as string[]);
      ws.data.upstream = upstream;
      upstream.onopen = () => {
        for (const m of ws.data.pending) upstream.send(m);
        ws.data.pending = [];
      };
      upstream.onmessage = (ev) => ws.send(ev.data as string);
      upstream.onclose = (ev) => ws.close(ev.code === 1005 ? 1000 : ev.code, ev.reason);
      upstream.onerror = () => ws.close(1011, "upstream error");
    },
    message(ws, msg) {
      const up = ws.data.upstream;
      if (up && up.readyState === WebSocket.OPEN) up.send(msg);
      else ws.data.pending.push(msg);
    },
    close(ws) {
      ws.data.upstream?.close();
    },
  },
});

console.log(`web listening on :${server.port} (api ${API_URL})`);
process.on("SIGTERM", () => {
  void server.stop();
  process.exit(0);
});
