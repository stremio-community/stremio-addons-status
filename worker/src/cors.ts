import type { PerResourceResult } from "./types.js";

/** Stremio Web loads addons from the browser under this origin, so an addon must allow it for Stremio Web to read its answers. */
export const STREMIO_WEB_ORIGIN = "https://web.stremio.com";

/** Many servers emit CORS headers only for a request that carries an `Origin`, so the probe sends Stremio Web's. */
export const STREMIO_WEB_HEADERS = { Origin: STREMIO_WEB_ORIGIN };

/** Browsers accept only `*` or the exact origin, not a list or a near match. */
export function allowsStremioWeb(allowOrigin: string | undefined): boolean {
  const value = allowOrigin?.trim();
  return value === "*" || value === STREMIO_WEB_ORIGIN;
}

/** An informational annotation for an answer Stremio Web can't read, or undefined when it can. */
export function corsAnnotation(
  path: string,
  allowOrigin: string | undefined,
): PerResourceResult | undefined {
  if (allowsStremioWeb(allowOrigin)) return undefined;
  return {
    resource: "cors",
    ok: false,
    summary: `${allowOrigin === undefined ? "missing" : "other origin"}, fails in Stremio Web`,
    details: [
      { label: "Request", value: path },
      { label: "Origin", value: STREMIO_WEB_ORIGIN },
      { label: "Access-Control-Allow-Origin", value: allowOrigin ?? "none" },
      { label: "Reason", value: "the browser blocks Stremio Web from reading the answer" },
    ],
  };
}
