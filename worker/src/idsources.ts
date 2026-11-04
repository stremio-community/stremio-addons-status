import type { MetaDetail, MetaPreview } from "@stremio-addon/sdk";
import { getJson } from "./http.js";
import { encodeId } from "./utils.js";
import { config } from "./config.js";
import { resourceAccepts, type NormResource } from "./manifest.js";

export interface TestContent {
  type: string;
  id: string;
  /** Episode id (e.g. `tt0944947:1:1`) when `type` needs a specific video. */
  episodeId?: string;
  /** Where the id came from (an ID source's name, or `own catalog`), shown next to it on the status page. */
  source?: string;
}

interface CatalogResponse {
  metas?: Array<MetaPreview & { imdb_id?: string }>;
}
interface MetaResponse {
  meta?: MetaDetail;
}

interface IdSource {
  name: string;
  /** Manifest idPrefixes this source can supply test IDs for. */
  prefixes: string[];
  resolve(): Promise<TestContent[]>;
}

async function firstEpisodeId(
  baseUrl: string,
  type: string,
  id: string,
): Promise<string | undefined> {
  try {
    const { status, data } = await getJson<MetaResponse>(
      `${baseUrl}/meta/${type}/${encodeId(id)}.json`,
      config.timeouts.meta,
    );
    if (status < 200 || status >= 300) return undefined;
    const videos = data?.meta?.videos;
    return videos && videos.length > 0 ? videos[0].id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fetch a catalog and turn its first meta into a test ID.
 * Returns `undefined` if unavailable.
 */
async function firstFromCatalog(
  base: string,
  catalogUrl: string,
  opts: { type?: string; episodic?: boolean; preferImdb?: boolean } = {},
): Promise<TestContent | undefined> {
  try {
    const { data } = await getJson<CatalogResponse>(catalogUrl, config.timeouts.catalog);
    const m = data?.metas?.[0];
    if (!m) return undefined;
    const type = opts.type ?? m.type ?? "series";
    const id = opts.preferImdb ? m.imdb_id || m.id : m.id;
    const episodeId = opts.episodic ? await firstEpisodeId(base, type, id) : undefined;
    return { type, id, episodeId };
  } catch {
    return undefined; // source unavailable this cycle
  }
}

/** tt -> Cinemeta. */
const cinemeta: IdSource = {
  name: "cinemeta",
  prefixes: ["tt"],
  async resolve() {
    const base = "https://v3-cinemeta.strem.io";
    const results = await Promise.all([
      firstFromCatalog(base, `${base}/catalog/movie/top.json`, { type: "movie", preferImdb: true }),
      firstFromCatalog(base, `${base}/catalog/series/top.json`, {
        type: "series",
        episodic: true,
        preferImdb: true,
      }),
    ]);
    return results.filter((c): c is TestContent => c !== undefined);
  },
};

/** kitsu -> Anime Kitsu. */
const kitsu: IdSource = {
  name: "kitsu",
  prefixes: ["kitsu"],
  async resolve() {
    const base = "https://anime-kitsu.strem.fun";
    const c = await firstFromCatalog(base, `${base}/catalog/anime/kitsu-anime-trending.json`, {
      episodic: true,
    });
    return c ? [c] : [];
  },
};

const SOURCES: IdSource[] = [cinemeta, kitsu];

/**
 * Per-cycle cache: each source is resolved once and shared across all scrapers of that prefix, so we don't hammer Cinemeta/Anime Kitsu once per addon.
 */
const cache = new Map<string, Promise<TestContent[]>>();

/** Clear cached IDs at the start of a probe cycle so IDs rotate over time. */
export function resetCycle(): void {
  cache.clear();
}

function normalizePrefix(p: string): string {
  return p.replace(/:$/, "");
}

/** Resolve test content for an addon whose stream resource declares `idPrefixes`. */
export async function resolveForPrefixes(idPrefixes: readonly string[]): Promise<TestContent[]> {
  const wanted = idPrefixes.map(normalizePrefix);
  const source = SOURCES.find((s) => s.prefixes.some((sp) => wanted.includes(sp)));
  if (!source) return [];
  let pending = cache.get(source.name);
  if (!pending) {
    pending = source
      .resolve()
      .then((contents) => contents.map((c) => ({ ...c, source: source.name })));
    cache.set(source.name, pending);
  }
  return pending;
}

/** True if any registered source can supply IDs for these prefixes. */
export function hasSourceFor(idPrefixes: readonly string[]): boolean {
  const wanted = idPrefixes.map(normalizePrefix);
  return SOURCES.some((s) => s.prefixes.some((sp) => wanted.includes(sp)));
}

/**
 * Ordered test IDs for a stream or subtitles resource, best fit first, from every source whose prefixes and types the resource accepts.
 * Callers try them in order and stop at the first that yields content, so later entries cost nothing for a healthy addon.
 */
export async function candidatesFor(res: NormResource): Promise<TestContent[]> {
  if (!hasSourceFor(res.idPrefixes)) return [];
  const all = await resolveForPrefixes(res.idPrefixes);
  return all.filter((c) => resourceAccepts(res, c.type, c.episodeId ?? c.id));
}
