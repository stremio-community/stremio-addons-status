import { writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { stringify } from "yaml";
import { config, USER_AGENT } from "./config.js";
import type { DetailRow, NormalizedAddon, ProbeResult } from "./types.js";
import { sleep } from "./utils.js";

export interface EndpointDescriptor {
  addon: NormalizedAddon;
  name: string;
  group: string;
  key: string;
  /** Shown next to the group on the status page so instances of the same addon can be told apart; empty when the manifest URL won't parse. */
  hostname: string;
  /** Shown as the Discord alert's thumbnail; empty when the manifest has none or it isn't safe to publish. */
  logo: string;
}

/** Resolve an addon's display group: instances collapse under "Addon Instances", everything else under "Addons". */
function groupFor(addon: NormalizedAddon): string {
  return addon.instanceOf ? "Addon Instances" : "Addons";
}

/**
 * Top-to-bottom display order for the whole status page: the two worker-pushed dynamic groups sit above the static base groups (00-base.yaml).
 * Gatus has no group-ordering config and sorts alphabetically via localeCompare (TwiN/gatus#553), so we encode order as leading spaces:
 * localeCompare sorts more-spaces-first and HTML collapses leading spaces so they stay invisible.
 * The endpoint key is the addon's explicit uuid (independent of group and name), so prefixing spaces onto the group is purely cosmetic and never touches identity or history.
 * The static base groups hardcode their matching space counts in 00-base.yaml; keep the two in sync (Stremio Platform = 3 spaces, Debrid Services = 2, Services = 1, Infrastructure = 0).
 */
const GROUP_ORDER = [
  "Addons",
  "Addon Instances",
  "Stremio Platform",
  "Debrid Services",
  "Services",
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

/** Hostname only, never the full manifest URL: some manifest URLs carry user config or API keys in their path. */
function hostnameOf(addon: NormalizedAddon): string {
  return URL.parse(addon.manifestUrl)?.hostname ?? "";
}

/** Gatus rejects a longer logo, and the whole push with it. */
const MAX_LOGO_LENGTH = 2048;

/**
 * The manifest's logo, only when it's an absolute http(s) URL that doesn't carry the base URL's path, where a configured addon keeps its config or API key.
 * A base URL without a path carries no config, so logos served from an unconfigured addon's own host survive.
 */
function logoOf(addon: NormalizedAddon): string {
  const logo = URL.parse(addon.logo ?? "");
  if (logo?.protocol !== "https:" && logo?.protocol !== "http:") return "";
  if (logo.href.length > MAX_LOGO_LENGTH) return "";
  const base = URL.parse(addon.baseUrl);
  if (!base || carriesPathSegment(logo.href, base.pathname)) return "";
  return logo.href;
}

/**
 * Whether the URL holds any segment of the path whole, as in `/<key>/logo.png` or `?token=<key>`, decoded so a different percent-encoding still matches.
 * Whole segments only, so a `/free` base doesn't drop `/free.png`.
 */
function carriesPathSegment(url: string, path: string): boolean {
  const text = decode(url);
  return path
    .split("/")
    .filter(Boolean)
    .some((segment) =>
      new RegExp(`(^|[/?#&=])${escapeRegExp(decode(segment))}([/?#&=]|$)`).test(text),
    );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Build one descriptor per addon.
 * Identity is the addon's stable uuid, pushed as Gatus's explicit `key` (TwiN/gatus#1146), so it survives renames and regroups; the display name is just a label and needn't be unique.
 * The uuid is globally unique and contains only [0-9a-f-] (none of which sanitize rewrites), so sanitize(uuid) is injective -- no disambiguation needed.
 */
export function buildEndpoints(addons: NormalizedAddon[]): EndpointDescriptor[] {
  // Gatus refuses the whole config over a repeated key, so fail the refresh and keep serving the previous one.
  const seen = new Set<string>();
  for (const { uuid } of addons) {
    if (seen.has(uuid)) throw new Error(`addon list repeats uuid ${uuid}`);
    seen.add(uuid);
  }
  return addons.map((addon) => ({
    addon,
    name: baseName(addon),
    group: orderPrefix(groupFor(addon)),
    key: addon.uuid,
    hostname: hostnameOf(addon),
    logo: logoOf(addon),
  }));
}

export interface ExternalEndpointYaml {
  name: string;
  key: string;
  group: string;
  token: string;
  alerts?: Array<Record<string, unknown>>;
}

/**
 * Map descriptors to Gatus external-endpoint entries.
 * Discord alerts render only the group and name, which instances share, so the alert description carries the hostname.
 * Gatus shows the description on both the triggered and the resolved alert, so it names the instance without claiming it is down.
 */
export function buildExternalEndpoints(
  endpoints: EndpointDescriptor[],
  withAlerts: boolean,
): ExternalEndpointYaml[] {
  return endpoints.map((e) => ({
    name: e.name,
    key: e.key,
    group: e.group,
    token: "${PUSH_TOKEN}",
    ...(withAlerts
      ? {
          alerts: [
            {
              type: "discord",
              ...(e.hostname ? { description: e.hostname } : {}),
              "send-on-resolved": true,
              "failure-threshold": 1,
              "success-threshold": 1,
            },
          ],
        }
      : {}),
  }));
}

/** Render + atomically write 10-endpoints.yaml into the shared Gatus config dir. */
export async function writeConfig(endpoints: EndpointDescriptor[]): Promise<void> {
  // No webhook configured -> omit alerts so the generated YAML doesn't carry dead discord entries.
  const external = buildExternalEndpoints(endpoints, Boolean(config.discordWebhookUrl));
  const doc = stringify(
    { "external-endpoints": external },
    // aliasDuplicateObjects:false expands any shared object per endpoint instead of emitting YAML anchors/aliases.
    { lineWidth: 0, aliasDuplicateObjects: false },
  );
  const header = "# Generated by the worker. Do not edit.\n";

  await mkdir(dirname(config.endpointsConfigPath), { recursive: true });
  const tmp = `${config.endpointsConfigPath}.tmp`;
  await writeFile(tmp, header + doc, "utf8");
  await rename(tmp, config.endpointsConfigPath); // atomic swap; Gatus hot-reloads
}

/** One line of the per-probe breakdown, as Gatus's external-endpoint API accepts it. */
export interface ConditionResult {
  condition: string;
  success: boolean;
  details?: DetailRow[];
}

/** Gatus rejects a push exceeding these limits outright, so trim to fit instead of losing the whole verdict. */
const MAX_DETAILS_PER_CONDITION = 20;
/** Measured in UTF-8 bytes, as Gatus measures it, not in JS string length. */
const MAX_DETAIL_VALUE_BYTES = 512;
const ELLIPSIS = "…";

function truncate(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const budget = maxBytes - Buffer.byteLength(ELLIPSIS);
  let out = "";
  let bytes = 0;
  for (const char of text) {
    bytes += Buffer.byteLength(char);
    if (bytes > budget) break;
    out += char;
  }
  return out + ELLIPSIS;
}

/**
 * Flatten a verdict into the per-probe breakdown Gatus renders under "Conditions", each condition carrying the detail rows behind it.
 * The condition strings are shown on the status page and in Discord alerts, so keep them terse and in `resource: verdict` shape.
 * Only the primary resource can flip the verdict, so everything else is tagged as informational -- otherwise a healthy addon carrying a failed secondary check reads as a contradiction.
 * The status page is public and a base URL can carry the addon's config or API key, so every occurrence of it is stripped, leaving paths relative to the base.
 */
export function buildConditions(r: ProbeResult, baseUrl: string): ConditionResult[] {
  const { live, livenessError, manifestDetails, primary, skipReason, configReason, perResource } =
    r.detail;
  const redact = (text: string) => (baseUrl ? text.replaceAll(baseUrl, "") : text);
  const condition = (
    text: string,
    success: boolean,
    details: DetailRow[] = [],
  ): ConditionResult => {
    const rows = details.slice(0, MAX_DETAILS_PER_CONDITION).map(({ label, value }) => ({
      label,
      value: truncate(redact(value), MAX_DETAIL_VALUE_BYTES),
    }));
    return { condition: redact(text), success, ...(rows.length > 0 ? { details: rows } : {}) };
  };

  const conditions = [
    condition(
      `manifest: ${live ? "reachable" : (livenessError ?? "unreachable")}`,
      live,
      manifestDetails,
    ),
  ];
  for (const res of perResource) {
    const decides = res.resource === primary;
    conditions.push(
      condition(`${res.resource}: ${res.summary}${decides ? "" : " (informational)"}`, res.ok, [
        { label: "Role", value: decides ? "decides verdict" : "informational" },
        ...res.details,
      ]),
    );
  }
  if (skipReason) {
    conditions.push(condition(`content: not deep-checked (${skipReason})`, true));
  }
  if (r.detail.mode === "needs-config") {
    conditions.push(
      condition(
        "content: needs configuration",
        true,
        configReason ? [{ label: "Reason", value: configReason }] : [],
      ),
    );
  }
  // A red result must say why on the status page and in the alert, even when the probe recorded no failing check.
  if (!r.success && conditions.every((c) => c.success)) {
    conditions.push(condition(r.message || "probe failed", false));
  }
  return conditions;
}

/**
 * Push a probe verdict to Gatus's external-endpoint API, retrying until Gatus has loaded the endpoint, and return the HTTP status.
 * The hostname rides along on every push because Gatus stores it per result and the card shows the latest one.
 * The logo rides along too because Gatus doesn't store it at all: it only reaches the Discord alerts sent while handling the push that carried it.
 * The breakdown travels only as conditions: Gatus renders the `error` param as a separate block in the same tooltip and Discord alerts format the conditions themselves, so sending the message too would just duplicate it in both places.
 */
export async function pushResult(endpoint: EndpointDescriptor, r: ProbeResult): Promise<number> {
  const params = new URLSearchParams({
    success: String(r.success),
    duration: `${r.durationMs}ms`,
  });
  if (endpoint.hostname) params.set("hostname", endpoint.hostname);
  if (endpoint.logo) params.set("logo", endpoint.logo);
  const url = `${config.gatusUrl}/api/v1/endpoints/${endpoint.key}/external?${params.toString()}`;
  const body = JSON.stringify({ conditionResults: buildConditions(r, endpoint.addon.baseUrl) });
  const post = () =>
    fetch(url, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        Authorization: `Bearer ${config.pushToken}`,
        "Content-Type": "application/json",
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });

  for (const delay of PUSH_RETRY_DELAYS_MS) {
    try {
      const res = await post();
      if (res.status !== 404) return res.status;
    } catch (e) {
      if (isTimeout(e)) throw e;
    }
    await sleep(delay);
  }
  return (await post()).status;
}

/**
 * Gatus picks up a rewritten config only on its 30-second poll, then stops its HTTP server while it reloads.
 * Until then it answers 404 for an endpoint the worker just wrote, and during the reload the connection fails, so the delays span both before giving up.
 * The worker only pushes keys it wrote, so a 404 always means Gatus hasn't caught up yet.
 */
const PUSH_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

/** A timed-out push may still have been stored, so retrying it could record the verdict twice. */
function isTimeout(e: unknown): boolean {
  return e instanceof DOMException && e.name === "TimeoutError";
}
