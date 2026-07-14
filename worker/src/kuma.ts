import { randomBytes } from "node:crypto";
import { config, USER_AGENT } from "./config.js";
import {
  type KumaClient,
  type KumaMonitor,
  type PublicGroup,
  type StatusPageConfig,
} from "./kuma-client.js";
import { logger } from "./logger.js";
import type { NormalizedAddon, ProbeResult } from "./types.js";

/**
 * Monitor identity: a Kuma tag named "slug" whose per-monitor value is the addon's stable slug.
 * Matching is by tag value, never by display name, so upstream renames keep the monitor (and its history).
 * The hub resolves addons to monitors by this same tag, so its name and semantics are a public contract.
 */
export const SLUG_TAG = "slug";
const SLUG_TAG_COLOR = "#7c3aed";

export const STATUS_PAGE_SLUG = "status";
const STATUS_PAGE_TITLE = "Stremio Addons Status";

/** Top-to-bottom group order on the status page; Kuma persists the array order of publicGroupList. */
const GROUP_ADDONS = "Addons";
const GROUP_INSTANCES = "Addon Instances";
const GROUP_PLATFORM = "Stremio Platform";
const GROUP_DEBRID = "Debrid Services";
const GROUP_INFRA = "Infrastructure";

export interface MonitorPlan {
  addon: NormalizedAddon;
  /** Stable identity: the slug-tag value. */
  slug: string;
  /** Display name (cosmetic; suffixed with the slug when it collides within its group). */
  name: string;
  group: typeof GROUP_ADDONS | typeof GROUP_INSTANCES;
}

/** A provisioned addon monitor the probe loop can push verdicts to. */
export interface Binding {
  addon: NormalizedAddon;
  monitorID: number;
  pushToken: string;
  name: string;
}

function groupFor(addon: NormalizedAddon): MonitorPlan["group"] {
  return addon.instanceOf ? GROUP_INSTANCES : GROUP_ADDONS;
}

function baseName(addon: NormalizedAddon): string {
  return addon.name || addon.slug || addon.uuid;
}

/**
 * Build one plan entry per addon. Display names aren't unique, so every sharer of a colliding
 * group+name gets a slug suffix (order-independent; purely cosmetic — identity is the slug tag).
 * Duplicate slugs would make two addons contend for one monitor, so later ones are dropped with a warning.
 */
export function buildMonitorPlan(addons: NormalizedAddon[]): MonitorPlan[] {
  const nameCounts = new Map<string, number>();
  const collisionKey = (a: NormalizedAddon) =>
    `${groupFor(a)}\n${baseName(a).trim().toLowerCase()}`;
  for (const addon of addons) {
    const k = collisionKey(addon);
    nameCounts.set(k, (nameCounts.get(k) ?? 0) + 1);
  }

  const seenSlugs = new Set<string>();
  const plan: MonitorPlan[] = [];
  for (const addon of addons) {
    const slug = addon.slug || addon.uuid;
    if (seenSlugs.has(slug)) {
      logger.warn({ slug, name: addon.name }, "duplicate addon slug; skipping");
      continue;
    }
    seenSlugs.add(slug);
    const name =
      (nameCounts.get(collisionKey(addon)) ?? 0) > 1
        ? `${baseName(addon)} (${slug})`
        : baseName(addon);
    plan.push({ addon, slug, name, group: groupFor(addon) });
  }
  return plan;
}

/** Fields shared by every monitor payload; Kuma validates their shape on every add/edit. */
const MONITOR_BASE = {
  parent: null,
  resendInterval: 0,
  upsideDown: false,
  notificationIDList: {},
  conditions: [],
  kafkaProducerBrokers: [],
  kafkaProducerSaslOptions: { mechanism: "None" },
  rabbitmqNodes: [],
} as const;

/**
 * Push-monitor payload for an addon. `interval` doubles as the watchdog: Kuma flips the monitor DOWN
 * after `interval + 1s` of push silence, so a dead worker self-reports without extra machinery.
 * `maxretries: 0` because a pushed DOWN is already final (the probe retried via WARP + direct);
 * with retries a pushed DOWN would linger in PENDING instead.
 */
function pushMonitorPayload(p: MonitorPlan, pushToken: string): Record<string, unknown> {
  return {
    ...MONITOR_BASE,
    type: "push",
    name: p.name,
    interval: config.pushWatchdog,
    retryInterval: config.pushWatchdog,
    maxretries: 0,
    pushToken,
    accepted_statuscodes: ["200-299"],
    description: `Deep-probed Stremio addon (slug: ${p.slug})`,
  };
}

export interface StaticMonitorDef {
  name: string;
  group: typeof GROUP_PLATFORM | typeof GROUP_DEBRID | typeof GROUP_INFRA;
  type: "http" | "keyword";
  url: string;
  method?: string;
  acceptedStatuscodes: string[];
  keyword?: string;
  /** Route through the WARP proxy so the check shares the worker's egress. */
  proxy: boolean;
}

/** Static platform/debrid/infrastructure checks, polled natively by Kuma (the worker only provisions them). */
export const STATIC_MONITORS: StaticMonitorDef[] = [
  // prettier-ignore
  { name: "Stremio API", group: GROUP_PLATFORM, type: "http", url: "https://api.strem.io/api/v1", method: "POST", acceptedStatuscodes: ["200", "400", "405"], proxy: true },
  // prettier-ignore
  { name: "Cinemeta", group: GROUP_PLATFORM, type: "keyword", url: "https://v3-cinemeta.strem.io/manifest.json", acceptedStatuscodes: ["200"], keyword: '"id"', proxy: true },
  // prettier-ignore
  { name: "Stremio Web Player", group: GROUP_PLATFORM, type: "http", url: "https://web.stremio.com/", acceptedStatuscodes: ["200"], proxy: true },
  // prettier-ignore
  { name: "Stremio Website", group: GROUP_PLATFORM, type: "http", url: "https://www.stremio.com/", acceptedStatuscodes: ["200"], proxy: true },
  // prettier-ignore
  { name: "Real-Debrid API", group: GROUP_DEBRID, type: "http", url: "https://api.real-debrid.com/rest/1.0/time", acceptedStatuscodes: ["200"], proxy: true },
  // prettier-ignore
  { name: "AllDebrid API", group: GROUP_DEBRID, type: "http", url: "https://api.alldebrid.com/v4/ping", acceptedStatuscodes: ["200"], proxy: true },
  // Debrid account APIs 401 without a key; reachable is what we monitor.
  // prettier-ignore
  { name: "Premiumize API", group: GROUP_DEBRID, type: "http", url: "https://www.premiumize.me/api/account/info", acceptedStatuscodes: ["200", "401"], proxy: true },
  // prettier-ignore
  { name: "TorBox API", group: GROUP_DEBRID, type: "http", url: "https://api.torbox.app/v1/api/stats", acceptedStatuscodes: ["200", "401"], proxy: true },
  // The addon list source; checked directly (not via WARP) because it must be reachable from our own network.
  // prettier-ignore
  { name: "stremio-addons.net", group: GROUP_INFRA, type: "keyword", url: "https://stremio-addons.net/health", acceptedStatuscodes: ["200"], keyword: "OK", proxy: false },
];

function staticMonitorPayload(
  def: StaticMonitorDef,
  proxyId: number | null,
): Record<string, unknown> {
  return {
    ...MONITOR_BASE,
    type: def.type,
    name: def.name,
    url: def.url,
    method: def.method ?? "GET",
    interval: 300,
    retryInterval: 60,
    // A single bad poll only goes PENDING; the retries decide, absorbing transient blips.
    maxretries: 2,
    timeout: 48,
    accepted_statuscodes: def.acceptedStatuscodes,
    ...(def.keyword ? { keyword: def.keyword, invertKeyword: false } : {}),
    proxyId: def.proxy ? proxyId : null,
    maxredirects: 10,
    ignoreTls: false,
    expiryNotification: false,
  };
}

let slugTagId: number | undefined;

async function ensureSlugTag(client: KumaClient): Promise<number> {
  if (slugTagId !== undefined) return slugTagId;
  const tags = await client.getTags();
  const existing = tags.find((t) => t.name === SLUG_TAG);
  slugTagId = existing?.id ?? (await client.addTag({ name: SLUG_TAG, color: SLUG_TAG_COLOR })).id;
  return slugTagId;
}

/** Ensure the WARP SOCKS5 proxy exists in Kuma so static monitors probe through the same egress as the worker. */
async function ensureProxy(client: KumaClient): Promise<number | null> {
  if (!config.proxyUrl) return null;
  const parsed = new URL(config.proxyUrl);
  const host = parsed.hostname;
  const port = Number(parsed.port || 1080);
  const existing = client.getProxies().find((p) => p.host === host && p.port === port);
  if (existing) return existing.id;
  // socks5h resolves DNS through the proxy, matching the worker's own fetch-socks behavior.
  return client.addProxy({
    protocol: "socks5h",
    host,
    port,
    auth: false,
    username: "",
    password: "",
    active: true,
    default: false,
    applyExisting: false,
  });
}

function slugOf(monitor: KumaMonitor): string | undefined {
  return monitor.tags?.find((t) => t.name === SLUG_TAG && t.value)?.value ?? undefined;
}

function isActive(monitor: KumaMonitor): boolean {
  return Boolean(monitor.active);
}

/** Fields the worker owns on an addon monitor; drift in any of them triggers an edit. */
export function addonMonitorDrift(
  existing: KumaMonitor,
  p: MonitorPlan,
): Partial<KumaMonitor> | null {
  const patch: Partial<KumaMonitor> = {};
  if (existing.name !== p.name) patch.name = p.name;
  if (existing.interval !== config.pushWatchdog) patch.interval = config.pushWatchdog;
  if (existing.retryInterval !== config.pushWatchdog) patch.retryInterval = config.pushWatchdog;
  if (existing.maxretries !== 0) patch.maxretries = 0;
  return Object.keys(patch).length > 0 ? patch : null;
}

export function staticMonitorDrift(
  existing: KumaMonitor,
  def: StaticMonitorDef,
  proxyId: number | null,
): Partial<KumaMonitor> | null {
  const patch: Partial<KumaMonitor> = {};
  if (existing.url !== def.url) patch.url = def.url;
  if ((existing.method ?? "GET") !== (def.method ?? "GET")) patch.method = def.method ?? "GET";
  const wantCodes = JSON.stringify(def.acceptedStatuscodes);
  if (JSON.stringify(existing.accepted_statuscodes) !== wantCodes) {
    patch.accepted_statuscodes = def.acceptedStatuscodes;
  }
  if (def.keyword && existing.keyword !== def.keyword) patch.keyword = def.keyword;
  const wantProxy = def.proxy ? proxyId : null;
  if ((existing.proxyId ?? null) !== wantProxy) patch.proxyId = wantProxy;
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Reconcile Kuma against the addon list: one push monitor per addon (created/renamed/resumed as needed,
 * paused when delisted — never deleted, so history survives a relisting), the static monitors, and the
 * status page. Idempotent: a run with no upstream changes makes zero API writes.
 */
export async function reconcile(client: KumaClient, addons: NormalizedAddon[]): Promise<Binding[]> {
  const tagId = await ensureSlugTag(client);
  const proxyId = await ensureProxy(client);
  const monitors = await client.getMonitors();

  const bySlug = new Map<string, KumaMonitor>();
  const byName = new Map<string, KumaMonitor>();
  for (const m of monitors.values()) {
    const slug = slugOf(m);
    if (slug) bySlug.set(slug, m);
    else if (m.type !== "push") byName.set(m.name, m);
  }

  const plan = buildMonitorPlan(addons);
  const stats = { added: 0, edited: 0, resumed: 0, paused: 0 };
  const bindings: Binding[] = [];

  // Addon push monitors. Serialized on purpose: ~540 adds on first boot finish in about a minute,
  // and pacing the socket keeps Kuma responsive.
  for (const p of plan) {
    const existing = bySlug.get(p.slug);
    if (!existing) {
      // The UI generates push tokens client-side the same way; add() persists ours verbatim.
      const pushToken = randomBytes(16).toString("hex");
      const monitorID = await client.addMonitor(pushMonitorPayload(p, pushToken));
      await client.addMonitorTag(tagId, monitorID, p.slug);
      bindings.push({ addon: p.addon, monitorID, pushToken, name: p.name });
      stats.added++;
      continue;
    }
    if (!existing.pushToken) {
      logger.error({ slug: p.slug, monitorID: existing.id }, "monitor has no push token; skipping");
      continue;
    }
    if (!isActive(existing)) {
      await client.resumeMonitor(existing.id);
      stats.resumed++;
    }
    const patch = addonMonitorDrift(existing, p);
    if (patch) {
      // editMonitor overwrites every field it knows from the payload (including pushToken),
      // so always round-trip the full monitorList JSON with just our fields changed.
      await client.editMonitor({ ...existing, ...patch });
      stats.edited++;
    }
    bindings.push({
      addon: p.addon,
      monitorID: existing.id,
      pushToken: existing.pushToken,
      name: p.name,
    });
  }

  // Delisted addons: pause (pushes to paused monitors 404, and step below drops them from the page).
  const planSlugs = new Set(plan.map((p) => p.slug));
  for (const [slug, m] of bySlug) {
    if (!planSlugs.has(slug) && isActive(m)) {
      await client.pauseMonitor(m.id);
      stats.paused++;
    }
  }

  // Static monitors, matched by exact name (they carry no slug tag).
  const staticIds = new Map<string, number>();
  for (const def of STATIC_MONITORS) {
    const existing = byName.get(def.name);
    if (!existing) {
      const id = await client.addMonitor(staticMonitorPayload(def, proxyId));
      staticIds.set(def.name, id);
      stats.added++;
      continue;
    }
    const patch = staticMonitorDrift(existing, def, proxyId);
    if (patch) {
      await client.editMonitor({ ...existing, ...patch });
      stats.edited++;
    }
    staticIds.set(def.name, existing.id);
  }

  const pageWrites = await ensureStatusPage(client, bindings, plan, staticIds);
  await ensureEntryPage(client);

  logger.info(
    { monitors: bindings.length, ...stats, pageWrites },
    "reconciled monitors with Uptime Kuma",
  );
  return bindings;
}

/** Desired status page groups in render order. Addon groups sort by display name for a stable page. */
export function desiredGroups(
  bindings: Binding[],
  plan: MonitorPlan[],
  staticIds: Map<string, number>,
): Array<{ name: string; monitorIds: number[] }> {
  const groupOf = new Map(plan.map((p) => [p.slug, p.group]));
  const byGroup = { [GROUP_ADDONS]: [] as Binding[], [GROUP_INSTANCES]: [] as Binding[] };
  for (const b of bindings) {
    const group = groupOf.get(b.addon.slug || b.addon.uuid);
    if (group) byGroup[group].push(b);
  }
  const sortedIds = (list: Binding[]) =>
    [...list].sort((a, b) => a.name.localeCompare(b.name)).map((b) => b.monitorID);
  const staticGroup = (group: StaticMonitorDef["group"]) =>
    STATIC_MONITORS.filter((d) => d.group === group)
      .map((d) => staticIds.get(d.name))
      .filter((id): id is number => id !== undefined);
  return [
    { name: GROUP_ADDONS, monitorIds: sortedIds(byGroup[GROUP_ADDONS]) },
    { name: GROUP_INSTANCES, monitorIds: sortedIds(byGroup[GROUP_INSTANCES]) },
    { name: GROUP_PLATFORM, monitorIds: staticGroup(GROUP_PLATFORM) },
    { name: GROUP_DEBRID, monitorIds: staticGroup(GROUP_DEBRID) },
    { name: GROUP_INFRA, monitorIds: staticGroup(GROUP_INFRA) },
  ];
}

/** Status page config fields the worker owns. showTags is the hub's lookup contract; keep it on. */
const PAGE_CONFIG = {
  title: STATUS_PAGE_TITLE,
  description:
    "Deep uptime checks for Stremio addons: does it actually return streams, not just a 200.",
  theme: "auto",
  showTags: true,
  autoRefreshInterval: 300,
  footerText: "Powered by stremio-addons.net",
  showPoweredBy: false,
  icon: "https://stremio-addons.net/favicon.ico",
} as const;

interface PublicStatusPage {
  config: StatusPageConfig;
  publicGroupList: Array<{ id: number; name: string; monitorList: Array<{ id: number }> }>;
}

/** Fetch the public status-page JSON; null when the page doesn't exist yet. */
async function fetchPublicStatusPage(): Promise<PublicStatusPage | null> {
  const res = await fetch(`${config.kumaUrl}/api/status-page/${STATUS_PAGE_SLUG}`, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`status page fetch failed: ${res.status}`);
  return (await res.json()) as PublicStatusPage;
}

/** Kuma caches the public status-page JSON briefly; remember our own writes so a stale read can't loop us. */
let lastSavedGroupsJson: string | undefined;

async function ensureStatusPage(
  client: KumaClient,
  bindings: Binding[],
  plan: MonitorPlan[],
  staticIds: Map<string, number>,
): Promise<number> {
  let current = await fetchPublicStatusPage();
  if (!current) {
    await client.addStatusPage(STATUS_PAGE_TITLE, STATUS_PAGE_SLUG);
    logger.info({ slug: STATUS_PAGE_SLUG }, "created status page");
  }

  const desired = desiredGroups(bindings, plan, staticIds);
  const desiredJson = JSON.stringify(desired);
  const currentGroups = (current?.publicGroupList ?? []).map((g) => ({
    name: g.name,
    monitorIds: g.monitorList.map((m) => m.id),
  }));
  const configDrift =
    !current ||
    Object.entries(PAGE_CONFIG).some(([k, v]) => current.config[k as keyof StatusPageConfig] !== v);
  const groupsDrift =
    JSON.stringify(currentGroups) !== desiredJson && lastSavedGroupsJson !== desiredJson;
  if (!configDrift && !groupsDrift) return 0;

  // Round-trip the live config (like the UI does) and overlay only the fields we own.
  const pageConfig = { ...(await client.getStatusPage(STATUS_PAGE_SLUG)), ...PAGE_CONFIG };
  // Reuse existing group ids by name so a save reorders rows instead of recreating groups.
  const idByName = new Map((current?.publicGroupList ?? []).map((g) => [g.name, g.id]));
  const publicGroupList: PublicGroup[] = desired.map((g) => ({
    ...(idByName.has(g.name) ? { id: idByName.get(g.name) } : {}),
    name: g.name,
    monitorList: g.monitorIds.map((id) => ({ id })),
  }));
  await client.saveStatusPage(STATUS_PAGE_SLUG, pageConfig, PAGE_CONFIG.icon, publicGroupList);
  lastSavedGroupsJson = desiredJson;
  return 1;
}

/** Point the Kuma root URL at the status page instead of the login screen (drift-guarded, usually a no-op). */
async function ensureEntryPage(client: KumaClient): Promise<void> {
  const settings = await client.getSettings();
  const want = `statusPage-${STATUS_PAGE_SLUG}`;
  if (settings.entryPage === want) return;
  await client.setSettings({ ...settings, entryPage: want });
}

/**
 * Push a probe verdict to the monitor's push endpoint (plain HTTP, no socket) and return the HTTP status.
 * A 404 means the token went stale or the monitor is paused; the next reconcile heals it.
 * Note: msg is stored per heartbeat but blanked in Kuma's public API — failure detail is admin-UI only.
 */
export async function pushResult(binding: Binding, r: ProbeResult): Promise<number> {
  const params = new URLSearchParams({
    status: r.success ? "up" : "down",
    msg: r.message,
    ping: String(r.durationMs),
  });
  const url = `${config.kumaUrl}/api/push/${binding.pushToken}?${params.toString()}`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  });
  return res.status;
}
