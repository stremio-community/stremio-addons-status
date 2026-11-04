import type { Stream } from "@stremio-addon/sdk";

/**
 * What a placeholder stands in for.
 * `needs-config`: the listed URL isn't configured (configure, sign in, API key, paywall).
 * `error`: the addon says it is broken, retired or refusing (deprecated, suspended, unauthorised, rate-limited).
 * `no-content`: an empty answer or noise dressed as a stream (no sources, nags, donation and search cards).
 */
export type PlaceholderKind = "needs-config" | "error" | "no-content";

/**
 * How a Stremio client treats one stream object.
 * `playable` plays in the player; `link` opens a page outside it (externalUrl, YouTube trailers); `invalid` can't do either.
 */
export type StreamClass =
  | { kind: "playable"; fingerprint: string; label: string }
  | { kind: "link"; fingerprint: string; label: string }
  | { kind: "placeholder"; placeholder: PlaceholderKind; fingerprint: string; label: string }
  | { kind: "invalid"; fingerprint: string; label: string };

/** Fields that make Stremio play a stream itself. */
const PLAYABLE_FIELDS = [
  "url",
  "ytId",
  "infoHash",
  "nzbUrl",
  "rarUrls",
  "zipUrls",
  "7zipUrls",
  "tgzUrls",
  "tarUrls",
] as const satisfies readonly (keyof Stream)[];

/**
 * Placeholder wording, checked in order, so an addon saying it is retired or refusing wins over its plea to configure ("Private manifest required … shared free manifest ended").
 * Phrases rather than bare words, because release names carry arbitrary words ("Sign.of.the.Times", "Not Parent Safe").
 */
const PLACEHOLDER_PATTERNS: ReadonlyArray<readonly [PlaceholderKind, RegExp]> = [
  [
    "error",
    new RegExp(
      [
        String.raw`\bdeprecated\b`,
        String.raw`\bsuspended\b`,
        String.raw`\bshut(ting)? down\b`,
        String.raw`\bdiscontinued\b`,
        String.raw`\bno longer (available|supported|maintained|working)`,
        String.raw`\breinstall`,
        String.raw`\bnew addon link\b`,
        String.raw`\b(subscription|token|key|session|trial|manifest|license|account)s? (has )?(expired|ended)\b`,
        String.raw`\bunauthori[sz]ed\b|\bnot authori[sz]ed\b|\bno autorizad|\bnão autorizad`,
        String.raw`\baccess denied\b|\bacces(so)? (blocat|denegado|negado)\b`,
        String.raw`\bdisabled\b`,
        String.raw`\brequest failed\b|\bauth(entication)? error\b`,
        String.raw`\brate[ -]?limit`,
        String.raw`\btoo many requests\b`,
      ].join("|"),
      "iu",
    ),
  ],
  [
    "needs-config",
    new RegExp(
      [
        String.raw`\b(re-?)?configur`,
        String.raw`\bkonfigur`,
        String.raw`\bsign[ -]?in\b`,
        String.raw`\blog[ -]?in\b`,
        String.raw`\bapi[ _-]?key`,
        String.raw`\b(token|cookie|key|login|account|setup|manifest|subscription)s? (is )?(required|missing|needed)`,
        String.raw`\b(set ?up|connect) (\S+ ){0,3}(first|your account|to unlock)`,
        String.raw`\bnot (set ?up|configured)`,
        String.raw`\binvalid (api|key|token|credentials|session|config)`,
        String.raw`\b(unlock|subscribe to watch|free trial|go premium|premium access)\b`,
        String.raw`\bmediaflow\b`,
        String.raw`\bactivar\b|\baktivál|\bativar\b`,
        String.raw`\brichiest[ao]\b|\bwymagan`,
      ].join("|"),
      "iu",
    ),
  ],
  [
    "no-content",
    new RegExp(
      [
        String.raw`\bno (streams?|sources?|results?|links?|data)\b`,
        String.raw`\bnot available\b`,
        String.raw`\bnothing found\b`,
        String.raw`нет данных`,
        String.raw`nėra šaltinių`,
        String.raw`\bsin resultados\b`,
        String.raw`\bdonat|\bsostieni\b|buymeacoffee|buy me a coffee|ko-fi\.com|patreon\.com`,
        String.raw`\btap to update\b|\bupdate your install|\bnew version\b|\bv\d+(\.\d+)* available\b`,
        String.raw`\bsearch (on )?(google|youtube)\b`,
        String.raw`\[info\]`,
        String.raw`^loading\.*$`,
      ].join("|"),
      "iu",
    ),
  ],
];

/** The placeholder a piece of visible text announces, if any. */
export function placeholderKind(text: string): PlaceholderKind | undefined {
  if (!text) return undefined;
  return PLACEHOLDER_PATTERNS.find(([, re]) => re.test(text))?.[0];
}

/** Catalog and meta IDs that name a notice rather than a title, split on the usual separators. */
const PLACEHOLDER_ID_TOKENS = new Set([
  "notice",
  "error",
  "setup",
  "config",
  "configure",
  "promo",
  "expired",
  "donate",
  "unlock",
  "apikey",
  "nokey",
  "renew",
  "alert",
  "suspended",
  "auth",
]);

function hasPlaceholderIdToken(id: string): boolean {
  return id
    .toLowerCase()
    .split(/[:_\-./]+/)
    .some((token) => PLACEHOLDER_ID_TOKENS.has(token));
}

/**
 * Whether a catalog item or meta is a notice ("TMDB key required", "Set up … first", a promo tile) rather than a title.
 * Returns the placeholder kind, defaulting to `needs-config` for notice IDs whose text doesn't say more.
 */
export function placeholderMeta(meta: unknown): PlaceholderKind | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  const m = meta as Record<string, unknown>;
  const id = typeof m.id === "string" ? m.id : "";
  const text = [m.name, m.description].filter((v) => typeof v === "string").join(" · ");
  return placeholderKind(text) ?? (hasPlaceholderIdToken(id) ? "needs-config" : undefined);
}

/** The text a user sees for a stream, on one line. */
function visibleText(s: Record<string, unknown>): string {
  return [s.name, s.title, s.description]
    .filter((v): v is string => typeof v === "string" && v.trim() !== "")
    .join(" · ")
    .replace(/\s+/g, " ")
    .trim();
}

const MAX_LABEL_LENGTH = 120;

function labelOf(text: string): string {
  return text.length > MAX_LABEL_LENGTH ? `${text.slice(0, MAX_LABEL_LENGTH - 1)}…` : text;
}

function hasValue(v: unknown): boolean {
  return Array.isArray(v) ? v.length > 0 : v != null && v !== "";
}

/** Loopback, private, link-local and documentation hosts: no client outside the addon's own machine can reach them. */
function isUnreachableHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0") return true;
  if (/^(www\.)?example\.(com|org|net)$/.test(host)) return true;
  if (host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return true;
  const v4 = host.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return (
    a === 127 ||
    a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254)
  );
}

function pointsAtConfigurePage(link: string, baseUrl: string): boolean {
  const target = URL.parse(link);
  const base = URL.parse(baseUrl);
  if (!target || !base || target.host !== base.host) return false;
  return /\/configure\b/i.test(target.pathname);
}

const ZERO_INFOHASH = /^0+$/;

function isTrailer(s: Record<string, unknown>): boolean {
  if (!hasValue(s.ytId)) return false;
  const hint = (s.behaviorHints as Record<string, unknown> | undefined)?.bingeGroup;
  return [s.bingeGroup, hint, s.name, s.title].some(
    (v) => typeof v === "string" && /trailer/i.test(v),
  );
}

/**
 * Classify one stream as a Stremio client would experience it.
 * `baseUrl` is the addon's own base URL, so a stream sending the user to the addon's configure page reads as a placeholder.
 */
export function classifyStream(s: unknown, { baseUrl }: { baseUrl: string }): StreamClass {
  if (!s || typeof s !== "object") return { kind: "invalid", fingerprint: "", label: "" };
  const obj = s as Record<string, unknown>;
  const text = visibleText(obj);
  const label = labelOf(text);
  const target = [obj.url, obj.externalUrl, obj.ytId, obj.infoHash, obj.nzbUrl]
    .filter((v) => typeof v === "string")
    .join(" ");
  const fingerprint = `${text}\u0000${target}`;

  const playable = PLAYABLE_FIELDS.some((f) => hasValue(obj[f]));
  const link = typeof obj.externalUrl === "string" && obj.externalUrl !== "";
  if (!playable && !link) return { kind: "invalid", fingerprint, label };

  if (typeof obj.url === "string" && obj.url !== "") {
    const host = URL.parse(obj.url)?.hostname;
    if (host && isUnreachableHost(host)) return { kind: "invalid", fingerprint, label };
  }
  if (typeof obj.infoHash === "string" && ZERO_INFOHASH.test(obj.infoHash)) {
    return { kind: "invalid", fingerprint, label };
  }

  const links = [obj.url, obj.externalUrl].filter((v): v is string => typeof v === "string");
  if (links.some((l) => pointsAtConfigurePage(l, baseUrl))) {
    return { kind: "placeholder", placeholder: "needs-config", fingerprint, label };
  }
  const placeholder =
    placeholderKind(text) ?? (link ? placeholderKind(String(obj.externalUrl)) : undefined);
  if (placeholder) return { kind: "placeholder", placeholder, fingerprint, label };

  if (playable && !isTrailer(obj)) return { kind: "playable", fingerprint, label };
  return { kind: "link", fingerprint, label };
}

/**
 * Fingerprints (visible text plus source) that recur in the answers for different titles.
 * Real content differs per title, so a recurring stream is a placeholder, nag or static card, whatever its wording.
 * Each response must come from a different test ID.
 */
export function repeatedFingerprints(responses: readonly StreamClass[][]): Set<string> {
  const seenIn = new Map<string, number>();
  for (const response of responses) {
    for (const fp of new Set(response.map((c) => c.fingerprint))) {
      if (fp) seenIn.set(fp, (seenIn.get(fp) ?? 0) + 1);
    }
  }
  return new Set([...seenIn].filter(([, n]) => n >= 2).map(([fp]) => fp));
}
