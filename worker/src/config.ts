export const config = {
  apiBase: (process.env.API_BASE || "https://stremio-addons.net/api/v0").replace(/\/$/, ""),
  gatusUrl: (process.env.GATUS_URL || "http://gatus:8080").replace(/\/$/, ""),
  pushToken: process.env.PUSH_TOKEN || "",
  proxyUrl: process.env.PROXY_URL || "",
  endpointsConfigPath: process.env.ENDPOINTS_CONFIG_PATH || "/config/10-endpoints.yaml",

  probeInterval: parseDuration(process.env.PROBE_INTERVAL, 15 * 60_000),
  listRefresh: parseDuration(process.env.LIST_REFRESH, 60 * 60_000),
  concurrency: parseNumber(process.env.CONCURRENCY, 8),

  timeouts: {
    manifest: parseNumber(process.env.MANIFEST_TIMEOUT, 15_000),
    catalog: parseNumber(process.env.CATALOG_TIMEOUT, 15_000),
    meta: parseNumber(process.env.META_TIMEOUT, 15_000),
    stream: parseNumber(process.env.STREAM_TIMEOUT, 30_000),
  },
} as const;

export const USER_AGENT = "Stremio-Addons-Status/1.0 (+https://status.stremio-addons.net)";

function parseDuration(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const trimmed = value.trim();
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(trimmed);
  if (!match) return fallback;
  const n = Number(match[1]);
  switch (match[2]) {
    case "h":
      return n * 3_600_000;
    case "m":
      return n * 60_000;
    case "s":
      return n * 1_000;
    case "ms":
      return n;
    default:
      return n; // bare number = milliseconds
  }
}

function parseNumber(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
