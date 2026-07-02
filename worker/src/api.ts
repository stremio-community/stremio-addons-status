import type { Manifest } from "@stremio-addon/sdk";
import { config, USER_AGENT } from "./config.js";
import { mapLimit } from "./concurrency.js";
import { errMsg } from "./utils.js";
import { logger } from "./logger.js";
import type { NormalizedAddon } from "./types.js";

export async function fetchAllAddons(): Promise<NormalizedAddon[]> {
  const out: NormalizedAddon[] = [];
  const withInstances: ApiAddon[] = [];
  let page = 1;
  for (;;) {
    const url = `${config.apiBase}/addons?page=${page}&limit=100&sort_by=stars&order=desc`;
    const body = await getApi<ApiResponse>(url);
    for (const addon of body.addons || []) {
      if (addon?.manifestUrl && addon?.manifest) out.push(normalizeAddon(addon));
      // Instances are only exposed on the per-addon detail endpoint; queue addons that advertise them.
      if (addon?.slug && addon.hasInstances) withInstances.push(addon);
    }
    if (!body.pagination?.hasNextPage) break;
    page = body.pagination.page + 1;
    // Safety gate against a pagination bug looping forever.
    if (page > (body.pagination.totalPages || 0) + 2) break;
  }

  // Fetch each instance-bearing addon's detail and append its approved instances under a "<parent> Instances" group.
  const instanceLists = await mapLimit(withInstances, config.concurrency, (parent) =>
    fetchInstances(parent),
  );
  for (const list of instanceLists) out.push(...list);

  return out;
}

/** Fetch one addon's detail endpoint and normalize its approved instances. Non-fatal: logs and returns [] on error. */
async function fetchInstances(parent: ApiAddon): Promise<NormalizedAddon[]> {
  try {
    const detail = await getApi<ApiAddonDetail>(`${config.apiBase}/addons/${parent.slug}`);
    const parentName = instanceParentName(parent);
    return (detail.instances || [])
      .filter((inst) => inst?.manifestUrl && inst?.manifest)
      .map((inst) => normalizeAddon(inst, parentName));
  } catch (e) {
    logger.warn({ slug: parent.slug, err: errMsg(e) }, "failed to fetch addon instances");
    return [];
  }
}

/** Group label stem for a parent's instances: manifest name up to the first "|" (e.g. "Comet | ElfHosted" -> "Comet"). */
function instanceParentName(parent: ApiAddon): string {
  const name = parent.manifest?.name || parent.slug || parent.uuid;
  return name.split("|")[0].trim() || parent.slug || parent.uuid;
}

interface ApiAddon {
  uuid: string;
  url: string;
  manifestUrl: string;
  manifest: Manifest;
  slug: string;
  stars: number;
  categories?: Array<{ name: string; slug: string }>;
  /** Set by the list endpoint when the addon has approved instances reachable via the detail endpoint. */
  hasInstances?: boolean;
}

/** Single-addon detail response; extends the list shape with approved instances. */
interface ApiAddonDetail extends ApiAddon {
  instances?: ApiAddon[];
}

interface ApiResponse {
  addons: ApiAddon[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
}

async function getApi<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`API responded ${res.status} for ${url}`);
  return (await res.json()) as T;
}

function normalizeAddon(apiAddon: ApiAddon, instanceOf?: string): NormalizedAddon {
  return {
    uuid: apiAddon.uuid,
    slug: apiAddon.slug,
    name: apiAddon.manifest?.name || apiAddon.slug || apiAddon.uuid,
    manifestUrl: apiAddon.manifestUrl,
    baseUrl: getBaseUrl(apiAddon.manifestUrl),
    stars: apiAddon.stars ?? 0,
    categories: (apiAddon.categories || []).map((c) => c.name).filter(Boolean),
    ...(instanceOf ? { instanceOf } : {}),
  };
}

function getBaseUrl(manifestUrl: string): string {
  return manifestUrl.replace(/\/manifest\.json(\?.*)?$/i, "").replace(/\/$/, "");
}
