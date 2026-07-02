import { writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { stringify } from "yaml";
import { config, USER_AGENT } from "./config.js";
import type { NormalizedAddon, ProbeResult } from "./types.js";

export interface EndpointDescriptor {
  addon: NormalizedAddon;
  name: string;
  group: string;
  key: string;
}

/**
 * Map an API category label to its display group, mirroring the stremio-addons-hub homepage sections.
 * The homepage collapses several labels into one section (movies + tv shows, music + radios), so the status page groups match.
 */
const LABEL_TO_GROUP: Record<string, string> = {
  movies: "Movies & Series",
  "tv shows": "Movies & Series",
  "live tv": "Live TV",
  torrents: "Torrents",
  usenet: "Usenet",
  "http streams": "HTTP Streams",
  subtitles: "Subtitles",
  anime: "Anime",
  "asian drama": "Asian Drama",
  bollywood: "Bollywood",
  "debrid support": "Debrid",
  metadata: "Metadata",
  misc: "Miscellaneous",
  music: "Music & Radio",
  radios: "Music & Radio",
  nsfw: "Adult Content (18+)",
};

/** Resolve an addon's display group: instances group under "<parent> Instances", others under their primary category. */
function groupFor(addon: NormalizedAddon): string {
  if (addon.instanceOf) return `${addon.instanceOf} Instances`;
  const primary = addon.categories[0];
  if (!primary) return "Uncategorized";
  return LABEL_TO_GROUP[primary.trim().toLowerCase()] || "Uncategorized";
}

/**
 * Top-to-bottom display order, matching the stremio-addons-hub homepage sections.
 * Gatus has no group-ordering config and sorts alphabetically via localeCompare (TwiN/gatus#553), so we encode order as leading spaces:
 * localeCompare sorts more-spaces-first, HTML collapses leading spaces so they stay invisible, and Gatus derives the endpoint key by trimming the group -- so the key (and its history) is untouched.
 */
const GROUP_ORDER = [
  "Movies & Series",
  "Live TV",
  "Torrents",
  "Usenet",
  "HTTP Streams",
  "Subtitles",
  "Anime",
  "Asian Drama",
  "Bollywood",
  "Debrid",
  "Metadata",
  "Miscellaneous",
  "Music & Radio",
  "Adult Content (18+)",
  "Uncategorized",
];

/**
 * All "<parent> Instances" groups share this rank so they render as one contiguous block below the category groups.
 * The static base groups (00-base.yaml) sit at the ranks below it; keep their leading-space counts in sync:
 *   Stremio Platform = rank INSTANCES_RANK+1 (2 spaces), Debrid Services = +2 (1 space), Infrastructure = +3 (0 spaces).
 */
const INSTANCES_RANK = GROUP_ORDER.length;
/** Highest rank in the scheme; leading-space count for a group is ORDER_MAX - rank (more spaces sort first). */
const ORDER_MAX = INSTANCES_RANK + 3;

/** Prefix a group with invisible leading spaces so Gatus renders it in rank order instead of alphabetically. Unranked groups get none and sort last. */
function orderPrefix(group: string, isInstance: boolean): string {
  const rank = isInstance ? INSTANCES_RANK : GROUP_ORDER.indexOf(group);
  return rank < 0 ? group : " ".repeat(ORDER_MAX - rank) + group;
}

/** Build one descriptor per addon with globally-unique Gatus keys. */
export function buildEndpoints(addons: NormalizedAddon[]): EndpointDescriptor[] {
  const used = new Set<string>();
  const out: EndpointDescriptor[] = [];
  for (const addon of addons) {
    const group = orderPrefix(groupFor(addon), !!addon.instanceOf);
    let name = addon.slug || addon.uuid;
    let key = keyOf(group, name);
    // Slugs are unique, but sanitize could still collapse two distinct ones; guard against cross-wired pushes.
    if (used.has(key)) {
      let n = 2;
      let candidate = `${name} (${n})`;
      while (used.has(keyOf(group, candidate))) candidate = `${name} (${++n})`;
      name = candidate;
      key = keyOf(group, name);
    }
    used.add(key);
    out.push({ addon, name, group, key });
  }
  return out;
}

interface ExternalEndpointYaml {
  name: string;
  group: string;
  token: string;
  alerts?: Array<Record<string, unknown>>;
}

/** Render + atomically write 10-endpoints.yaml into the shared Gatus config dir. */
export async function writeConfig(endpoints: EndpointDescriptor[]): Promise<void> {
  // No webhook configured -> omit alerts so the generated YAML doesn't carry dead discord entries.
  const alerts = config.discordWebhookUrl
    ? [
        {
          type: "discord",
          description: "addon down",
          "send-on-resolved": true,
          "failure-threshold": 1,
          "success-threshold": 1,
        },
      ]
    : undefined;

  const external: ExternalEndpointYaml[] = endpoints.map((e) => ({
    name: e.name,
    group: e.group,
    token: "${PUSH_TOKEN}",
    ...(alerts ? { alerts } : {}),
  }));

  const doc = stringify(
    { "external-endpoints": external },
    // aliasDuplicateObjects:false expands the shared alerts block per endpoint instead of emitting YAML anchors/aliases.
    { lineWidth: 0, aliasDuplicateObjects: false },
  );
  const header = "# Generated by the worker. Do not edit.\n";

  await mkdir(dirname(config.endpointsConfigPath), { recursive: true });
  const tmp = `${config.endpointsConfigPath}.tmp`;
  await writeFile(tmp, header + doc, "utf8");
  await rename(tmp, config.endpointsConfigPath); // atomic swap; Gatus hot-reloads
}

/** Push a probe verdict to Gatus's external-endpoint API and return the HTTP status. */
export async function pushResult(endpoint: EndpointDescriptor, r: ProbeResult): Promise<number> {
  const params = new URLSearchParams({
    success: String(r.success),
    duration: `${r.durationMs}ms`,
    error: r.message,
  });
  const url = `${config.gatusUrl}/api/v1/endpoints/${endpoint.key}/external?${params.toString()}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "User-Agent": USER_AGENT, Authorization: `Bearer ${config.pushToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  return res.status;
}

/**
 * Mirror Gatus's key rule (config/key/key.go): trim, lowercase, dash out ` / _ , . # + &`.
 * Lowercasing matters; "BGsubs" and "bgSubs" collide into one key, so dedup must too.
 */
function sanitize(part: string): string {
  return part
    .trim()
    .toLowerCase()
    .replace(/[ /_,.#+&]/g, "-");
}

function keyOf(group: string, name: string): string {
  return `${sanitize(group)}_${sanitize(name)}`;
}
