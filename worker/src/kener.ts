import { config, USER_AGENT } from "./config.js";
import { mapLimit } from "./concurrency.js";
import { logger } from "./logger.js";
import { errMsg } from "./utils.js";
import type { NormalizedAddon, ProbeResult } from "./types.js";

export interface MonitorDescriptor {
  addon: NormalizedAddon;
  /** Kener monitor tag: the addon's stable identity. Never derived from the display name. */
  tag: string;
  name: string;
  category: (typeof CATEGORY_ORDER)[number];
}

/**
 * Categories owned by the worker, in top-to-bottom display order on the status page.
 * Static monitors (bootstrap-kener.ts) live in other categories and keep their page positions after this block.
 */
export const CATEGORY_ORDER = ["Addons", "Addon Instances"] as const;

const WORKER_CATEGORIES: ReadonlySet<string> = new Set(CATEGORY_ORDER);

/** Resolve an addon's category: instances collapse under "Addon Instances", everything else under "Addons". */
function categoryFor(addon: NormalizedAddon): MonitorDescriptor["category"] {
  return addon.instanceOf ? "Addon Instances" : "Addons";
}

/**
 * Kener tags must match ^[a-z0-9][a-z0-9_-]*[a-z0-9]$ (or a single [a-z0-9]).
 * Slugs are unique upstream and already URL-safe, so this is near-identity.
 * The hub derives the same tag from the slug to look up status; keep the two in sync (stremio-addons-hub src/server/services/uptime.ts).
 */
export function tagOf(addon: Pick<NormalizedAddon, "slug" | "uuid">): string {
  const source = addon.slug || addon.uuid;
  const tag = source
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return tag || addon.uuid.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Build one descriptor per addon. Tags are slugs; slugs are unique, but normalization could in theory collide, so uuid-suffix every collider (order-independent). */
export function buildMonitors(addons: NormalizedAddon[]): MonitorDescriptor[] {
  const tagCounts = new Map<string, number>();
  for (const addon of addons) {
    const t = tagOf(addon);
    tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  }

  return addons.map((addon) => {
    let tag = tagOf(addon);
    if ((tagCounts.get(tag) ?? 0) > 1) tag = tagOf({ slug: `${tag}-${addon.uuid}`, uuid: addon.uuid });
    return {
      addon,
      tag,
      name: addon.name || addon.slug || addon.uuid,
      category: categoryFor(addon),
    };
  });
}

interface KenerMonitor {
  tag: string;
  name: string;
  category_name: string | null;
  monitor_type: string;
  status: string;
  is_hidden: string;
  external_url?: string | null;
}

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  const res = await fetch(`${config.kenerUrl}/api/v4${path}`, {
    method,
    headers: {
      "User-Agent": USER_AGENT,
      Authorization: `Bearer ${config.kenerApiToken}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`kener ${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  }
  return res;
}

/** Public page URL for an addon on stremio-addons.net, linked from the monitor. */
function externalUrl(addon: NormalizedAddon): string {
  return `https://stremio-addons.net/addons/${addon.slug}`;
}

/**
 * Reconcile the addon list into Kener monitors, keyed by stable slug tags.
 * Creates missing monitors, patches drifted display fields (renames are free: the tag never changes),
 * hides monitors whose addon left the list (never deletes: history survives relisting),
 * and rewrites the home page's monitor order (worker categories first, then the static block).
 */
export async function reconcileMonitors(monitors: MonitorDescriptor[]): Promise<void> {
  const res = await api("GET", "/monitors");
  const existing: KenerMonitor[] = ((await res.json()) as { monitors: KenerMonitor[] }).monitors;
  const byTag = new Map(existing.map((m) => [m.tag, m]));
  const wantedTags = new Set(monitors.map((m) => m.tag));

  const toCreate: MonitorDescriptor[] = [];
  const toPatch: Array<{ tag: string; patch: Record<string, unknown> }> = [];

  for (const m of monitors) {
    const remote = byTag.get(m.tag);
    if (!remote) {
      toCreate.push(m);
      continue;
    }
    const patch: Record<string, unknown> = {};
    if (remote.name !== m.name) patch.name = m.name;
    if (remote.category_name !== m.category) patch.category_name = m.category;
    if (remote.is_hidden !== "NO") patch.is_hidden = "NO";
    if (remote.status !== "ACTIVE") patch.status = "ACTIVE";
    if (remote.external_url !== externalUrl(m.addon)) patch.external_url = externalUrl(m.addon);
    if (Object.keys(patch).length > 0) toPatch.push({ tag: m.tag, patch });
  }

  // Addons gone from the list: hide + deactivate, never delete, so Postgres history survives a relisting.
  // INACTIVE also drops them from Kener's overall fleet status.
  for (const remote of existing) {
    const workerManaged = remote.category_name !== null && WORKER_CATEGORIES.has(remote.category_name);
    if (workerManaged && !wantedTags.has(remote.tag) && (remote.is_hidden !== "YES" || remote.status !== "INACTIVE")) {
      toPatch.push({ tag: remote.tag, patch: { is_hidden: "YES", status: "INACTIVE" } });
    }
  }

  let failures = 0;
  await mapLimit(toCreate, config.concurrency, async (m) => {
    try {
      await api("POST", "/monitors", {
        tag: m.tag,
        name: m.name,
        category_name: m.category,
        // Pure-push monitor: the worker supplies all data points.
        // No cron on purpose: Kener only schedules monitors that have one, so nothing runs server-side and
        // uptime is computed from the sparse pushed rows (NO_DATA minutes are excluded from Kener's math anyway).
        monitor_type: "NONE",
        type_data: { overrideWithLastKnownStatus: true },
        status: "ACTIVE",
        is_hidden: "NO",
        external_url: externalUrl(m.addon),
      });
    } catch (e) {
      failures++;
      logger.error({ tag: m.tag, err: errMsg(e) }, "kener monitor create failed");
    }
  });
  await mapLimit(toPatch, config.concurrency, async ({ tag, patch }) => {
    try {
      await api("PATCH", `/monitors/${tag}`, patch);
    } catch (e) {
      failures++;
      logger.error({ tag, patch, err: errMsg(e) }, "kener monitor patch failed");
    }
  });

  // Worker-managed = ours now or ever (covers hidden delisted monitors that must leave the page).
  const workerManagedTags = new Set(wantedTags);
  for (const remote of existing) {
    if (remote.category_name !== null && WORKER_CATEGORIES.has(remote.category_name)) {
      workerManagedTags.add(remote.tag);
    }
  }
  await reconcileHomePage(monitors, workerManagedTags);

  logger.info(
    { monitors: monitors.length, created: toCreate.length, patched: toPatch.length, failures },
    "kener monitors reconciled",
  );
}

/**
 * Rewrite the home page's monitor list: worker categories in CATEGORY_ORDER (each sorted by display name),
 * then every foreign (static/bootstrap) tag in its existing relative order.
 * Worker-managed tags missing from `monitors` (hidden/delisted) drop off the page here.
 * The pages PATCH replaces membership wholesale (position = array index), so this is idempotent.
 */
async function reconcileHomePage(monitors: MonitorDescriptor[], workerManagedTags: Set<string>): Promise<void> {
  const res = await api("GET", "/pages/~home");
  const page = ((await res.json()) as { page: { monitors: Array<{ monitor_tag: string; position: number }> } }).page;

  const foreign = page.monitors
    .sort((a, b) => a.position - b.position)
    .map((m) => m.monitor_tag)
    .filter((tag) => !workerManagedTags.has(tag));

  const ordered = CATEGORY_ORDER.flatMap((category) =>
    monitors
      .filter((m) => m.category === category)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((m) => m.tag),
  );

  await api("PATCH", "/pages/~home", { monitors: [...ordered, ...foreign] });
}

/** Push a probe verdict as a Kener data point at the current minute and return the HTTP status. */
export async function pushResult(monitor: MonitorDescriptor, r: ProbeResult): Promise<number> {
  const ts = Math.floor(Date.now() / 1000);
  const res = await fetch(`${config.kenerUrl}/api/v4/monitors/${monitor.tag}/data/${ts}`, {
    method: "PATCH",
    headers: {
      "User-Agent": USER_AGENT,
      Authorization: `Bearer ${config.kenerApiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ status: r.success ? "UP" : "DOWN", latency: r.durationMs }),
    signal: AbortSignal.timeout(15_000),
  });
  return res.status;
}
