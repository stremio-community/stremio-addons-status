import { fetch, type Dispatcher } from "undici";
import { socksDispatcher } from "fetch-socks";
import { config, USER_AGENT } from "./config.js";

const proxy = makeDispatcher();

/** Statuses that suggest an IP/proxy block rather than a real addon response, so we retry the other route. */
const BLOCKED_STATUSES = new Set([403, 407, 408, 425, 429, 451]);
function looksBlocked(status: number): boolean {
  return BLOCKED_STATUSES.has(status) || status >= 500;
}

type JsonResult<T> = { status: number; data: T | undefined };

async function fetchJson<T>(
  url: string,
  timeout: number,
  dispatcher: Dispatcher | undefined,
): Promise<JsonResult<T>> {
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
 * `data` is undefined for a non-JSON body; throws only if every attempted route throws.
 */
export async function getJson<T = unknown>(url: string, timeout: number): Promise<JsonResult<T>> {
  if (!proxy) return fetchJson<T>(url, timeout, undefined); // no proxy configured -> direct only
  try {
    const viaProxy = await fetchJson<T>(url, timeout, proxy);
    if (!looksBlocked(viaProxy.status)) return viaProxy;
    try {
      return await fetchJson<T>(url, timeout, undefined); // proxy blocked -> try direct
    } catch {
      return viaProxy; // direct also failed; report the proxy result
    }
  } catch {
    return fetchJson<T>(url, timeout, undefined); // proxy transport failed -> direct (may throw)
  }
}

/** SOCKS5 dispatcher for the WARP proxy, or undefined when no proxy is configured. */
function makeDispatcher(): Dispatcher | undefined {
  if (!config.proxyUrl) return undefined;
  const u = new URL(config.proxyUrl);
  const type = u.protocol === "socks4:" ? 4 : 5;
  return socksDispatcher({ type, host: u.hostname, port: Number(u.port) || 1080 });
}
