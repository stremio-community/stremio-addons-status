/**
 * Curated per-addon probe settings, keyed by the addon's uuid.
 * Everything here is public: never put a secret, a user's config or a configured base URL in it.
 */
export interface AddonOverride {
  /** For humans reading this file; the probe ignores it. */
  name: string;
  /**
   * A secret-free config path segment anyone can generate on the addon's configure page, inserted before `/manifest.json` when probing.
   * It lets the probe content-check a `configurationRequired` addon; it is never pushed to Gatus.
   */
  testConfig?: string;
  /** Pin the addon as needs-configuration (liveness-only) when its unconfigured answers can't be told from broken ones; the value says why. */
  needsConfig?: string;
  /** Fixed test IDs for an addon whose scope no ID source covers, tried in order before any other source. */
  testIds?: Array<{ type: string; id: string }>;
}

export const OVERRIDES: Readonly<Record<string, AddonOverride>> = {};

export function overrideFor(uuid: string): AddonOverride | undefined {
  return OVERRIDES[uuid];
}
