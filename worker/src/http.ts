import { fetch, type Dispatcher } from "undici";
import { socksDispatcher } from "fetch-socks";
import { config, USER_AGENT } from "./config.js";
import type { DetailRow } from "./types.js";
import { errMsg, sleep } from "./utils.js";

const proxy = makeDispatcher();

/** Statuses that suggest an IP/proxy block rather than a real addon response, so we retry the other route. */
const BLOCKED_STATUSES = new Set([403, 407, 408, 425, 429, 451]);

/** Cloudflare and similar challenge pages are HTML served with HTTP 200, so an HTML 2xx looks blocked too. */
function looksBlocked({
  status,
  parseError,
}: Pick<JsonResult<unknown>, "status" | "parseError">): boolean {
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
  /** Set when the transport failure was the request timing out. */
  timedOut?: boolean;
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
  /** Set when the body ran past this many bytes, so it was cut off unread. */
  overLimit?: number;
}

export interface JsonResult<T> {
  status: number;
  /** Undefined whenever `parseError` is set. */
  data: T | undefined;
  /** Set when the body is empty or isn't JSON, whatever the status. */
  parseError?: ParseError;
  attempts: Attempt[];
  /** The route whose 2xx answer wasn't `usable` when the other route's answer was, so the result came from the other route. */
  softBlockedOn?: Route;
  /** The answer's `Access-Control-Allow-Origin`, unset when it sent none. */
  allowOrigin?: string;
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
  if (isTimeout(e)) return `timed out after ${timeout}ms`;
  const cause =
    e instanceof Error ? (e.cause as { code?: string; message?: string } | undefined) : undefined;
  const detail = cause?.code ?? cause?.message;
  return detail ? `${errMsg(e)} (${detail})` : errMsg(e);
}

const EXCERPT_LENGTH = 80;

/** A short, publishable excerpt of untrusted text: whitespace collapsed, URLs and key-like tokens dropped. */
export function excerptOf(text: string): string {
  const clean = text
    .slice(0, 4 * EXCERPT_LENGTH)
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]*/gi, "…")
    .replace(/[\w+/=%-]{24,}/g, "…")
    .replace(/[\s\p{Cc}]+/gu, " ")
    .trim();
  return clean.length > EXCERPT_LENGTH ? clean.slice(0, EXCERPT_LENGTH).trimEnd() + "…" : clean;
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
  if (e.overLimit !== undefined) {
    return {
      summary: "response too large",
      reason: `response is larger than ${formatBytes(e.overLimit)}`,
      details: [contentType],
    };
  }
  const body = e.title
    ? { label: "Page title", value: e.title }
    : { label: "Body", value: e.excerpt || "empty" };
  return {
    summary: e.html ? "HTML page" : "not valid JSON",
    reason: e.html ? "HTML page instead of JSON" : "response is not valid JSON",
    details: [contentType, body],
  };
}

function formatBytes(n: number): string {
  return n >= 1_000_000 ? `${n / 1_000_000} MB` : n >= 1_000 ? `${n / 1_000} KB` : `${n} bytes`;
}

/** The body's first `maxBytes` bytes, cancelling the rest of the download. */
async function readCapped(
  res: Awaited<ReturnType<typeof fetch>>,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  const reader = res.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.length > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  return { bytes: Buffer.concat(chunks), truncated };
}

function redirectOf(requested: string, final: string): string | undefined {
  const from = URL.parse(requested)?.hostname;
  const to = URL.parse(final)?.hostname;
  return from && to && from !== to ? `${from} → ${to}` : undefined;
}

type Answer<T> = Omit<JsonResult<T>, "attempts" | "softBlockedOn">;

async function fetchJson<T>(
  url: string,
  timeout: number,
  dispatcher: Dispatcher | undefined,
  headers: Record<string, string> = {},
  maxBytes?: number,
): Promise<Answer<T> & { redirect?: string; retryAfterMs?: number }> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...headers },
    redirect: "follow",
    signal: AbortSignal.timeout(timeout),
    dispatcher,
  });
  const redirect = redirectOf(url, res.url);
  const retryAfterMs = retryAfterOf(res.headers.get("retry-after"));
  const allowOrigin = res.headers.get("access-control-allow-origin");
  const extra = {
    redirect,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(allowOrigin !== null ? { allowOrigin } : {}),
  };
  let text: string;
  if (maxBytes === undefined) {
    text = await res.text();
  } else {
    const { bytes, truncated } = await readCapped(res, maxBytes);
    if (truncated) {
      const contentType = res.headers.get("content-type");
      const parseError: ParseError = {
        html: false,
        ...(contentType ? { contentType: excerptOf(contentType) } : {}),
        excerpt: "",
        overLimit: maxBytes,
      };
      return { status: res.status, data: undefined, parseError, ...extra };
    }
    text = new TextDecoder().decode(bytes);
  }
  try {
    return { status: res.status, data: JSON.parse(text) as T, ...extra };
  } catch {
    const parseError = parseErrorOf(text, res.headers.get("content-type"));
    return { status: res.status, data: undefined, parseError, ...extra };
  }
}

/** `Retry-After` as a delay in milliseconds, from either delta-seconds or an HTTP-date. */
export function retryAfterOf(header: string | null, now = Date.now()): number | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Longer waits are a cool-down rather than a rate limit, and would stall the probe cycle. */
const MAX_RETRY_AFTER_MS = 10_000;
const RETRY_AFTER_STATUSES = new Set([429, 503]);
/** Long enough for a dropped connection or a cold start to recover, short enough to stay within one probe. */
const TRANSIENT_RETRY_PAUSE_MS = 2_000;

export interface GetJsonOptions<T> {
  /**
   * When no route gives a final answer and a route failed at the transport level or timed out, pause and try that route once more.
   * Costs up to one more timeout, so it is meant for the few requests that decide a verdict.
   */
  retry?: boolean;
  /** Whether a parsed 2xx answer has content worth having; an unusable one sends the request to the other route as well. */
  usable?: (data: T) => boolean;
  /** Stop reading a body past this many bytes and report it as too large, so a runaway answer can't exhaust memory. */
  maxBytes?: number;
  /** Sent on every try besides the worker's own User-Agent and Accept. */
  headers?: Record<string, string>;
}

/** How settled one try leaves the request; the best try wins, the latest among equals. */
enum Rank {
  Failed,
  Blocked,
  Unusable,
  Final,
}

interface Try<T> {
  route: Route;
  rank: Rank;
  answer?: Answer<T>;
  error?: unknown;
}

/**
 * GET as JSON, WARP-first with a direct fallback.
 * A route is retried once after its `Retry-After` when it answers 429 or 503 with a short one, so a rate limiter isn't mistaken for an IP block.
 * If WARP is blocked (a blocked status or an HTML 2xx), its 2xx answer isn't `usable`, or its transport fails, the request goes direct too and the better answer wins.
 * This rescues addons that block or soft-block WARP egress IPs (e.g. Torrentio) while still dodging addons that block datacenter IPs.
 * With `retry`, a route that failed at the transport level gets one more try after a pause when nothing better came back.
 * `data` is undefined and `parseError` set for a non-JSON body; `attempts` lists every try, in order.
 * Throws a RequestFailedError only if every try throws.
 */
export async function getJson<T = unknown>(
  url: string,
  timeout: number,
  { retry = false, usable, maxBytes, headers }: GetJsonOptions<T> = {},
): Promise<JsonResult<T>> {
  const attempts: Attempt[] = [];
  const tries: Try<T>[] = [];
  const honouredRetryAfter = new Set<Route>();

  const rankOf = (answer: Answer<T>): Rank => {
    if (looksBlocked(answer)) return Rank.Blocked;
    const parsed2xx = isSuccess(answer.status) && !answer.parseError;
    return parsed2xx && usable && !usable(answer.data as T) ? Rank.Unusable : Rank.Final;
  };

  const once = async (route: Route): Promise<Try<T>> => {
    const start = Date.now();
    let fetched: Awaited<ReturnType<typeof fetchJson<T>>>;
    try {
      fetched = await fetchJson<T>(url, timeout, dispatcherOf(route), headers, maxBytes);
    } catch (error) {
      const timedOut = isTimeout(error);
      attempts.push({
        route,
        error: describeError(error, timeout),
        ...(timedOut ? { timedOut } : {}),
        durationMs: Date.now() - start,
      });
      const t = { route, rank: Rank.Failed, error };
      tries.push(t);
      return t;
    }
    const { redirect, retryAfterMs, ...answer } = fetched;
    attempts.push({
      route,
      status: answer.status,
      durationMs: Date.now() - start,
      ...(redirect ? { redirect } : {}),
    });
    const t = { route, rank: rankOf(answer), answer };
    tries.push(t);
    if (
      RETRY_AFTER_STATUSES.has(answer.status) &&
      retryAfterMs !== undefined &&
      retryAfterMs <= MAX_RETRY_AFTER_MS &&
      !honouredRetryAfter.has(route)
    ) {
      honouredRetryAfter.add(route);
      await sleep(retryAfterMs);
      return once(route);
    }
    return t;
  };

  const routes = availableRoutes();
  for (const route of routes) {
    if ((await once(route)).rank === Rank.Final) return settle();
  }
  if (retry) {
    const route = transientRetryRoute(routes, tries);
    if (route) {
      await sleep(TRANSIENT_RETRY_PAUSE_MS);
      await once(route);
    }
  }
  return settle();

  function best(): Try<T> {
    return tries.reduce((a, b) => (b.rank >= a.rank ? b : a));
  }

  function settle(): JsonResult<T> {
    const won = best();
    if (!won.answer) {
      throw new RequestFailedError(attempts.at(-1)?.error ?? "request failed", attempts);
    }
    const softBlocked = tries.find((t) => t.rank === Rank.Unusable && t.route !== won.route)?.route;
    return {
      ...won.answer,
      attempts,
      ...(won.rank === Rank.Final && softBlocked ? { softBlockedOn: softBlocked } : {}),
    };
  }
}

/** The start of a file, as far as one request for it got. */
export interface Sample {
  status: number;
  /** At most the `maxBytes` asked for, whether or not the server honoured the range. */
  bytes: Uint8Array;
  contentType?: string;
  attempts: Attempt[];
}

/**
 * Range-GET the first `maxBytes` of a file, WARP-first with a direct fallback like getJson, to sniff it without downloading it.
 * The direct route is tried when WARP fails, answers non-2xx or serves an HTML page, which may be a challenge for its egress IPs.
 * Throws a RequestFailedError only if every route throws.
 */
export async function getSample(url: string, timeout: number, maxBytes: number): Promise<Sample> {
  const attempts: Attempt[] = [];
  let kept: { rank: number; sample: Omit<Sample, "attempts"> } | undefined;
  for (const route of availableRoutes()) {
    const start = Date.now();
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Range: `bytes=0-${maxBytes - 1}` },
        redirect: "follow",
        signal: AbortSignal.timeout(timeout),
        dispatcher: dispatcherOf(route),
      });
      const { bytes } = await readCapped(res, maxBytes);
      const redirect = redirectOf(url, res.url);
      attempts.push({
        route,
        status: res.status,
        durationMs: Date.now() - start,
        ...(redirect ? { redirect } : {}),
      });
      const contentType = res.headers.get("content-type") ?? undefined;
      const html = /\btext\/html\b/i.test(contentType ?? "");
      const rank = isSuccess(res.status) ? (html ? 1 : 2) : 0;
      if (!kept || rank >= kept.rank) {
        kept = {
          rank,
          sample: { status: res.status, bytes, ...(contentType ? { contentType } : {}) },
        };
      }
      if (rank === 2) break;
    } catch (error) {
      const timedOut = isTimeout(error);
      attempts.push({
        route,
        error: describeError(error, timeout),
        ...(timedOut ? { timedOut } : {}),
        durationMs: Date.now() - start,
      });
    }
  }
  if (!kept) throw new RequestFailedError(attempts.at(-1)?.error ?? "request failed", attempts);
  return { ...kept.sample, attempts };
}

/** The route whose last try failed at the transport level, preferring one that timed out: a slow addon may answer the second time. */
function transientRetryRoute<T>(routes: Route[], tries: Try<T>[]): Route | undefined {
  const failed = routes.filter(
    (route) => tries.findLast((t) => t.route === route)?.rank === Rank.Failed,
  );
  return (
    failed.find((route) => isTimeout(tries.findLast((t) => t.route === route)?.error)) ?? failed[0]
  );
}

/** The routes a request can take, WARP first when it is configured. */
export function availableRoutes(): Route[] {
  return proxy ? ["WARP", "direct"] : ["direct"];
}

export function dispatcherOf(route: Route): Dispatcher | undefined {
  return route === "WARP" ? proxy : undefined;
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function isTimeout(e: unknown): boolean {
  return e instanceof Error && e.name === "TimeoutError";
}

export interface Failure {
  /** Terse, for the condition summary. */
  summary: string;
  /** For the request's `Reason` row. */
  reason: string;
}

/** Wording for a request that threw: `timed out` when every try timed out, so a slow addon reads differently from a refused one. */
export function describeRequestError(e: unknown): Failure {
  const attempts = attemptsOf(e);
  const timedOut = attempts.length > 0 && attempts.every((a) => a.timedOut);
  return { summary: timedOut ? "timed out" : "unreachable", reason: errMsg(e) };
}

/** Wording for a non-2xx answer, with the addon's own JSON error message when it sent one. */
export function describeStatus({
  status,
  data,
}: Pick<JsonResult<unknown>, "status" | "data">): Failure {
  const message = errorMessageOf(data);
  const said = message ? `: ${message}` : "";
  if (status === 429) {
    return {
      summary: "rate limited",
      reason: `addon responded with HTTP 429 (rate limited)${said}`,
    };
  }
  return { summary: `HTTP ${status}`, reason: `addon responded with HTTP ${status}${said}` };
}

function errorMessageOf(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const { error, message } = data as { error?: unknown; message?: unknown };
  const nested =
    error && typeof error === "object" ? (error as { message?: unknown }).message : undefined;
  const parts = [error, nested, message].filter(
    (v): v is string => typeof v === "string" && v.trim() !== "",
  );
  return parts.length > 0 ? excerptOf([...new Set(parts)].join(": ")) : undefined;
}

/** A note for the reason row when the other route's answer replaced a 2xx one without usable content. */
export function softBlockNote(r: Pick<JsonResult<unknown>, "softBlockedOn">): string | undefined {
  return r.softBlockedOn ? `soft-blocked on ${r.softBlockedOn}` : undefined;
}

/** SOCKS5 dispatcher for the WARP proxy, or undefined when no proxy is configured. */
function makeDispatcher(): Dispatcher | undefined {
  if (!config.proxyUrl) return undefined;
  const u = new URL(config.proxyUrl);
  const type = u.protocol === "socks4:" ? 4 : 5;
  return socksDispatcher({ type, host: u.hostname, port: Number(u.port) || 1080 });
}
