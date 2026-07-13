/**
 * Static (non-addon) checks, upserted into Kuvasz as native HTTP monitors by the worker (see kuvasz.ts).
 * Kuvasz probes these directly and records latency; there is no per-monitor proxy, so they egress from the host IP.
 * If one starts flapping from datacenter-IP blocking, move that check into the worker's push path instead.
 */
export interface StaticHttpMonitor {
  name: string;
  url: string;
  intervalSeconds: number;
  method?: "GET" | "POST" | "HEAD";
  /** Accepted HTTP status codes; omitted = Kuvasz's default (2xx, plus 3xx while following redirects). */
  expectedStatusCodes?: number[];
  /** Substring the response body must contain. */
  expectedKeyword?: string;
}

const INTERVAL = 300;

export const STATIC_HTTP_MONITORS: StaticHttpMonitor[] = [
  {
    name: "stremio-addons.net",
    url: "https://stremio-addons.net/health",
    intervalSeconds: INTERVAL,
    expectedKeyword: "OK",
  },
  {
    name: "Stremio API",
    url: "https://api.strem.io/api/v1",
    intervalSeconds: INTERVAL,
    method: "POST",
    // The bare API root answers 400/405 to an empty POST; any of these proves the API is up.
    expectedStatusCodes: [200, 400, 405],
  },
  {
    name: "Cinemeta",
    url: "https://v3-cinemeta.strem.io/manifest.json",
    intervalSeconds: INTERVAL,
    expectedKeyword: '"id"',
  },
  {
    name: "Stremio Web Player",
    url: "https://web.stremio.com/",
    intervalSeconds: INTERVAL,
  },
  {
    name: "Stremio Website",
    url: "https://www.stremio.com/",
    intervalSeconds: INTERVAL,
  },
  {
    name: "Real-Debrid API",
    url: "https://api.real-debrid.com/rest/1.0/time",
    intervalSeconds: INTERVAL,
  },
  {
    name: "AllDebrid API",
    url: "https://api.alldebrid.com/v4/ping",
    intervalSeconds: INTERVAL,
  },
  {
    name: "Premiumize API",
    url: "https://www.premiumize.me/api/account/info",
    intervalSeconds: INTERVAL,
    // 401 = up but unauthenticated; we only care that the API answers.
    expectedStatusCodes: [200, 401],
  },
  {
    name: "TorBox API",
    url: "https://api.torbox.app/v1/api/stats",
    intervalSeconds: INTERVAL,
    expectedStatusCodes: [200, 401],
  },
];
