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
 * Categories owned by the worker. Each category is published on its own shard pages (see shardPages);
 * static monitors (scripts/seed-kener.sql) live in other categories on the home page, which the worker
 * never adds its own monitors to.
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
  type_data?: { monitors?: Array<{ tag: string }> } | null;
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

/** A monitor is the worker's own only if it is a pure-push NONE member or a GROUP aggregate in a worker category. */
function isWorkerManaged(remote: KenerMonitor): boolean {
  return (
    (remote.monitor_type === "NONE" || remote.monitor_type === "GROUP") &&
    remote.category_name !== null &&
    WORKER_CATEGORIES.has(remote.category_name)
  );
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

  // The worker only ever owns NONE monitors it created itself. If an addon's tag is already taken
  // by a foreign monitor (a static check or something hand-made), the addon moves to a
  // uuid-suffixed tag instead of hijacking it. Deterministic, so every refresh lands on the same tag;
  // the hub can't derive suffixed tags, so that addon simply shows no uptime widget.
  for (const m of monitors) {
    const remote = byTag.get(m.tag);
    if (remote && remote.monitor_type !== "NONE") {
      const suffixed = tagOf({ slug: `${m.tag}-${m.addon.uuid}`, uuid: m.addon.uuid });
      logger.warn({ tag: m.tag, suffixed }, "tag occupied by a foreign monitor; using suffixed tag");
      m.tag = suffixed;
    }
  }
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
  // NONE only: GROUP monitors are worker-managed too but reconcileGroups owns their lifecycle.
  for (const remote of existing) {
    if (
      remote.monitor_type === "NONE" &&
      isWorkerManaged(remote) &&
      !wantedTags.has(remote.tag) &&
      (remote.is_hidden !== "YES" || remote.status !== "INACTIVE")
    ) {
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

  const groups = buildGroups(monitors);
  await reconcileGroups(groups, existing);

  // Worker-managed = ours now or ever (covers hidden delisted monitors that must leave the page).
  const workerManagedTags = new Set(wantedTags);
  for (const g of groups) workerManagedTags.add(g.tag);
  for (const remote of existing) {
    if (isWorkerManaged(remote)) workerManagedTags.add(remote.tag);
  }
  await reconcilePages(groups, workerManagedTags);

  logger.info(
    { monitors: monitors.length, groups: groups.length, created: toCreate.length, patched: toPatch.length, failures },
    "kener monitors reconciled",
  );
}

/**
 * Max members per GROUP monitor: the public page's member drawer fetches all member bars
 * in a single monitor-bars batch request, which Kener caps at 100 tags.
 */
const GROUP_SIZE = 100;

/** Legacy worker-owned shard pages from before the GROUP monitor layout; deleted on sight. */
const LEGACY_SHARD_PATH_RE = /^(addons|addon-instances)-\d+$/;

export interface GroupSpec {
  tag: string;
  name: string;
  category: MonitorDescriptor["category"];
  memberTags: string[];
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Group the worker's monitors into GROUP monitor specs: addons by their primary list category,
 * instances as one group, each chunked to ≤ GROUP_SIZE members (sorted by display name).
 * Group tags live under the group- prefix so they can't collide with addon slugs.
 */
export function buildGroups(monitors: MonitorDescriptor[]): GroupSpec[] {
  const buckets = new Map<string, { name: string; category: MonitorDescriptor["category"]; members: MonitorDescriptor[] }>();
  for (const m of monitors) {
    const isInstance = m.category === "Addon Instances";
    const label = isInstance ? "Addon Instances" : titleCase(m.addon.categories[0] || "Other");
    const tag = isInstance ? "group-addon-instances" : `group-addons-${tagOf({ slug: label, uuid: m.addon.uuid })}`;
    const bucket = buckets.get(tag) ?? { name: label, category: m.category, members: [] };
    bucket.members.push(m);
    buckets.set(tag, bucket);
  }

  return [...buckets.entries()]
    .sort(([, a], [, b]) => (a.category === b.category ? a.name.localeCompare(b.name) : a.category === "Addons" ? -1 : 1))
    .flatMap(([tag, bucket]) => {
      const memberTags = bucket.members.sort((a, b) => a.name.localeCompare(b.name)).map((m) => m.tag);
      const count = Math.ceil(memberTags.length / GROUP_SIZE);
      return Array.from({ length: count }, (_, i) => ({
        tag: count > 1 ? `${tag}-${i + 1}` : tag,
        name: count > 1 ? `${bucket.name} (${i + 1}/${count})` : bucket.name,
        category: bucket.category,
        memberTags: memberTags.slice(i * GROUP_SIZE, (i + 1) * GROUP_SIZE),
      }));
    });
}

/** Create/patch the GROUP monitors and hide the ones whose category vanished. */
async function reconcileGroups(groups: GroupSpec[], existing: KenerMonitor[]): Promise<void> {
  const byTag = new Map(existing.map((m) => [m.tag, m]));
  const wanted = new Set(groups.map((g) => g.tag));

  for (const g of groups) {
    const typeData = {
      monitors: g.memberTags.map((tag) => ({ tag, weight: 1 })),
      latencyCalculation: "AVG",
    };
    const remote = byTag.get(g.tag);
    if (!remote) {
      await api("POST", "/monitors", {
        tag: g.tag,
        name: g.name,
        category_name: g.category,
        monitor_type: "GROUP",
        // Unlike the pure-push member monitors, groups are evaluated by Kener itself:
        // each run reads the members' latest cached statuses and writes one aggregate row.
        cron: "*/5 * * * *",
        type_data: typeData,
        status: "ACTIVE",
        is_hidden: "NO",
      });
      continue;
    }
    const remoteMembers = (remote.type_data?.monitors ?? []).map((m) => m.tag);
    const patch: Record<string, unknown> = {};
    if (remote.name !== g.name) patch.name = g.name;
    if (remote.category_name !== g.category) patch.category_name = g.category;
    if (remote.is_hidden !== "NO") patch.is_hidden = "NO";
    if (remote.status !== "ACTIVE") patch.status = "ACTIVE";
    if (remoteMembers.join(",") !== g.memberTags.join(",")) patch.type_data = typeData;
    if (Object.keys(patch).length > 0) await api("PATCH", `/monitors/${g.tag}`, patch);
  }

  // Groups whose category vanished: hide + deactivate (INACTIVE also stops their cron), never delete.
  for (const remote of existing) {
    if (
      remote.monitor_type === "GROUP" &&
      remote.category_name !== null &&
      WORKER_CATEGORIES.has(remote.category_name) &&
      !wanted.has(remote.tag) &&
      (remote.is_hidden !== "YES" || remote.status !== "INACTIVE")
    ) {
      await api("PATCH", `/monitors/${remote.tag}`, { is_hidden: "YES", status: "INACTIVE" });
    }
  }
}

interface KenerPage {
  page_path: string;
  monitors: Array<{ monitor_tag: string; position: number }>;
}

/**
 * Reconcile Kener's pages: the home page shows the worker's GROUP monitors (member monitors
 * live off-page and lazy-load in the group drawer) followed by the foreign (static/seeded)
 * monitors in their existing relative order. The pages PATCH replaces membership wholesale
 * (position = array index), so this is idempotent.
 */
async function reconcilePages(groups: GroupSpec[], workerManagedTags: Set<string>): Promise<void> {
  const res = await api("GET", "/pages");
  const pages: KenerPage[] = ((await res.json()) as { pages: KenerPage[] }).pages;

  const home = pages.find((p) => p.page_path === "~home");
  if (home) {
    const foreign = home.monitors
      .sort((a, b) => a.position - b.position)
      .map((m) => m.monitor_tag)
      .filter((tag) => !workerManagedTags.has(tag));
    const wantedMembership = [...groups.map((g) => g.tag), ...foreign];
    const current = home.monitors.sort((a, b) => a.position - b.position).map((m) => m.monitor_tag);
    if (current.join(",") !== wantedMembership.join(",")) {
      await api("PATCH", "/pages/~home", { monitors: wantedMembership });
    }
  }

  for (const p of pages) {
    if (LEGACY_SHARD_PATH_RE.test(p.page_path)) {
      await api("DELETE", `/pages/${p.page_path}`);
    }
  }
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
