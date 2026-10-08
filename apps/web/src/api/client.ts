// Fetch wrapper for `/api/*`. Errors are normalised to `ApiError` and the
// caller (query/mutation) decides how to surface them (toast, redirect).

export interface ApiErrorBody {
  error: string;
  // Most routes (e.g. apps/api/src/routes/watches.ts) send `{ error, field,
  // reason }` on 422, not `message` — both are checked so the real reason
  // (not just the generic `error` code) reaches the user.
  message?: string;
  reason?: string;
  field?: string;
  issues?: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues?: unknown;

  constructor(status: number, body: ApiErrorBody) {
    const detail = body.message || body.reason || body.error;
    super(body.field ? `${detail} (${body.field})` : detail);
    this.status = status;
    this.code = body.error;
    this.issues = body.issues;
  }
}

/** Error body for a non-JSON failure; `statusText` is empty over HTTP/2, so never surface it as "unknown". */
function nonJsonError(status: number, statusText: string): ApiErrorBody {
  if (status >= 500) return { error: "upstream_unavailable", message: `Server did not respond in time (HTTP ${status}). Try again.` };
  return { error: `http_${status}`, message: statusText || `Request failed (HTTP ${status}).` };
}

const DEV_USER = import.meta.env.DEV ? (import.meta.env.VITE_DEV_USER as string | undefined) : undefined;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type") && init?.body) {
    headers.set("content-type", "application/json");
  }
  // Custom header: cookie-authenticated writes need same-origin or this (CSRF guard in the api).
  headers.set("X-Requested-With", "feedhound");
  if (DEV_USER) {
    headers.set("X-Dev-User", DEV_USER);
  }

  // redirect: "manual" — an expired Cloudflare Access session answers with a 302
  // to *.cloudflareaccess.com, which would otherwise fail as an opaque CORS error.
  const res = await fetch(`/api${path}`, { ...init, headers, credentials: "include", redirect: "manual" });

  if (res.type === "opaqueredirect" || (res.status < 500 && res.headers.get("content-type")?.startsWith("text/html"))) {
    throw new ApiError(401, { error: "session_expired" });
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json().catch(() => null) : null;

  if (!res.ok) {
    throw new ApiError(res.status, (body as ApiErrorBody) ?? nonJsonError(res.status, res.statusText));
  }

  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: "GET" }),
  post: <T>(path: string, body?: unknown, opts?: { signal?: AbortSignal }) =>
    request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined, signal: opts?.signal }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: "PUT", body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
