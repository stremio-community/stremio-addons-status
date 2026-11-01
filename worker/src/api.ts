import type { Manifest } from "@stremio-addon/sdk";
import { config, USER_AGENT } from "./config.js";
import type { NormalizedAddon } from "./types.js";

export async function fetchAllAddons(): Promise<NormalizedAddon[]> {
  // Keyed by uuid: an addon whose stars change mid-crawl moves across a page boundary and can come back twice, and Gatus refuses the whole config over a repeated key.
  const out = new Map<string, NormalizedAddon>();
  const add = (addon: NormalizedAddon) => {
    if (!out.has(addon.uuid)) out.set(addon.uuid, addon);
  };
  let page = 1;
  for (;;) {
    const url = `${config.apiBase}/addons?page=${page}&limit=100&sort_by=stars&order=desc`;
    const body = await getApi<ApiResponse>(url);
    for (const addon of body.addons || []) {
      if (addon?.manifestUrl && addon?.manifest) add(normalizeAddon(addon));
      const parentName = instanceParentName(addon);
      for (const inst of addon.instances || []) {
        if (inst?.manifestUrl && inst?.manifest) add(normalizeAddon(inst, parentName));
      }
    }
    if (!body.pagination?.hasNextPage) break;
    page = body.pagination.page + 1;
    // Safety gate against a pagination bug looping forever.
    if (page > (body.pagination.totalPages || 0) + 2) break;
  }

  return [...out.values()];
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
  /** Approved instances of this addon, inlined by the list endpoint in the same slim shape (empty when none). */
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
