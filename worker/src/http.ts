import { fetch, type Dispatcher } from "undici";
import { socksDispatcher } from "fetch-socks";
import { config, USER_AGENT } from "./config.js";
import { errMsg } from "./utils.js";

const proxy = makeDispatcher();

/** Statuses that suggest an IP/proxy block rather than a real addon response, so we retry the other route. */
const BLOCKED_STATUSES = new Set([403, 407, 408, 425, 429, 451]);
function looksBlocked(status: number): boolean {
  return BLOCKED_STATUSES.has(status) || status >= 500;
}

export type Route = "WARP" | "direct";

/** One try of a request over one route; `error` replaces `status` when the transport failed. */
export interface Attempt {
  route: Route;
  status?: number;
  error?: string;
  durationMs: number;
}

type JsonResult<T> = { status: number; data: T | undefined; attempts: Attempt[] };

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

async function fetchJson<T>(
  url: string,
  timeout: number,
  dispatcher: Dispatcher | undefined,
): Promise<Omit<JsonResult<T>, "attempts">> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    redirect: "follow",
    signal: AbortSignal.timeout(timeout),
    dispatcher,
  });
  const text = await res.text();
  let data: T | undefined;
  if (text) {
    try {
      data = JSON.parse(text) as T;
    } catch {
      data = undefined; // non-JSON body
    }
  }
  return { status: res.status, data };
}

/**
 * GET as JSON, WARP-first with a direct fallback.
 * If the proxied request is blocked or its transport fails, retry once directly before giving up.
 * This rescues addons that block WARP egress IPs (e.g. Torrentio) while still dodging addons that block datacenter IPs.
 * `data` is undefined for a non-JSON body; `attempts` lists every route tried, in order.
 * Throws a RequestFailedError only if every attempted route throws.
 */
export async function getJson<T = unknown>(url: string, timeout: number): Promise<JsonResult<T>> {
  const attempts: Attempt[] = [];
  const attempt = async (route: Route, dispatcher: Dispatcher | undefined) => {
    const start = Date.now();
    try {
      const res = await fetchJson<T>(url, timeout, dispatcher);
      attempts.push({ route, status: res.status, durationMs: Date.now() - start });
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
    if (!looksBlocked(viaProxy.status)) return viaProxy;
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
