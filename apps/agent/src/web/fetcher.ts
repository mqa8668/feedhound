import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { robotsFromResponse, type RobotsRules } from "./robots";
import { bareHost, checkHostAddresses, systemResolver, type HostResolver } from "./ssrf";
import { WebFetchError, type WebGetTextOptions, type WebHttp, type WebResponse, type WebTextResponse } from "./types";

const TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;
const ROBOTS_FAILURE_TTL_MS = 5 * 60 * 1000;

/** A validated address the connection must use, whatever the name resolves to later. Absent for literal-IP hosts and allowPrivateHosts. */
export interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

export type FetchFn = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal; redirect: "manual"; pin?: PinnedAddress },
) => Promise<Response>;

/** The `lookup` handed to node:http(s): answers with the validated address only, never asks DNS again. */
export function pinnedLookup(pin: PinnedAddress): LookupFunction {
  return (_host, opts, cb) => {
    if (opts.all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address: pin.address, family: pin.family }]);
    else cb(null, pin.address, pin.family);
  };
}

/** node:http(s) request options for a pinned hop: connect to the validated IP, Host/SNI/cert check stay on the original name. */
export function pinnedRequestOptions(u: URL, pin: PinnedAddress, headers: Record<string, string>) {
  const hostname = u.hostname.replace(/^\[|\]$/g, "");
  return {
    method: "GET",
    protocol: u.protocol,
    hostname,
    port: u.port === "" ? undefined : Number(u.port),
    path: u.pathname + u.search,
    headers: { ...headers, Host: u.host },
    lookup: pinnedLookup(pin),
    ...(u.protocol === "https:" && isIP(hostname) === 0 ? { servername: hostname } : {}),
  };
}

/**
 * Production client. A pinned hop goes through node:http(s) with a lookup that returns only the validated
 * address; an unpinned hop (literal IP, or allowPrivateHosts) uses plain fetch.
 *
 * Remaining limits: only the first validated address is tried (no happy-eyeballs failover); a literal-IP
 * host is exact by construction; allowPrivateHosts disables the guard entirely (offline demo).
 */
export const pinnedFetch: FetchFn = (url, init) => {
  if (!init.pin) return fetch(url, init);
  const u = new URL(url);
  const pin = init.pin;
  return new Promise<Response>((resolve, reject) => {
    const doRequest = u.protocol === "https:" ? httpsRequest : httpRequest;
    const req = doRequest(pinnedRequestOptions(u, pin, init.headers), (msg: IncomingMessage) => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(msg.headers)) {
        if (Array.isArray(v)) for (const x of v) headers.append(k, x);
        else if (v !== undefined) headers.set(k, v);
      }
      const status = msg.statusCode ?? 0;
      const noBody = status === 204 || status === 304 || (status >= 300 && status < 400);
      if (noBody) msg.resume();
      resolve(new Response(noBody ? null : (Readable.toWeb(msg) as ReadableStream<Uint8Array>), { status, headers }));
    });
    req.on("error", reject);
    init.signal.addEventListener("abort", () => req.destroy(new Error("aborted")), { once: true });
    if (init.signal.aborted) req.destroy(new Error("aborted"));
    req.end();
  });
};

export interface FetcherOptions {
  /** Hosts a request may go to: every connector's `hosts`, plus (via a function) the hosts of enabled feed sources. */
  hosts: readonly string[] | (() => readonly string[]);
  userAgent: string;
  minRequestGapMs: number;
  /** Disables the private-address guard (offline demo only). Default false. */
  allowPrivateHosts?: boolean | (() => boolean);
  /** Replaces DNS lookup (tests). */
  resolve?: HostResolver;
  fetch?: FetchFn;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const TEXT_ACCEPT = "application/rss+xml, application/atom+xml, application/feed+json, application/json, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8";
const JSON_ACCEPT = "application/json, text/plain, */*";

async function readCapped(res: Response): Promise<string> {
  const charset = /charset\s*=\s*["']?([\w-]+)/i.exec(res.headers.get("content-type") ?? "")?.[1];
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new WebFetchError("too_large", `body ${declared} bytes`);
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new WebFetchError("too_large", "body over 2 MB");
    }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks);
  try {
    return new TextDecoder((charset ?? "utf-8") as "utf-8").decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

function parseRetryAfter(res: Response): number | null {
  const v = res.headers.get("retry-after");
  if (v === null || !/^\d+$/.test(v.trim())) return null;
  return Number(v.trim());
}

interface RawResult {
  status: number;
  retryAfterSec: number | null;
  text: string;
  etag: string | null;
  lastModified: string | null;
}

/**
 * Polite fetcher: allow-listed hosts, UA, no cookies, per-host gap, robots.txt, timeout, size cap.
 * Redirects are followed manually (max 3) and every hop passes the same checks as the first request: scheme,
 * host allow-list, SSRF address guard and robots.txt.
 *
 * DNS pinning: each hop resolves the host once, validates every address, and connects to one of those
 * validated addresses (`pin`), so a second DNS answer cannot redirect the connection. Host header, TLS SNI and
 * certificate verification keep using the original hostname.
 */
export function createWebFetcher(opts: FetcherOptions): WebHttp {
  const doFetch: FetchFn = opts.fetch ?? pinnedFetch;
  const now = opts.now ?? ((): number => Date.now());
  const sleep = opts.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  const resolve = opts.resolve ?? systemResolver;
  const agentToken = opts.userAgent.split(/[/\s]/)[0] ?? "feedhound";
  const lastRequestAt = new Map<string, number>();
  const robotsCache = new Map<string, { rules: RobotsRules; expiresAt: number }>();
  const allowedHosts = (): readonly string[] => (typeof opts.hosts === "function" ? opts.hosts() : opts.hosts);
  const privateAllowed = (): boolean => (typeof opts.allowPrivateHosts === "function" ? opts.allowPrivateHosts() : (opts.allowPrivateHosts ?? false));

  async function request(url: string, host: string, headers: Record<string, string>, pin: PinnedAddress | undefined): Promise<{ res: Response; text: string }> {
    const last = lastRequestAt.get(host);
    if (last !== undefined) {
      const wait = last + opts.minRequestGapMs - now();
      if (wait > 0) await sleep(wait);
    }
    lastRequestAt.set(host, now());
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await doFetch(url, { headers: { "User-Agent": opts.userAgent, ...headers }, signal: ctl.signal, redirect: "manual", ...(pin ? { pin } : {}) });
      const isRedirect = REDIRECT_STATUSES.has(res.status) && res.headers.has("location");
      const text = isRedirect || res.status === 304 ? "" : await readCapped(res);
      if (isRedirect) void res.body?.cancel().catch(() => undefined);
      return { res, text };
    } catch (err) {
      if (err instanceof WebFetchError) throw err;
      if (ctl.signal.aborted) throw new WebFetchError("timeout", `timeout after ${TIMEOUT_MS} ms`);
      throw new WebFetchError("network", err instanceof Error ? err.message : "network error");
    } finally {
      clearTimeout(timer);
    }
  }

  /** Scheme, allow-list and address checks for one hop. */
  async function admit(u: URL): Promise<PinnedAddress | undefined> {
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new WebFetchError("forbidden_host", `scheme ${u.protocol} not allowed`);
    const host = bareHost(u.hostname).toLowerCase();
    if (!allowedHosts().some((h) => h.toLowerCase() === host)) throw new WebFetchError("forbidden_host", `host ${host} not allowed`);
    if (privateAllowed()) return undefined;
    const check = await checkHostAddresses(u.hostname, resolve);
    if (check.ok) {
      if (isIP(bareHost(u.hostname)) !== 0) return undefined;
      const address = check.addresses[0];
      return address === undefined ? undefined : { address, family: isIP(address) === 6 ? 6 : 4 };
    }
    throw new WebFetchError(check.kind === "blocked" ? "forbidden_host" : "network", check.reason);
  }

  async function robotsFor(u: URL): Promise<RobotsRules> {
    const hit = robotsCache.get(u.host);
    if (hit && hit.expiresAt > now()) return hit.rules;
    let rules: RobotsRules;
    let ttl = ROBOTS_TTL_MS;
    try {
      const r = await follow(`${u.protocol}//${u.host}/robots.txt`, {}, true);
      rules = robotsFromResponse(r.status, r.text, agentToken);
      if (r.status >= 500) ttl = ROBOTS_FAILURE_TTL_MS;
    } catch (err) {
      if (err instanceof WebFetchError && err.kind === "forbidden_host") throw err;
      rules = robotsFromResponse(null, "", agentToken);
      ttl = ROBOTS_FAILURE_TTL_MS;
    }
    robotsCache.set(u.host, { rules, expiresAt: now() + ttl });
    return rules;
  }

  async function follow(startUrl: string, headers: Record<string, string>, isRobots: boolean): Promise<RawResult> {
    let url = startUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        throw new WebFetchError("forbidden_host", "invalid url");
      }
      const pin = await admit(u);
      if (!isRobots) {
        const rules = await robotsFor(u);
        if (!rules.allowed(u.pathname + u.search)) throw new WebFetchError("robots", `robots.txt disallows ${u.pathname}`);
      }
      const { res, text } = await request(url, u.host, headers, pin);
      const location = res.headers.get("location");
      if (REDIRECT_STATUSES.has(res.status) && location) {
        try {
          url = new URL(location, url).href;
        } catch {
          throw new WebFetchError("network", "invalid redirect location");
        }
        continue;
      }
      return { status: res.status, retryAfterSec: parseRetryAfter(res), text, etag: res.headers.get("etag"), lastModified: res.headers.get("last-modified") };
    }
    throw new WebFetchError("network", `more than ${MAX_REDIRECTS} redirects`);
  }

  return {
    async getJson(url: string): Promise<WebResponse> {
      const r = await follow(url, { Accept: JSON_ACCEPT }, false);
      let body: unknown = r.text;
      try {
        body = JSON.parse(r.text);
      } catch {
        // non-JSON: keep the text
      }
      return { status: r.status, retryAfterSec: r.retryAfterSec, body };
    },
    async getText(url: string, o?: WebGetTextOptions): Promise<WebTextResponse> {
      const headers: Record<string, string> = { Accept: TEXT_ACCEPT };
      if (o?.etag) headers["If-None-Match"] = o.etag;
      if (o?.lastModified) headers["If-Modified-Since"] = o.lastModified;
      const r = await follow(url, headers, false);
      return { status: r.status, retryAfterSec: r.retryAfterSec, body: r.text, etag: r.etag, lastModified: r.lastModified, notModified: r.status === 304 };
    },
  };
}
