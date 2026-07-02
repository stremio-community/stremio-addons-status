import type { Manifest } from "@stremio-addon/sdk";
import { config, USER_AGENT } from "./config.js";
import type { NormalizedAddon } from "./types.js";

export async function fetchAllAddons(): Promise<NormalizedAddon[]> {
  const out: NormalizedAddon[] = [];
  let page = 1;
  for (;;) {
    const url = `${config.apiBase}/addons?page=${page}&limit=100&sort_by=stars&order=desc`;
    const body = await getApi<ApiResponse>(url);
    for (const addon of body.addons || []) {
      if (addon?.manifestUrl && addon?.manifest) out.push(normalizeAddon(addon));
    }
    if (!body.pagination?.hasNextPage) break;
    page = body.pagination.page + 1;
    // Safety gate against a pagination bug looping forever.
    if (page > (body.pagination.totalPages || 0) + 2) break;
  }
  return out;
}

interface ApiAddon {
  uuid: string;
  url: string;
  manifestUrl: string;
  manifest: Manifest;
  slug: string;
  stars: number;
  categories?: Array<{ name: string; slug: string }>;
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

function normalizeAddon(apiAddon: ApiAddon): NormalizedAddon {
  return {
    uuid: apiAddon.uuid,
    slug: apiAddon.slug,
    name: apiAddon.manifest?.name || apiAddon.slug || apiAddon.uuid,
    manifestUrl: apiAddon.manifestUrl,
    baseUrl: getBaseUrl(apiAddon.manifestUrl),
    stars: apiAddon.stars ?? 0,
    categories: (apiAddon.categories || []).map((c) => c.name).filter(Boolean),
  };
}

function getBaseUrl(manifestUrl: string): string {
  return manifestUrl.replace(/\/manifest\.json(\?.*)?$/i, "").replace(/\/$/, "");
}
