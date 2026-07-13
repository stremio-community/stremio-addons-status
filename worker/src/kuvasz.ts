import { createHmac } from "node:crypto";
import { config, USER_AGENT } from "./config.js";
import { mapLimit } from "./concurrency.js";
import { logger } from "./logger.js";
import { STATIC_HTTP_MONITORS, type StaticHttpMonitor } from "./staticmonitors.js";
import type { NormalizedAddon, ProbeResult } from "./types.js";

export interface MonitorDescriptor {
  addon: NormalizedAddon;
  name: string;
  clientSecret: string;
}

/** Reconciliation fan-out. Kept modest: Kuvasz's connection pool deadlocks under large request bursts (see kuvasz/kuvasz.yml). */
const RECONCILE_CONCURRENCY = 4;

/** Kuvasz-side name of the Discord integration defined in kuvasz/kuvasz.yml. */
const DISCORD_INTEGRATION = "discord:alerts";

/**
 * Derive an addon's push-monitor client secret from its stable slug.
 * The secret doubles as the monitor's identity: reconciliation matches monitors by secret, never by name,
 * so display names can change freely (Kuvasz keys history to the immutable monitor id).
 * The hub cannot derive ids or secrets; it resolves monitors by display-name candidates instead (hub uptime.ts).
 */
export function clientSecretOf(slug: string): string {
  return createHmac("sha256", config.pushSecretSeed).update(slug).digest("hex");
}

/** Display label for an addon: its real name, falling back to the unique slug then uuid. */
function baseName(addon: NormalizedAddon): string {
  return addon.name || addon.slug || addon.uuid;
}

/**
 * Build one push-monitor descriptor per addon with globally-unique display names (Kuvasz requires name uniqueness).
 * Names are display-only; identity lives in the client secret. The suffix rules still must be deterministic because
 * the hub mirrors them to resolve a monitor from an addon's name+slug — keep in sync with the hub's uptime.ts.
 */
export function buildMonitors(addons: NormalizedAddon[]): MonitorDescriptor[] {
  // Addon names aren't unique (slugs are), so pre-count shared names.
  // We disambiguate every sharer, not just the "losers": suffixing only later collisions would depend on list order, flapping names between refreshes.
  const nameCounts = new Map<string, number>();
  for (const addon of addons) {
    const n = baseName(addon);
    nameCounts.set(n, (nameCounts.get(n) ?? 0) + 1);
  }

  const tentative = addons.map((addon) => {
    let name = baseName(addon);
    if ((nameCounts.get(name) ?? 0) > 1) name = `${name} (${addon.slug || addon.uuid})`;
    return { addon, name, clientSecret: clientSecretOf(addon.slug || addon.uuid) };
  });

  // Backstop: a raw name could equal another addon's suffixed name. Fall back to the uuid for every collider.
  const finalCounts = new Map<string, number>();
  for (const t of tentative) finalCounts.set(t.name, (finalCounts.get(t.name) ?? 0) + 1);

  return tentative.map((t) =>
    (finalCounts.get(t.name) ?? 0) > 1
      ? { ...t, name: `${baseName(t.addon)} (${t.addon.uuid})` }
      : t,
  );
}

interface PushMonitor {
  id: number;
  name: string;
  heartbeatInterval: number;
  gracePeriod: number;
  enabled: boolean;
  clientSecret: string;
  failureCountThreshold: number;
  integrations: string[];
}

interface HttpMonitor {
  id: number;
  name: string;
  url: string;
  uptimeCheckInterval: number;
  enabled: boolean;
  requestMethod: string;
  followRedirects: boolean;
  failureCountThreshold: number;
  expectedStatusCodes: number[] | null;
  expectedKeyword: string | null;
  integrations: string[];
}

async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`${config.kuvaszUrl}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      "User-Agent": USER_AGENT,
      "X-API-KEY": config.kuvaszApiKey,
      ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Kuvasz ${init?.method ?? "GET"} ${path} responded ${res.status}: ${body.slice(0, 200)}`,
    );
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/** Integrations every worker-managed monitor should alert through. Empty webhook = Discord disabled. */
function desiredIntegrations(): string[] {
  return config.discordWebhookUrl ? [DISCORD_INTEGRATION] : [];
}

function sameSet(a: readonly (string | number)[], b: readonly (string | number)[]): boolean {
  return a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");
}

/**
 * Reconcile Kuvasz's push monitors against the current addon list.
 * The worker owns ALL push monitors: unknown ones are treated as delisted addons and disabled
 * (never deleted, so history survives a relisting). Static checks are HTTP monitors, not push monitors.
 */
export async function reconcile(descriptors: MonitorDescriptor[]): Promise<void> {
  const heartbeatInterval = Math.round(config.probeInterval / 1000);
  // A monitor's beats drift within the probe cycle, so allow a full extra cycle before Kuvasz flags a missed heartbeat.
  const gracePeriod = heartbeatInterval;
  const integrations = desiredIntegrations();

  const existing = await api<PushMonitor[]>("/api/v2/push-monitors");
  const bySecret = new Map(existing.map((m) => [m.clientSecret, m]));

  let created = 0;
  let patched = 0;
  let disabled = 0;
  let failed = 0;

  await mapLimit(descriptors, RECONCILE_CONCURRENCY, async (d) => {
    const log = logger.child({ addon: d.addon.slug });
    try {
      const cur = bySecret.get(d.clientSecret);
      if (!cur) {
        await api("/api/v2/push-monitors", {
          method: "POST",
          body: {
            name: d.name,
            heartbeatInterval,
            gracePeriod,
            failureCountThreshold: 1,
            enabled: true,
            clientSecret: d.clientSecret,
            integrations,
          },
        });
        created++;
        return;
      }
      const patch: Record<string, unknown> = {};
      if (cur.name !== d.name) patch.name = d.name;
      if (cur.heartbeatInterval !== heartbeatInterval) patch.heartbeatInterval = heartbeatInterval;
      if (cur.gracePeriod !== gracePeriod) patch.gracePeriod = gracePeriod;
      if (!cur.enabled) patch.enabled = true;
      if (!sameSet(cur.integrations ?? [], integrations)) patch.integrations = integrations;
      if (Object.keys(patch).length > 0) {
        await api(`/api/v2/push-monitors/${cur.id}`, { method: "PATCH", body: patch });
        patched++;
      }
    } catch (e) {
      // A rename can transiently collide with a name another monitor is about to give up; the next refresh settles it.
      failed++;
      log.warn({ err: errText(e) }, "push monitor reconcile failed");
    }
  });

  const known = new Set(descriptors.map((d) => d.clientSecret));
  const stale = existing.filter((m) => !known.has(m.clientSecret) && m.enabled);
  await mapLimit(stale, RECONCILE_CONCURRENCY, async (m) => {
    try {
      await api(`/api/v2/push-monitors/${m.id}`, { method: "PATCH", body: { enabled: false } });
      disabled++;
    } catch (e) {
      failed++;
      logger.warn({ monitor: m.name, err: errText(e) }, "disabling delisted monitor failed");
    }
  });

  logger.info(
    { total: descriptors.length, created, patched, disabled, failed },
    "push monitors reconciled",
  );
}

/**
 * Upsert the static HTTP monitors (Kuvasz probes these natively, with latency).
 * Matched by name; HTTP monitors the worker doesn't know are left alone, so hand-created checks survive.
 */
export async function reconcileStaticMonitors(): Promise<void> {
  const integrations = desiredIntegrations();
  const existing = await api<HttpMonitor[]>("/api/v2/http-monitors");
  const byName = new Map(existing.map((m) => [m.name, m]));

  for (const s of STATIC_HTTP_MONITORS) {
    try {
      const cur = byName.get(s.name);
      if (!cur) {
        await api("/api/v2/http-monitors", { method: "POST", body: staticBody(s, integrations) });
        logger.info({ monitor: s.name }, "static monitor created");
        continue;
      }
      const desired = staticBody(s, integrations);
      const patch: Record<string, unknown> = {};
      if (cur.url !== desired.url) patch.url = desired.url;
      if (cur.uptimeCheckInterval !== desired.uptimeCheckInterval)
        patch.uptimeCheckInterval = desired.uptimeCheckInterval;
      if (cur.requestMethod !== desired.requestMethod) patch.requestMethod = desired.requestMethod;
      if (cur.failureCountThreshold !== desired.failureCountThreshold)
        patch.failureCountThreshold = desired.failureCountThreshold;
      if (!sameSet(cur.expectedStatusCodes ?? [], desired.expectedStatusCodes ?? []))
        patch.expectedStatusCodes = desired.expectedStatusCodes ?? [];
      if ((cur.expectedKeyword ?? null) !== (desired.expectedKeyword ?? null))
        patch.expectedKeyword = desired.expectedKeyword ?? null;
      if (!cur.enabled) patch.enabled = true;
      if (!sameSet(cur.integrations ?? [], integrations)) patch.integrations = integrations;
      if (Object.keys(patch).length > 0) {
        await api(`/api/v2/http-monitors/${cur.id}`, { method: "PATCH", body: patch });
        logger.info({ monitor: s.name }, "static monitor updated");
      }
    } catch (e) {
      logger.warn({ monitor: s.name, err: errText(e) }, "static monitor reconcile failed");
    }
  }
}

function staticBody(s: StaticHttpMonitor, integrations: string[]) {
  return {
    name: s.name,
    url: s.url,
    uptimeCheckInterval: s.intervalSeconds,
    requestMethod: s.method ?? "GET",
    // Flag DOWN (and alert) only after 2 consecutive failures, matching the alert threshold the old Gatus setup used.
    failureCountThreshold: 2,
    enabled: true,
    ...(s.expectedStatusCodes ? { expectedStatusCodes: s.expectedStatusCodes } : {}),
    ...(s.expectedKeyword ? { expectedKeyword: s.expectedKeyword } : {}),
    integrations,
  };
}

/**
 * Push a probe verdict as a heartbeat (UP) or an explicit failure (DOWN) and return the HTTP status.
 * Kuvasz push monitors carry no latency; durations stay in the worker's logs only.
 */
export async function pushVerdict(monitor: MonitorDescriptor, r: ProbeResult): Promise<number> {
  const base = `${config.kuvaszUrl}/api/v2/push-monitors/heartbeats/${monitor.clientSecret}`;
  const res = await fetch(r.success ? base : `${base}/failure`, {
    method: "POST",
    headers: { "User-Agent": USER_AGENT, "Content-Type": "application/json" },
    body: JSON.stringify(r.success ? {} : { error: r.message }),
    signal: AbortSignal.timeout(15_000),
  });
  return res.status;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
