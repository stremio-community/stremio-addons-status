import { getJson } from "./http.js";
import { encodeId, errMsg } from "./utils.js";
import { config } from "./config.js";
import { resourceAccepts, type NormResource } from "./manifest.js";
import { streamIdForMeta, type PlayableMeta } from "./episodes.js";
import { logger } from "./logger.js";

export interface TestContent {
  type: string;
  id: string;
  /** Episode id (e.g. `tt0944947:1:1`) when `type` needs a specific video. */
  episodeId?: string;
  /** Where the id came from (an ID source's name, or `own catalog`), shown next to it on the status page. */
  source?: string;
}

interface CatalogItem {
  id: string;
  type?: string;
  imdb_id?: string;
  releaseInfo?: string;
}
interface CatalogResponse {
  metas?: CatalogItem[];
}

/** Anime Kitsu maps each video to its IMDb counterpart. */
interface KitsuMeta extends PlayableMeta {
  imdb_id?: string;
  videos?: Array<{
    id: string;
    season?: number;
    episode?: number;
    imdb_id?: string;
    imdbSeason?: number;
    imdbEpisode?: number;
  }>;
}
interface MetaResponse<M> {
  meta?: M;
}

const CINEMETA = "https://v3-cinemeta.strem.io";
const KITSU = "https://anime-kitsu.strem.fun";

/**
 * Titles old and popular enough that scrapers in every language carry them, so no verdict rests on one fresh release.
 * Each type's list is rotated per cycle, so no single title is load-bearing either.
 */
const WELL_KNOWN: TestContent[] = [
  { type: "movie", id: "tt0111161" }, // The Shawshank Redemption
  { type: "movie", id: "tt1375666" }, // Inception
  { type: "movie", id: "tt0468569" }, // The Dark Knight
  { type: "movie", id: "tt15398776" }, // Oppenheimer
  { type: "movie", id: "tt0133093" }, // The Matrix
  { type: "series", id: "tt0944947", episodeId: "tt0944947:1:1" }, // Game of Thrones
  { type: "series", id: "tt0903747", episodeId: "tt0903747:1:1" }, // Breaking Bad
  { type: "series", id: "tt4574334", episodeId: "tt4574334:1:1" }, // Stranger Things
  { type: "series", id: "tt0108778", episodeId: "tt0108778:1:1" }, // Friends
];

/** Long-finished anime with broad fansub and dub coverage, rotated like WELL_KNOWN. */
const WELL_KNOWN_ANIME: Array<{ type: string; id: string }> = [
  { type: "series", id: "kitsu:7442" }, // Attack on Titan
  { type: "series", id: "kitsu:1376" }, // Death Note
  { type: "series", id: "kitsu:3936" }, // Fullmetal Alchemist: Brotherhood
  { type: "series", id: "kitsu:10740" }, // One Punch Man
  { type: "movie", id: "kitsu:176" }, // Spirited Away
];

/** Public videos that have stayed up for well over a decade. */
const YOUTUBE_VIDEOS = ["dQw4w9WgXcQ", "jNQXAC9IVRw"];

/** How many items of a live top catalog join the curated titles. */
const TOP_PICKS = 2;
const PER_TYPE = 4;
/** Keeps one source from filling a type's candidates, so a gap in that source alone can't decide the verdict. */
const PER_SOURCE_PER_TYPE = 2;

const FULL_IMDB_ID = /^tt\d+$/;

interface Cycle {
  rotation: number;
  year: string;
}
let cycle = cycleAt(Date.now());

function cycleAt(now: number): Cycle {
  return {
    rotation: Math.floor(now / config.probeInterval),
    year: String(new Date(now).getUTCFullYear()),
  };
}

/** Per-cycle cache: each lookup runs once and is shared across all addons, so we don't hammer Cinemeta/Anime Kitsu once per addon. */
const cache = new Map<string, Promise<unknown>>();

/** Clear cached IDs at the start of a probe cycle and advance the rotation of curated titles. */
export function resetCycle(now: number = Date.now()): void {
  cache.clear();
  cycle = cycleAt(now);
}

function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  let pending = cache.get(key) as Promise<T> | undefined;
  if (!pending) {
    pending = load();
    cache.set(key, pending);
  }
  return pending;
}

async function fetchData<T>(url: string, timeout: number): Promise<T | undefined> {
  try {
    const { status, data } = await getJson<T>(url, timeout);
    return status >= 200 && status < 300 ? data : undefined;
  } catch (e) {
    logger.debug({ step: "idsource", url, err: errMsg(e) }, "ID source request failed");
    return undefined;
  }
}

function rotate<T>(items: readonly T[], by: number): T[] {
  if (items.length === 0) return [];
  const n = by % items.length;
  return [...items.slice(n), ...items.slice(0, n)];
}

/** Rotates each type's entries on its own, keeping the list's type order. */
function rotateByType<T extends { type: string }>(items: readonly T[]): T[] {
  const types = [...new Set(items.map((i) => i.type))];
  return types.flatMap((t) =>
    rotate(
      items.filter((i) => i.type === t),
      cycle.rotation,
    ),
  );
}

function interleave<T>(lists: readonly T[][]): T[] {
  const out: T[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) {
    for (const l of lists) if (i < l.length) out.push(l[i]);
  }
  return out;
}

/** A top-list item released this year is often unreleased, or out for days, so few scrapers have it yet. */
function isFreshRelease(item: CatalogItem): boolean {
  return item.releaseInfo?.startsWith(cycle.year) ?? false;
}

async function topItems(base: string, catalogPath: string): Promise<CatalogItem[]> {
  const data = await fetchData<CatalogResponse>(`${base}${catalogPath}`, config.timeouts.catalog);
  return (data?.metas ?? [])
    .filter((m) => typeof m?.id === "string" && !isFreshRelease(m))
    .slice(0, TOP_PICKS);
}

function cinemetaStreamId(id: string): Promise<string | undefined> {
  return cached(`cinemeta-meta:${id}`, async () => {
    const data = await fetchData<MetaResponse<PlayableMeta>>(
      `${CINEMETA}/meta/series/${encodeId(id)}.json`,
      config.timeouts.meta,
    );
    return data?.meta ? streamIdForMeta({ ...data.meta, id }) : undefined;
  });
}

/** Cinemeta's top titles minus this year's releases, keeping Cinemeta in the mix so the IDs stay current. */
function cinemetaTop(): Promise<TestContent[]> {
  return cached("cinemeta", async () => {
    const [movies, series] = await Promise.all([
      topItems(CINEMETA, "/catalog/movie/top.json"),
      topItems(CINEMETA, "/catalog/series/top.json"),
    ]);
    const episodes = await Promise.all(
      series.map(async (m): Promise<TestContent | undefined> => {
        const id = m.imdb_id || m.id;
        const episodeId = await cinemetaStreamId(id);
        return episodeId ? { type: "series", id, episodeId } : undefined;
      }),
    );
    return [
      ...movies.map((m) => ({ type: "movie", id: m.imdb_id || m.id })),
      ...episodes.filter((c) => c !== undefined),
    ];
  });
}

interface AnimeTitle {
  kitsu: TestContent;
  imdb?: TestContent;
}

async function kitsuTitle(type: string, id: string): Promise<AnimeTitle | undefined> {
  const data = await fetchData<MetaResponse<KitsuMeta>>(
    `${KITSU}/meta/${encodeURIComponent(type)}/${encodeId(id)}.json`,
    config.timeouts.meta,
  );
  const meta = data?.meta;
  if (!meta) return undefined;
  const metaType = meta.type ?? type;
  const streamId = streamIdForMeta({ ...meta, id });
  const kitsu: TestContent = {
    type: metaType,
    id,
    ...(streamId !== id ? { episodeId: streamId } : {}),
  };
  if (metaType === "movie") {
    return { kitsu, imdb: meta.imdb_id ? { type: metaType, id: meta.imdb_id } : undefined };
  }
  const video = meta.videos?.find((v) => v.id === streamId);
  const imdbId = video?.imdb_id ?? meta.imdb_id;
  const imdb =
    imdbId && video?.imdbSeason !== undefined && video.imdbEpisode !== undefined
      ? {
          type: metaType,
          id: imdbId,
          episodeId: `${imdbId}:${video.imdbSeason}:${video.imdbEpisode}`,
        }
      : undefined;
  return { kitsu, imdb };
}

/** Curated anime plus Anime Kitsu's trending titles, each with the IMDb ID of the same episode where Kitsu knows it. */
function animeTitles(): Promise<AnimeTitle[]> {
  return cached("kitsu", async () => {
    const trending = await topItems(KITSU, "/catalog/anime/kitsu-anime-trending.json");
    const picks = interleave<{ type: string; id: string }>([
      rotateByType(WELL_KNOWN_ANIME),
      trending.map((m) => ({ type: m.type ?? "series", id: m.id })),
    ]);
    const unique = picks.filter((p, i) => picks.findIndex((q) => q.id === p.id) === i);
    const titles = await Promise.all(unique.map((p) => kitsuTitle(p.type, p.id)));
    return titles.filter((t) => t !== undefined);
  });
}

/** Sources are tried by rank, lowest first. */
const Rank = { exact: 0, best: 1, good: 2, fallback: 3, last: 4 } as const;

interface IdSource {
  name: string;
  /** Whether the source can supply IDs for these normalized prefixes. */
  matches(prefixes: readonly string[]): boolean;
  rank(res: NormResource): number;
  /** Candidates in this source's own order, typed as the source names them. */
  resolve(res: NormResource): Promise<TestContent[]>;
}

function normalizePrefix(p: string): string {
  return p.replace(/:$/, "");
}

const hasType = (types: readonly string[], type: string): boolean =>
  types.some((t) => t.toLowerCase() === type);

/**
 * Anime addons often accept `tt` too, since users reach anime through Cinemeta as well, but rarely carry live-action titles.
 * Advertising `anime`, or `kitsu` as the only non-`tt` prefix, marks one.
 */
function prefersAnime(res: NormResource): boolean {
  const others = res.idPrefixes.map(normalizePrefix).filter((p) => p !== "" && p !== "tt");
  return hasType(res.types, "anime") || (others.length === 1 && others[0] === "kitsu");
}

/** A complete IMDb ID declared as a prefix names the one title the addon serves. */
const manifestIds: IdSource = {
  name: "manifest",
  matches: (prefixes) => prefixes.some((p) => FULL_IMDB_ID.test(p)),
  rank: () => Rank.exact,
  resolve(res) {
    const ids = res.idPrefixes.map(normalizePrefix).filter((p) => FULL_IMDB_ID.test(p));
    return Promise.all(
      ids.flatMap((id) =>
        res.types.map(async (type): Promise<TestContent> => {
          if (type.toLowerCase() === "movie") return { type, id };
          // `:1:1` is S1E1 for any IMDb series, so a Cinemeta outage can't leave the addon without a test ID.
          const episodeId = (await cinemetaStreamId(id)) ?? `${id}:1:1`;
          return { type, id, ...(episodeId !== id ? { episodeId } : {}) };
        }),
      ),
    );
  },
};

const youtube: IdSource = {
  name: "youtube",
  matches: (prefixes) => prefixes.includes("yt_id"),
  rank: () => Rank.exact,
  resolve: async (res) =>
    rotate(YOUTUBE_VIDEOS, cycle.rotation).flatMap((v) =>
      res.types.map((type) => ({ type, id: `yt_id:${v}` })),
    ),
};

const wellKnown: IdSource = {
  name: "well-known",
  matches: (prefixes) => prefixes.includes("tt"),
  rank: (res) => (prefersAnime(res) ? Rank.fallback : Rank.best),
  resolve: async () => rotateByType(WELL_KNOWN),
};

const cinemeta: IdSource = {
  name: "cinemeta",
  matches: (prefixes) => prefixes.includes("tt"),
  rank: (res) => (prefersAnime(res) ? Rank.fallback : Rank.best),
  resolve: () => cinemetaTop(),
};

const kitsu: IdSource = {
  name: "kitsu",
  matches: (prefixes) => prefixes.includes("kitsu"),
  rank: (res) => (prefersAnime(res) ? Rank.best : Rank.good),
  resolve: async () => (await animeTitles()).map((t) => t.kitsu),
};

const kitsuImdb: IdSource = {
  name: "kitsu imdb",
  matches: (prefixes) => prefixes.includes("tt"),
  rank: (res) => (prefersAnime(res) ? Rank.good : Rank.last),
  resolve: async () => (await animeTitles()).flatMap((t) => (t.imdb ? [t.imdb] : [])),
};

const SOURCES: IdSource[] = [manifestIds, youtube, wellKnown, cinemeta, kitsu, kitsuImdb];

/** A resource without prefixes is sent every ID, so it gets the ones Stremio's own Cinemeta and Kitsu catalogs produce. */
const ANY_ID_PREFIXES = ["tt", "kitsu"];

function matchingSources(idPrefixes: readonly string[]): IdSource[] {
  const declared = idPrefixes.map(normalizePrefix).filter((p) => p !== "");
  const wanted = declared.length > 0 ? declared : ANY_ID_PREFIXES;
  return SOURCES.filter((s) => s.matches(wanted));
}

/** True if any registered source can supply IDs for these prefixes. */
export function hasSourceFor(idPrefixes: readonly string[]): boolean {
  return matchingSources(idPrefixes).length > 0;
}

interface Ranked {
  rank: number;
  content: TestContent;
}

/**
 * Every matching source's IDs, best fit first and without duplicates; sources sharing a rank take turns within each type.
 * Each ID takes the resource's spelling of its type and is dropped where the resource wouldn't accept it.
 */
async function rankedFor(res: NormResource): Promise<Ranked[]> {
  const lists = await Promise.all(
    matchingSources(res.idPrefixes).map(async (source) => {
      const contents = await source.resolve(res).catch((e: unknown): TestContent[] => {
        logger.debug({ step: "idsource", source: source.name, err: errMsg(e) }, "ID source failed");
        return [];
      });
      const items = contents.flatMap((c): TestContent[] => {
        const type = res.types.find((t) => t.toLowerCase() === c.type.toLowerCase());
        if (type === undefined || !resourceAccepts(res, type, c.episodeId ?? c.id)) return [];
        return [{ ...c, type, source: source.name }];
      });
      return { rank: source.rank(res), items };
    }),
  );
  const ranks = [...new Set(lists.map((l) => l.rank))].sort((a, b) => a - b);
  const ordered = ranks.flatMap((rank) => {
    const group = lists.filter((l) => l.rank === rank);
    const types = [...new Set(group.flatMap((l) => l.items.map((c) => c.type)))];
    return types.flatMap((type) =>
      interleave(group.map((l) => l.items.filter((c) => c.type === type))).map((content) => ({
        rank,
        content,
      })),
    );
  });
  const seen = new Set<string>();
  return ordered.filter(({ content }) => {
    const key = `${content.type}\n${content.episodeId ?? content.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Ordered test IDs for a stream or subtitles resource, best fit first, from every source whose prefixes and types the resource accepts.
 * Callers try them in order and stop at the first that yields content, so later entries cost nothing for a healthy addon.
 * Types take turns, the best-fitting first, so each advertised type gets an early candidate.
 */
export async function candidatesFor(res: NormResource): Promise<TestContent[]> {
  if (!hasSourceFor(res.idPrefixes)) return [];
  const queues = new Map<string, Ranked[]>();
  const perSource = new Map<string, number>();
  for (const r of await rankedFor(res)) {
    const queue = queues.get(r.content.type) ?? [];
    const sourceKey = `${r.content.type}\n${r.content.source}`;
    const fromSource = perSource.get(sourceKey) ?? 0;
    if (queue.length >= PER_TYPE || fromSource >= PER_SOURCE_PER_TYPE) continue;
    perSource.set(sourceKey, fromSource + 1);
    queue.push(r);
    queues.set(r.content.type, queue);
  }
  const byFit = [...queues.entries()].sort(
    ([typeA, a], [typeB, b]) =>
      a[0].rank - b[0].rank || res.types.indexOf(typeA) - res.types.indexOf(typeB),
  );
  return interleave(byFit.map(([, queue]) => queue.map((r) => r.content)));
}
