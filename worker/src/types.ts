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
  /** The manifest's logo as advertised, unchecked: it may sit under the base URL and carry its config. */
  logo?: string;
  /** When set, this addon is an instance of the named parent; it groups under "Addon Instances" instead of "Addons". */
  instanceOf?: string;
}

export type ProbeMode = "content" | "liveness-only";

/** One label/value line explaining how a check was evaluated, shown in the status page's details dialog. */
export interface DetailRow {
  label: string;
  value: string;
}

export interface PerResourceResult {
  resource: string;
  ok: boolean;
  /** Terse verdict (e.g. `movie 3 of 5 valid`), shown as the condition on the status page and in Discord alerts. */
  summary: string;
  /** How the verdict was reached: the requests made, the routes tried and why it failed. */
  details: DetailRow[];
}

export interface ProbeResult {
  success: boolean;
  durationMs: number;
  /** Human-readable summary of the verdict, for logs. */
  message: string;
  error?: string;
  detail: {
    live: boolean;
    /** Why the liveness floor failed, set only when live is false. */
    livenessError?: string;
    /** How the manifest request went; empty when the probe never got that far. */
    manifestDetails: DetailRow[];
    mode: ProbeMode;
    /** The resource whose outcome drove the verdict; the others only annotate. */
    primary?: string;
    /** Why the content tier was skipped, set only in liveness-only mode. */
    skipReason?: string;
    perResource: PerResourceResult[];
    streamCounts?: { total: number; valid: number };
  };
}
