// Legacy Gatus integration, kept only for the dual-push migration window (enabled when GATUS_URL + PUSH_TOKEN are set).
// Delete this file, the gatus/ config dir, the compose service, and the yaml dependency after the Kener cutover.
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

/** Resolve an addon's display group: instances collapse under "Addon Instances", everything else under "Addons". */
function groupFor(addon: NormalizedAddon): string {
  return addon.instanceOf ? "Addon Instances" : "Addons";
}

/**
 * Top-to-bottom display order for the whole status page: the two worker-pushed dynamic groups sit above the static base groups (00-base.yaml).
 * Gatus has no group-ordering config and sorts alphabetically via localeCompare (TwiN/gatus#553), so we encode order as leading spaces:
 * localeCompare sorts more-spaces-first, HTML collapses leading spaces so they stay invisible, and Gatus derives the endpoint key by trimming the group -- so the key (and its history) is untouched.
 * The static base groups hardcode their matching space counts in 00-base.yaml; keep the two in sync (Stremio Platform = 2 spaces, Debrid Services = 1, Infrastructure = 0).
 */
const GROUP_ORDER = [
  "Addons",
  "Addon Instances",
  "Stremio Platform",
  "Debrid Services",
  "Infrastructure",
];
/** Highest rank in the scheme; leading-space count for a group is ORDER_MAX - rank (more spaces sort first). */
const ORDER_MAX = GROUP_ORDER.length - 1;

/** Prefix a group with invisible leading spaces so Gatus renders it in rank order instead of alphabetically. Unranked groups get none and sort last. */
function orderPrefix(group: string): string {
  const rank = GROUP_ORDER.indexOf(group);
  return rank < 0 ? group : " ".repeat(ORDER_MAX - rank) + group;
}

/** Display label for an addon: its real name, falling back to the unique slug then uuid. */
function baseName(addon: NormalizedAddon): string {
  return addon.name || addon.slug || addon.uuid;
}

/** Build one descriptor per addon with globally-unique Gatus keys. */
export function buildEndpoints(addons: NormalizedAddon[]): EndpointDescriptor[] {
  // Addon names aren't unique (slugs are), so pre-count shared name+group keys.
  // We disambiguate every sharer, not just the "losers": suffixing only later collisions would depend on list order, drifting the key (and its Postgres history) between refreshes.
  const nameCounts = new Map<string, number>();
  for (const addon of addons) {
    const k = keyOf(orderPrefix(groupFor(addon)), baseName(addon));
    nameCounts.set(k, (nameCounts.get(k) ?? 0) + 1);
  }

  // First pass: group + tentative name, suffixing the stable unique slug when the display name collides (never an order-dependent counter).
  const tentative = addons.map((addon) => {
    const group = orderPrefix(groupFor(addon));
    let name = baseName(addon);
    if ((nameCounts.get(keyOf(group, name)) ?? 0) > 1) name = `${name} (${addon.slug || addon.uuid})`;
    return { addon, group, name, key: keyOf(group, name) };
  });

  // Second pass backstop: sanitize can still collapse two distinct slugs into one key.
  // Fall back to the unique uuid for every colliding member, not just the later "losers": keying off list position would reattribute Postgres history when the API reorders.
  const keyCounts = new Map<string, number>();
  for (const t of tentative) keyCounts.set(t.key, (keyCounts.get(t.key) ?? 0) + 1);

  return tentative.map(({ addon, group, name, key }) => {
    if ((keyCounts.get(key) ?? 0) > 1) {
      name = `${baseName(addon)} (${addon.uuid})`;
      key = keyOf(group, name);
    }
    return { addon, name, group, key };
  });
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
