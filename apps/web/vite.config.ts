import { gzipSync } from "node:zlib";
import path from "node:path";
import { createDb } from "@feedhound/db";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin, type ViteDevServer, type PreviewServer } from "vite";

const PORT = Number(process.env.WEB_PORT ?? 4823);
const API_PORT = Number(process.env.API_PORT ?? 4820);
const VERSION = process.env.APP_VERSION?.trim() || "dev";

// The only .env in this repo lives at the workspace root; there is no
// apps/web/.env. Without envDir, Vite looks in apps/web, finds nothing, and
// every VITE_* var is undefined — which makes client.ts send no X-Dev-User
// header and every /api call 401 with no visible cause. Point Vite at the
// root so `bun run dev` works from apps/web as well as from the root script.
const ROOT_ENV_DIR = path.resolve(__dirname, "../..");
const ROOT_ENV = loadEnv(process.env.NODE_ENV ?? "development", ROOT_ENV_DIR, "");
const DEV_USER = process.env.VITE_DEV_USER ?? ROOT_ENV.VITE_DEV_USER;

if (process.env.NODE_ENV !== "production" && !DEV_USER) {
  console.warn(
    "[feedhound] VITE_DEV_USER is not set - the dashboard will send no X-Dev-User header " +
      `and every /api call will return 401. Set it in ${path.join(ROOT_ENV_DIR, ".env")}.`,
  );
}

function healthzPlugin(): Plugin {
  let handle: ReturnType<typeof createDb> | undefined;
  try {
    handle = createDb();
  } catch {
    handle = undefined;
  }

  const DB_CHECK_TIMEOUT_MS = 80;

  const respond = async (res: import("node:http").ServerResponse) => {
    const start = Date.now();
    let db: "ok" | "fail";
    try {
      if (!handle) throw new Error("db not configured");
      await Promise.race([
        handle.sql`select 1`,
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error("db healthz timeout")), DB_CHECK_TIMEOUT_MS)),
      ]);
      db = "ok";
    } catch {
      db = "fail";
    }
    const body = JSON.stringify({ ok: db === "ok", service: "web", version: VERSION, db });
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.setHeader("x-response-time", `${Date.now() - start}ms`);
    res.end(body);
  };

  const attach = (server: ViteDevServer | PreviewServer) => {
    server.middlewares.use((req, res, next) => {
      if (req.url === "/healthz") {
        void respond(res);
        return;
      }
      next();
    });
  };

  return {
    name: "healthz",
    configureServer: attach,
    configurePreviewServer: attach,
  };
}

/** Gzip budget for the entry chunk (kB = 1000 B). */
export const ENTRY_GZ_BUDGET_KB = 170;

/** Build-only guard: fails the build when the entry chunk is over budget or pulls zod in. */
export function bundleBudgetPlugin(): Plugin {
  return {
    name: "bundle-budget",
    apply: "build",
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk" || !chunk.isEntry) continue;
        const zodIds = chunk.moduleIds.filter((id) => /node_modules\/zod\//.test(id));
        if (zodIds.length > 0) this.error(`bundle-budget: zod is in the entry chunk (${zodIds.length} modules)`);
        const rawKb = Buffer.byteLength(chunk.code) / 1000;
        const gzKb = gzipSync(chunk.code, { level: 9 }).length / 1000;
        if (gzKb > ENTRY_GZ_BUDGET_KB) this.error(`bundle-budget: entry ${gzKb.toFixed(1)} kB gz exceeds ${ENTRY_GZ_BUDGET_KB} kB`);
        console.log(`entry ${rawKb.toFixed(1)} kB / ${gzKb.toFixed(1)} kB gz`);
      }
    },
  };
}

export default defineConfig({
  envDir: ROOT_ENV_DIR,
  plugins: [react(), tailwindcss(), healthzPlugin(), bundleBudgetPlugin()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: PORT,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
        // <img src="/api/media/..."> cannot carry the X-Dev-User header client.ts adds to fetches, so the
        // dev proxy supplies it (only when VITE_DEV_USER is set; this proxy never runs in production).
        configure(proxy) {
          const devUser = DEV_USER;
          if (!devUser) return;
          proxy.on("proxyReq", (proxyReq) => {
            if (!proxyReq.getHeader("x-dev-user")) proxyReq.setHeader("X-Dev-User", devUser);
          });
        },
      },
      "/ws": {
        target: `ws://127.0.0.1:${API_PORT}`,
        ws: true,
        // Browsers cannot set custom headers on a WebSocket upgrade request,
        // so in dev (where there's no Cloudflare Access to supply an
        // identity) we inject X-Dev-User here instead — the same header
        // apps/web/src/api/client.ts sets for plain fetches. Only when
        // VITE_DEV_USER is configured; never a hardcoded fallback, and never
        // in production, where this proxy doesn't run at all.
        configure(proxy) {
          const devUser = DEV_USER;
          if (!devUser) return;
          proxy.on("proxyReqWs", (proxyReq) => {
            proxyReq.setHeader("X-Dev-User", devUser);
          });
        },
      },
    },
  },
  preview: {
    port: PORT,
    strictPort: true,
    host: true,
    // The tunnel forwards the public Host header; vite preview rejects any host
    // other than localhost/IPs unless it is listed here (go-live).
    allowedHosts: process.env.PUBLIC_HOSTNAME ? [process.env.PUBLIC_HOSTNAME] : [],
  },
});
