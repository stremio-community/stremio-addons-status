/** One addon as normalized from the stremio-addons.net API. */
export interface NormalizedAddon {
  uuid: string;
  slug: string;
  name: string;
  /** Full manifest URL as advertised (e.g. https://example.com/manifest.json or https://example.com/CONFIG/manifest.json). */
  manifestUrl: string;
  /** manifestUrl minus the trailing /manifest.json. */
  baseUrl: string;
  stars: number;
  /** Category names from the API, first is primary. */
  categories: string[];
  /** When set, this addon is an instance of the named parent; it groups under "Addon Instances" instead of "Addons". */
  instanceOf?: string;
}

export type ProbeMode = "content" | "liveness-only";

export interface PerResourceResult {
  resource: string;
  ok: boolean;
  detail: string;
}

export interface ProbeResult {
  success: boolean;
  durationMs: number;
  /** Human-readable message pushed to Gatus (shown on the endpoint page). */
  message: string;
  error?: string;
  detail: {
    live: boolean;
    mode: ProbeMode;
    /** The resource whose outcome drove the verdict; the others only annotate. */
    primary?: string;
    /** Why the content tier was skipped, set only in liveness-only mode. */
    skipReason?: string;
    perResource: PerResourceResult[];
    streamCounts?: { total: number; valid: number };
  };
}
