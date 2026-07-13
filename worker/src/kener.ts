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

/** A monitor is the worker's own only if it is a pure-push NONE monitor in a worker category. */
function isWorkerManaged(remote: KenerMonitor): boolean {
  return remote.monitor_type === "NONE" && remote.category_name !== null && WORKER_CATEGORIES.has(remote.category_name);
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
  for (const remote of existing) {
    if (isWorkerManaged(remote) && !wantedTags.has(remote.tag) && (remote.is_hidden !== "YES" || remote.status !== "INACTIVE")) {
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

  // Worker-managed = ours now or ever (covers hidden delisted monitors that must leave the pages).
  const workerManagedTags = new Set(wantedTags);
  for (const remote of existing) {
    if (isWorkerManaged(remote)) workerManagedTags.add(remote.tag);
  }
  await reconcilePages(monitors, workerManagedTags);

  logger.info(
    { monitors: monitors.length, created: toCreate.length, patched: toPatch.length, failures },
    "kener monitors reconciled",
  );
}

/**
 * Max monitors per Kener page. Two reasons: a page fetches all of its monitors in a single
 * monitor-bars batch request, which Kener caps at 100 tags, and a page with hundreds of
 * 90-day bars is unusably heavy in the browser anyway.
 */
const PAGE_SHARD_SIZE = 100;

/** Shard-page paths the worker owns; never hand-create pages matching these. */
const SHARD_PATH_RE = /^(addons|addon-instances)-\d+$/;

export interface PageShard {
  path: string;
  title: string;
  tags: string[];
}

/** Slice the worker's monitors into shard pages per category, sorted by display name, ≤ PAGE_SHARD_SIZE each. */
export function shardPages(monitors: MonitorDescriptor[]): PageShard[] {
  const groups: Array<{ prefix: string; label: string; category: MonitorDescriptor["category"] }> = [
    { prefix: "addons", label: "Addons", category: "Addons" },
    { prefix: "addon-instances", label: "Addon Instances", category: "Addon Instances" },
  ];

  return groups.flatMap((g) => {
    const tags = monitors
      .filter((m) => m.category === g.category)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((m) => m.tag);
    const count = Math.ceil(tags.length / PAGE_SHARD_SIZE);
    return Array.from({ length: count }, (_, i) => ({
      path: `${g.prefix}-${i + 1}`,
      title: count > 1 ? `${g.label} (${i + 1}/${count})` : g.label,
      tags: tags.slice(i * PAGE_SHARD_SIZE, (i + 1) * PAGE_SHARD_SIZE),
    }));
  });
}

interface KenerPage {
  page_path: string;
  page_title: string;
  monitors: Array<{ monitor_tag: string; position: number }>;
}

/**
 * Reconcile Kener's pages: the home page keeps only foreign (static) monitors, while the
 * worker's monitors are sharded across its own pages (addons-N / addon-instances-N) so no
 * single page exceeds PAGE_SHARD_SIZE. Shard membership follows display names, so a rename
 * may move a monitor between shards; that's cosmetic — identity and history live on the tag.
 * Every pages PATCH replaces membership wholesale (position = array index), so this is idempotent.
 */
async function reconcilePages(monitors: MonitorDescriptor[], workerManagedTags: Set<string>): Promise<void> {
  const res = await api("GET", "/pages");
  const pages: KenerPage[] = ((await res.json()) as { pages: KenerPage[] }).pages;
  const byPath = new Map(pages.map((p) => [p.page_path, p]));

  const memberTags = (p: KenerPage) =>
    p.monitors.sort((a, b) => a.position - b.position).map((m) => m.monitor_tag);

  // Home: foreign (static/seeded) monitors only, in their existing relative order.
  const home = byPath.get("~home");
  if (home) {
    const foreign = memberTags(home).filter((tag) => !workerManagedTags.has(tag));
    if (foreign.length !== home.monitors.length) {
      await api("PATCH", "/pages/~home", { monitors: foreign });
    }
  }

  const shards = shardPages(monitors);
  for (const shard of shards) {
    const existing = byPath.get(shard.path);
    if (!existing) {
      await api("POST", "/pages", {
        page_path: shard.path,
        page_title: shard.title,
        page_header: shard.title,
        monitors: shard.tags,
      });
    } else if (
      existing.page_title !== shard.title ||
      memberTags(existing).join(",") !== shard.tags.join(",")
    ) {
      await api("PATCH", `/pages/${shard.path}`, {
        page_title: shard.title,
        page_header: shard.title,
        monitors: shard.tags,
      });
    }
  }

  // Shard pages that no longer exist in the plan (list shrank) hold no history; delete them.
  const wantedPaths = new Set(shards.map((s) => s.path));
  for (const p of pages) {
    if (SHARD_PATH_RE.test(p.page_path) && !wantedPaths.has(p.page_path)) {
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
