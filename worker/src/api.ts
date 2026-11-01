import type { Manifest } from "@stremio-addon/sdk";
import { config, USER_AGENT } from "./config.js";
import type { NormalizedAddon } from "./types.js";

export async function fetchAllAddons(): Promise<NormalizedAddon[]> {
  const out: NormalizedAddon[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    // Pages are edge-cached for up to a day, so each can be a snapshot from a different time; keyset order on createdAt keeps them from overlapping however stale they are.
    let url = `${config.apiBase}/addons?sort_by=createdAt&order=asc&limit=100`;
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
    const body = await getApi<ApiResponse>(url);
    for (const addon of body.addons || []) {
      if (addon?.manifestUrl && addon?.manifest) out.push(normalizeAddon(addon));
      const parentName = instanceParentName(addon);
      for (const inst of addon.instances || []) {
        if (inst?.manifestUrl && inst?.manifest) out.push(normalizeAddon(inst, parentName));
      }
    }
    if (!body.pagination?.hasNextPage) break;
    cursor = body.pagination.nextCursor ?? null;
    if (!cursor) throw new Error(`API reported a next page without a cursor for ${url}`);
    if (seenCursors.has(cursor)) throw new Error(`API repeated cursor ${cursor} for ${url}`);
    seenCursors.add(cursor);
  }
  return out;
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
    /** Opaque keyset cursor for the page after this one; null on the last page. */
    nextCursor: string | null;
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
    ...(apiAddon.manifest?.logo ? { logo: apiAddon.manifest.logo } : {}),
    ...(instanceOf ? { instanceOf } : {}),
  };
}

function getBaseUrl(manifestUrl: string): string {
  return manifestUrl.replace(/\/manifest\.json(\?.*)?$/i, "").replace(/\/$/, "");
}
