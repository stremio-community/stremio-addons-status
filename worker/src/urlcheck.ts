import { lookup } from "node:dns/promises";
import { fetch } from "undici";
import { USER_AGENT } from "./config.js";
import { availableRoutes, dispatcherOf, excerptOf, type Route } from "./http.js";
import { placeholderKind, strongestPlaceholder, type PlaceholderKind } from "./streams.js";

/**
 * `playable`: the URL serves media or an HLS playlist.
 * `webpage`: a web page where media is expected, which no player plays but an informational addon may mean as a link.
 * `dead`: no client can play it anywhere (the host doesn't exist, the file is gone, a text body where media is expected).
 * `unverifiable`: it may play for someone else (geo blocks, WAF and captcha pages, rate limits, server errors, timeouts).
 */
export type UrlVerdict = "playable" | "webpage" | "dead" | "unverifiable";

export interface UrlCheck {
  /** Publishable: stream URLs carry tokens, so only their host is kept. */
  host: string;
  verdict: UrlVerdict;
  /** Terse and publishable: a status, a content type or a network error, never the URL or the body. */
  outcome: string;
}

/** Stream URLs checked per target: enough to see past one dead mirror, few enough to stay a light probe. */
export const URLS_PER_TARGET = 2;
const URL_TIMEOUT_MS = 10_000;
const DNS_TIMEOUT_MS = 3_000;
const TIMED_OUT = "timed out";
/** Error pages put their wording after a few KB of styles, as R2's does. */
const BODY_CAP = 16 * 1024;
const PAGE_CAP = 64 * 1024;

const DEBRID_HOSTS = [
  "real-debrid.com",
  "alldebrid.com",
  "premiumize.me",
  "torbox.app",
  "debrid-link.com",
  "debrid-link.fr",
  "easydebrid.com",
  "offcloud.com",
];
const DEBRID_SEGMENT =
  /debrid|^(rd|ad|pm|tb|dl|ed|oc|realdebrid|premiumize|torbox|offcloud|easynews|usenet)$/i;
/** Segments that make a configured addon act on its user's account (add a torrent to a debrid cloud) rather than just serve a file. */
const ACTION_SEGMENT = /^(resolve[rs]?|playback|play)([._-]|$)/i;

function segments(pathname: string): string[] {
  return pathname
    .split("/")
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
}

/**
 * URLs the worker must never request: debrid services and debrid-looking paths, and resolve or playback routes of a configured addon.
 * Requesting those adds torrents to the account of whoever configured the addon.
 */
export function isProtectedUrl(url: string, baseUrl: string): boolean {
  const target = URL.parse(url);
  if (!target) return true;
  const host = target.hostname.toLowerCase();
  if (DEBRID_HOSTS.some((d) => host === d || host.endsWith(`.${d}`))) return true;
  const path = segments(target.pathname);
  if (path.some((s) => DEBRID_SEGMENT.test(s))) return true;
  const base = URL.parse(baseUrl);
  const configured = base !== null && segments(base.pathname).length > 0;
  return configured && target.host === base.host && path.some((s) => ACTION_SEGMENT.test(s));
}

export interface UrlToCheck {
  url: string;
  /** `behaviorHints.proxyHeaders.request`, which a player sends and some CDNs require (a Referer, a User-Agent). */
  headers: Record<string, string>;
}

function proxyHeadersOf(stream: Record<string, unknown>): Record<string, string> {
  const hints = stream.behaviorHints as { proxyHeaders?: { request?: unknown } } | undefined;
  const request = hints?.proxyHeaders?.request;
  if (!request || typeof request !== "object") return {};
  return Object.fromEntries(
    Object.entries(request).filter((e): e is [string, string] => typeof e[1] === "string"),
  );
}

/**
 * The first URLs to check among a target's playable streams, or none when any of them isn't a plain `url` the worker may request.
 * A torrent or a debrid link beside them still plays whatever the checked URLs do, so their check couldn't fail the target.
 */
export function urlsToCheck(playable: readonly unknown[], baseUrl: string): UrlToCheck[] {
  const urls: UrlToCheck[] = [];
  for (const s of playable) {
    const o = (s ?? {}) as Record<string, unknown>;
    if (typeof o.url !== "string" || !/^https?:\/\//i.test(o.url)) return [];
    if (isProtectedUrl(o.url, baseUrl)) return [];
    urls.push({ url: o.url, headers: proxyHeadersOf(o) });
  }
  return urls.slice(0, URLS_PER_TARGET);
}

/** What one ranged GET got back, as far as judging it needs. */
export interface UrlResponse {
  status: number;
  contentType?: string;
  /** The start of the body. */
  body: Uint8Array;
  /** The requested URL, whose query may carry the link's expiry. */
  url: string;
  /** A CDN's header saying its access control refused the request, typically by region. */
  denyReason?: string;
}

const MEDIA_TYPE =
  /^(video|audio)\/|mpegurl|dash\+xml|octet-stream|^application\/(mp4|ogg|x-matroska|vnd\.ms-sstr\+xml)/i;
const TEXT_TYPE = /^text\/(html|plain)|xhtml/i;

/**
 * Pages that block us rather than the content: geo restrictions, WAF and captcha challenges.
 * A viewer elsewhere may well get the stream.
 */
const BLOCKED_PAGE = new RegExp(
  [
    String.raw`block(ed)? access from your country`,
    String.raw`not (available|accessible) (in|from) your (country|region|location)`,
    String.raw`\b(geo|country|region)[ -]?(block|restrict|lock)`,
    String.raw`\byour (country|region|location)\b`,
    String.raw`backend_denied`,
    String.raw`you have been blocked`,
    String.raw`attention required`,
    String.raw`just a moment`,
    String.raw`checking your browser`,
    String.raw`captcha`,
    String.raw`cf-chl|challenge-platform`,
    String.raw`ddos-guard`,
  ].join("|"),
  "i",
);

/** A 4xx page saying the file itself is gone: R2's disabled public bucket, archive.org's dark items, a resolver that found nothing. */
const GONE_PAGE = new RegExp(
  [
    String.raw`cannot be viewed`,
    String.raw`could(?: not|n'?t) (?:find|be found)`,
    String.raw`\bnot found\b`,
    String.raw`no longer (?:available|exists?)`,
    String.raw`\b(?:item|file|video|stream|content|channel|object)s? (?:is |are )?(?:not available|unavailable|removed|deleted|gone)\b`,
    String.raw`does(?: not|n'?t) exist`,
    String.raw`has been (?:removed|deleted|disabled|taken down)`,
    String.raw`\b(?:access|bucket|account|link|file|stream) (?:is |has been )?disabled\b`,
    String.raw`\b(?:link|url|token|signature|file) (?:has )?expired\b`,
  ].join("|"),
  "i",
);

const EXPIRY_PARAMS = ["e", "exp", "expires", "expiry", "expire"];

/** Whether a signed URL says it expired: a seconds or milliseconds timestamp in an expiry parameter, now past. */
function expired(url: string, now: number): boolean {
  const params = URL.parse(url)?.searchParams;
  if (!params) return false;
  return [...params].some(([k, v]) => {
    if (!EXPIRY_PARAMS.includes(k.toLowerCase()) || !/^\d{10}(\d{3})?$/.test(v)) return false;
    const ms = v.length === 10 ? Number(v) * 1000 : Number(v);
    return ms < now;
  });
}

function startsWith(body: Uint8Array, bytes: number[], at = 0): boolean {
  return bytes.every((b, i) => body[at + i] === b);
}

function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

/** Container signatures, for media served under a wrong or missing content type. */
function looksLikeMedia(body: Uint8Array): boolean {
  return (
    ["ftyp", "moov", "moof", "styp"].some((box) => startsWith(body, ascii(box), 4)) ||
    startsWith(body, [0x1a, 0x45, 0xdf, 0xa3]) ||
    (body[0] === 0x47 && (body.length <= 188 || body[188] === 0x47)) ||
    ["FLV", "OggS", "ID3", "fLaC", "RIFF"].some((sig) => startsWith(body, ascii(sig))) ||
    (body[0] === 0xff && (body[1] & 0xe0) === 0xe0)
  );
}

function textOf(body: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(body).replace(/^﻿/, "");
}

/** The words a page shows, without its markup, scripts and styles. */
function visibleText(text: string): string {
  return text
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shortType(contentType: string | undefined): string {
  const t = contentType?.split(";")[0].trim();
  return t ? ` ${excerptOf(t)}` : "";
}

/** Judge one ranged GET's answer. */
export function judgeResponse(r: UrlResponse, now = Date.now()): Omit<UrlCheck, "host"> {
  const { status, contentType = "" } = r;
  const text = textOf(r.body);
  const head = text.trimStart();
  const markup = head.startsWith("<") && !/^<\?xml[\s\S]*<MPD\b|^<MPD\b/i.test(head);
  const label = `HTTP ${status}${shortType(contentType)}`;
  if (status >= 200 && status < 300) {
    if (head.startsWith("#EXTM3U") || /^(<\?xml[\s\S]*)?<MPD\b/i.test(head)) {
      return { verdict: "playable", outcome: label };
    }
    if (looksLikeMedia(r.body) || (MEDIA_TYPE.test(contentType) && !markup)) {
      return { verdict: "playable", outcome: label };
    }
    if (BLOCKED_PAGE.test(text)) return { verdict: "unverifiable", outcome: `${label}, blocked` };
    if (GONE_PAGE.test(visibleText(text))) return { verdict: "dead", outcome: `${label}, gone` };
    if (markup || /html/i.test(contentType)) {
      return { verdict: "webpage", outcome: `${label}, web page` };
    }
    if (TEXT_TYPE.test(contentType)) return { verdict: "dead", outcome: `${label}, not media` };
    return { verdict: "unverifiable", outcome: label };
  }
  // Kaltura answers a geo-restricted entry with a 404, saying why only in a header.
  if (r.denyReason || BLOCKED_PAGE.test(text)) {
    return { verdict: "unverifiable", outcome: `${label}, blocked` };
  }
  if (status === 404 || status === 410) return { verdict: "dead", outcome: label };
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
    if (GONE_PAGE.test(visibleText(text))) return { verdict: "dead", outcome: `${label}, gone` };
    if ((status === 401 || status === 403) && expired(r.url, now)) {
      return { verdict: "dead", outcome: `${label}, link expired` };
    }
  }
  return { verdict: "unverifiable", outcome: label };
}

/** Whether the local resolver says the host doesn't exist; a lookup that fails otherwise or takes too long proves nothing. */
async function hostMissing(host: string): Promise<boolean> {
  if (!host || /^[\d.]+$|:/.test(host)) return false;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), DNS_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      lookup(host).then(
        () => false,
        (e: { code?: string }) => e.code === "ENOTFOUND" || e.code === "ENODATA",
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readPrefix(
  body: ReadableStream<Uint8Array> | null,
  cap: number,
): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(Math.min(size, cap));
  let at = 0;
  for (const c of chunks) {
    if (at >= out.length) break;
    out.set(c.subarray(0, out.length - at), at);
    at += c.length;
  }
  return out;
}

interface Fetched {
  status: number;
  contentType?: string;
  body: Uint8Array;
  denyReason?: string;
}

/** Flussonic's `x-deny-reason` (`backend_denied`), and Kaltura's `x-kaltura-app` when it names access control. */
function denyReasonOf(headers: Headers): string | undefined {
  const kaltura = headers.get("x-kaltura-app");
  return (
    headers.get("x-deny-reason") ??
    (kaltura && /access.control|restricted/i.test(kaltura) ? kaltura : undefined)
  );
}

async function get(
  url: string,
  headers: Record<string, string>,
  route: Route,
  cap: number,
): Promise<Fetched> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "*/*", ...headers },
    redirect: "follow",
    signal: AbortSignal.timeout(URL_TIMEOUT_MS),
    dispatcher: dispatcherOf(route),
  });
  return {
    status: res.status,
    contentType: res.headers.get("content-type") ?? undefined,
    denyReason: denyReasonOf(res.headers),
    body: await readPrefix(res.body as ReadableStream<Uint8Array> | null, cap),
  };
}

/** How a request that got no answer went: refused and nonexistent hosts are dead; anything else may be ours alone. */
function judgeError(e: unknown, missing: boolean): Omit<UrlCheck, "host"> {
  if (e instanceof Error && e.name === "TimeoutError") {
    return { verdict: "unverifiable", outcome: TIMED_OUT };
  }
  const cause = e instanceof Error ? (e.cause as { code?: string; message?: string }) : undefined;
  const detail = `${cause?.code ?? ""} ${cause?.message ?? ""}`;
  if (/ECONNREFUSED|ConnectionRefused/i.test(detail)) {
    return { verdict: "dead", outcome: "connection refused" };
  }
  if (missing && /ENOTFOUND|HostUnreachable/i.test(detail)) {
    return { verdict: "dead", outcome: "NXDOMAIN" };
  }
  return { verdict: "unverifiable", outcome: cause?.code ?? "network error" };
}

const VERDICT_RANK: Record<UrlVerdict, number> = {
  dead: 0,
  webpage: 1,
  unverifiable: 2,
  playable: 3,
};

/**
 * Check one stream URL as a player would open it: a DNS lookup, then a ranged GET with the stream's proxy headers.
 * A URL is dead only when every route says so, since either route alone may be blocked; a host missing from the local resolver still gets asked for over WARP, which resolves remotely.
 * A timeout already makes the URL unverifiable, so the other route isn't worth another wait.
 */
export async function checkUrl({ url, headers }: UrlToCheck, now = Date.now()): Promise<UrlCheck> {
  const host = URL.parse(url)?.hostname ?? "";
  const missing = await hostMissing(host);
  const results: Array<Omit<UrlCheck, "host">> = [];
  for (const route of availableRoutes()) {
    if (route === "direct" && missing) {
      results.push({ verdict: "dead", outcome: "NXDOMAIN" });
      continue;
    }
    try {
      const r = await get(url, { Range: "bytes=0-1023", ...headers }, route, BODY_CAP);
      results.push(judgeResponse({ ...r, url }, now));
    } catch (e) {
      results.push(judgeError(e, missing));
    }
    const last = results.at(-1)!;
    if (last.verdict === "playable" || last.outcome === TIMED_OUT) break;
  }
  const best = results.reduce((a, b) =>
    VERDICT_RANK[b.verdict] > VERDICT_RANK[a.verdict] ? b : a,
  );
  return { host, ...best };
}

/** One URL check per line-item, e.g. `cdn.test: HTTP 206 video/mp4`. */
export function describeUrlChecks(checks: readonly UrlCheck[]): string {
  const counts = (["playable", "webpage", "dead", "unverifiable"] as const)
    .map((v) => [v, checks.filter((c) => c.verdict === v).length] as const)
    .filter(([, n]) => n > 0)
    .map(([v, n]) => `${n} ${v === "webpage" ? "web page" : v}`)
    .join(", ");
  const each = checks.map((c) => `${c.host}: ${c.outcome}`).join("; ");
  return `${counts} of ${checks.length} · ${each}`;
}

/** A link's page, as far as it says whether the link is real: what it is titled and whether that reads as a placeholder. */
export interface LinkPage {
  host: string;
  status?: number;
  /** The page's title or heading, publishable. */
  label?: string;
  placeholder?: PlaceholderKind;
}

function firstMatch(re: RegExp, text: string): string | undefined {
  const m = re.exec(text)?.[1];
  return m ? visibleText(m).replace(/&amp;/g, "&").trim() || undefined : undefined;
}

/**
 * Open a link the way a user would, read-only, and read what its page is titled.
 * Only its title and main heading count: a page's body is full of navigation such as "Sign in".
 */
export async function followLink(url: string): Promise<LinkPage> {
  const host = URL.parse(url)?.hostname ?? "";
  for (const route of availableRoutes()) {
    try {
      const r = await get(url, {}, route, PAGE_CAP);
      const text = textOf(r.body);
      const title = firstMatch(/<title[^>]*>([\s\S]*?)<\/title>/i, text);
      const heading = firstMatch(/<h1[^>]*>([\s\S]*?)<\/h1>/i, text);
      const kinds = [title, heading].flatMap((t) => {
        const placeholder = t ? placeholderKind(t) : undefined;
        return placeholder ? [{ placeholder }] : [];
      });
      const shown = title ?? heading;
      return {
        host,
        status: r.status,
        ...(shown ? { label: excerptOf(shown) } : {}),
        ...(r.status >= 200 && r.status < 300
          ? { placeholder: strongestPlaceholder(kinds)?.placeholder }
          : {}),
      };
    } catch {
      // Try the other route.
    }
  }
  return { host };
}

const NONEXISTENT_IMDB = "tt9999999999";

/**
 * An ID shaped like the target's that no title can have: the negative control.
 * An addon answering it with streams pastes the ID into a template rather than looking it up.
 */
export function negativeControlId(streamId: string, prefixes: readonly string[]): string {
  if (/^tt\d+/.test(streamId)) {
    return /^tt\d+:\d+:\d+$/.test(streamId) ? `${NONEXISTENT_IMDB}:1:1` : NONEXISTENT_IMDB;
  }
  const prefix =
    [...prefixes].sort((a, b) => b.length - a.length).find((p) => streamId.startsWith(p)) ??
    /^[^:]*:/.exec(streamId)?.[0] ??
    "";
  return `${prefix}__status_probe__`;
}
