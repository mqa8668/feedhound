import type { ServerRawPost } from "@feedhound/core/sources";

/** JSON-parsed body (text for a non-JSON response). */
export interface WebResponse {
  status: number;
  retryAfterSec: number | null;
  body: unknown;
}

/** Raw text body plus HTTP cache validators (used by feed connectors). */
export interface WebTextResponse {
  status: number;
  retryAfterSec: number | null;
  body: string;
  etag: string | null;
  lastModified: string | null;
  /** True when the server answered 304 to a conditional request. */
  notModified: boolean;
}

export interface WebGetTextOptions {
  /** Sent as If-None-Match. */
  etag?: string | null | undefined;
  /** Sent as If-Modified-Since. */
  lastModified?: string | null | undefined;
}

export interface WebHttp {
  getJson(url: string): Promise<WebResponse>;
  getText(url: string, opts?: WebGetTextOptions): Promise<WebTextResponse>;
}

/** HTTP cache validators stored per source (source.schedule.httpValidators). */
export interface HttpValidators {
  etag: string | null;
  lastModified: string | null;
}

export interface ListOptions {
  /** Validators from the previous successful poll (first page only). */
  validators?: HttpValidators | null;
}

export interface ListPage<Item> {
  items: Item[];
  next: string | null;
  malformed: number;
  /** The server confirmed nothing changed (HTTP 304); `items` is empty. */
  notModified?: boolean;
  /** Validators to store for the next conditional request; null clears them. */
  validators?: HttpValidators | null;
}

export interface MapCtx {
  capturedAt: Date;
  /** The source url, used for relative links and as the fallback item url. */
  sourceUrl?: string;
}

export interface SiteConnector<Item = unknown> {
  readonly id: string;
  readonly version: number;
  readonly hosts: readonly string[];
  parseSourceUrl(url: string): { ok: true; platformId: string; url: string } | { ok: false; reason: string };
  list(http: WebHttp, sourceUrl: string, cursor: string | null, pageSize: number, opts?: ListOptions): Promise<ListPage<Item>>;
  detail?(http: WebHttp, itemId: string): Promise<Item | null>;
  /** null = skip, counted as malformed. */
  map(item: Item, ctx: MapCtx): ServerRawPost | null;
}

/** A response that does not have the shape the connector expects. */
export class WebParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebParseError";
  }
}

/** Transport failures the poll job turns into visit outcomes. */
export class WebFetchError extends Error {
  constructor(
    readonly kind: "timeout" | "too_large" | "network" | "forbidden_host" | "robots",
    message: string,
  ) {
    super(message);
    this.name = "WebFetchError";
  }
}

/** Thrown by a connector when the site answered with a non-2xx status. */
export class WebHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterSec: number | null,
  ) {
    super(`http ${status}`);
    this.name = "WebHttpError";
  }
}
