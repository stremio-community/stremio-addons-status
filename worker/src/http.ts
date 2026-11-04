import { fetch, type Dispatcher } from "undici";
import { socksDispatcher } from "fetch-socks";
import { config, USER_AGENT } from "./config.js";
import type { DetailRow } from "./types.js";
import { errMsg } from "./utils.js";

const proxy = makeDispatcher();

/** Statuses that suggest an IP/proxy block rather than a real addon response, so we retry the other route. */
const BLOCKED_STATUSES = new Set([403, 407, 408, 425, 429, 451]);

/** Cloudflare and similar challenge pages are HTML served with HTTP 200, so an HTML 2xx looks blocked too. */
function looksBlocked({ status, parseError }: Omit<JsonResult<unknown>, "attempts">): boolean {
  if (BLOCKED_STATUSES.has(status) || status >= 500) return true;
  return status >= 200 && status < 300 && parseError?.html === true;
}

export type Route = "WARP" | "direct";

/** One try of a request over one route; `error` replaces `status` when the transport failed. */
export interface Attempt {
  route: Route;
  status?: number;
  error?: string;
  durationMs: number;
  /** Set when redirects led to another host, as `from → to` hostnames: a moved or parked addon shows here. */
  redirect?: string;
}

/** Why a body didn't parse as JSON, holding only what is safe to publish about it. */
export interface ParseError {
  /** A landing, error or challenge page rather than broken JSON. */
  html: boolean;
  contentType?: string;
  /** The HTML page's `<title>`, which usually names the page better than its first bytes. */
  title?: string;
  /** The start of the body, whitespace collapsed and URLs and key-like tokens dropped, since a configured addon may echo its config. */
  excerpt: string;
}

export interface JsonResult<T> {
  status: number;
  /** Undefined whenever `parseError` is set. */
  data: T | undefined;
  /** Set when the body is empty or isn't JSON, whatever the status. */
  parseError?: ParseError;
  attempts: Attempt[];
}

/** Thrown when every attempted route failed at the transport level, so callers can still report what was tried. */
export class RequestFailedError extends Error {
  constructor(
    message: string,
    readonly attempts: Attempt[],
  ) {
    super(message);
  }
}

/** The routes tried before a request threw, or none when the error didn't come from getJson. */
export function attemptsOf(e: unknown): Attempt[] {
  return e instanceof RequestFailedError ? e.attempts : [];
}

/** undici reports every network failure as "fetch failed" and hides the useful part in `cause`. */
function describeError(e: unknown, timeout: number): string {
  if (e instanceof Error && e.name === "TimeoutError") return `timed out after ${timeout}ms`;
  const cause =
    e instanceof Error ? (e.cause as { code?: string; message?: string } | undefined) : undefined;
  const detail = cause?.code ?? cause?.message;
  return detail ? `${errMsg(e)} (${detail})` : errMsg(e);
}

const EXCERPT_LENGTH = 80;

function excerptOf(text: string): string {
  const clean = text
    .slice(0, 4 * EXCERPT_LENGTH)
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]*/gi, "…")
    .replace(/[\w+/=%-]{24,}/g, "…")
    .replace(/[\s\p{Cc}]+/gu, " ")
    .trim();
  return clean.length > EXCERPT_LENGTH ? clean.slice(0, EXCERPT_LENGTH) + "…" : clean;
}

function parseErrorOf(text: string, contentType: string | null): ParseError {
  const html = /\btext\/html\b/i.test(contentType ?? "") || text.trimStart().startsWith("<");
  const title = html ? /<title[^>]*>([^<]*)</i.exec(text)?.[1] : undefined;
  return {
    html,
    ...(contentType ? { contentType: excerptOf(contentType) } : {}),
    ...(title?.trim() ? { title: excerptOf(title) } : {}),
    excerpt: excerptOf(text),
  };
}

/** A terse summary, a reason and detail rows for a body that didn't parse, ready for a probe's request rows. */
export function describeParseError(e: ParseError): {
  summary: string;
  reason: string;
  details: DetailRow[];
} {
  const contentType = { label: "Content-Type", value: e.contentType ?? "none" };
  const body = e.title
    ? { label: "Page title", value: e.title }
    : { label: "Body", value: e.excerpt || "empty" };
  return {
    summary: e.html ? "HTML page" : "not valid JSON",
    reason: e.html ? "HTML page instead of JSON" : "response is not valid JSON",
    details: [contentType, body],
  };
}

function redirectOf(requested: string, final: string): string | undefined {
  const from = URL.parse(requested)?.hostname;
  const to = URL.parse(final)?.hostname;
  return from && to && from !== to ? `${from} → ${to}` : undefined;
}

async function fetchJson<T>(
  url: string,
  timeout: number,
  dispatcher: Dispatcher | undefined,
): Promise<Omit<JsonResult<T>, "attempts"> & { redirect?: string }> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    redirect: "follow",
    signal: AbortSignal.timeout(timeout),
    dispatcher,
  });
  const text = await res.text();
  const redirect = redirectOf(url, res.url);
  try {
    return { status: res.status, data: JSON.parse(text) as T, redirect };
  } catch {
    const parseError = parseErrorOf(text, res.headers.get("content-type"));
    return { status: res.status, data: undefined, parseError, redirect };
  }
}

/**
 * GET as JSON, WARP-first with a direct fallback.
 * If the proxied request is blocked (a blocked status or an HTML 2xx) or its transport fails, retry once directly before giving up.
 * This rescues addons that block WARP egress IPs (e.g. Torrentio) while still dodging addons that block datacenter IPs.
 * `data` is undefined and `parseError` set for a non-JSON body; `attempts` lists every route tried, in order.
 * Throws a RequestFailedError only if every attempted route throws.
 */
export async function getJson<T = unknown>(url: string, timeout: number): Promise<JsonResult<T>> {
  const attempts: Attempt[] = [];
  const attempt = async (route: Route, dispatcher: Dispatcher | undefined) => {
    const start = Date.now();
    try {
      const { redirect, ...res } = await fetchJson<T>(url, timeout, dispatcher);
      attempts.push({
        route,
        status: res.status,
        durationMs: Date.now() - start,
        ...(redirect ? { redirect } : {}),
      });
      return { ...res, attempts };
    } catch (e) {
      attempts.push({ route, error: describeError(e, timeout), durationMs: Date.now() - start });
      throw e;
    }
  };

  try {
    if (!proxy) return await attempt("direct", undefined); // no proxy configured -> direct only
    let viaProxy: JsonResult<T>;
    try {
      viaProxy = await attempt("WARP", proxy);
    } catch {
      return await attempt("direct", undefined); // proxy transport failed -> direct (may throw)
    }
    if (!looksBlocked(viaProxy)) return viaProxy;
    try {
      return await attempt("direct", undefined); // proxy blocked -> try direct
    } catch {
      return viaProxy; // direct also failed; report the proxy result
    }
  } catch {
    throw new RequestFailedError(attempts.at(-1)?.error ?? "request failed", attempts);
  }
}

/** SOCKS5 dispatcher for the WARP proxy, or undefined when no proxy is configured. */
function makeDispatcher(): Dispatcher | undefined {
  if (!config.proxyUrl) return undefined;
  const u = new URL(config.proxyUrl);
  const type = u.protocol === "socks4:" ? 4 : 5;
  return socksDispatcher({ type, host: u.hostname, port: Number(u.port) || 1080 });
}
