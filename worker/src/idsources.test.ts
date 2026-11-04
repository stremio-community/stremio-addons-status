import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NormResource } from "./manifest.js";

const responses = new Map<string, unknown>();
const getJson = vi.fn(async (url: string) => {
  if (!responses.has(url)) return { status: 404, data: undefined, attempts: [] };
  const data = responses.get(url);
  if (data instanceof Error) throw data;
  return { status: 200, data, attempts: [] };
});
vi.mock("./http.js", () => ({ getJson: (url: string) => getJson(url) }));

const { candidatesFor, hasSourceFor, resetCycle } = await import("./idsources.js");
const { config } = await import("./config.js");

const CINEMETA = "https://v3-cinemeta.strem.io";
const KITSU = "https://anime-kitsu.strem.fun";
/** A cycle in 2026 whose number every curated list's length divides, so each list starts at its head. */
const HEAD = (() => {
  const slot = Math.floor(Date.UTC(2026, 10, 4) / config.probeInterval);
  return (slot - (slot % 20)) * config.probeInterval;
})();

const res = (types: string[], idPrefixes: string[]): NormResource => ({
  name: "stream",
  types,
  idPrefixes,
});

/** Real Anime Kitsu shapes: catalog metas are `series`/`movie`, videos map to IMDb seasons and episodes. */
function kitsuMeta(id: string, imdb: string, type = "series") {
  return type === "movie"
    ? {
        meta: {
          id,
          type,
          imdb_id: imdb,
          behaviorHints: { defaultVideoId: id },
          videos: [{ id, season: 1, episode: 1, imdb_id: imdb, imdbSeason: 1, imdbEpisode: 1 }],
        },
      }
    : {
        meta: {
          id,
          type,
          imdb_id: imdb,
          videos: [1, 2].map((e) => ({
            id: `${id}:${e}`,
            season: 1,
            episode: e,
            imdb_id: imdb,
            imdbSeason: 1,
            imdbEpisode: e,
          })),
        },
      };
}

function seedSources(): void {
  responses.set(`${CINEMETA}/catalog/movie/top.json`, {
    metas: [
      { id: "tt37287335", imdb_id: "tt37287335", type: "movie", releaseInfo: "2026" },
      { id: "tt0107120", imdb_id: "tt0107120", type: "movie", releaseInfo: "1993" },
      { id: "tt32261958", type: "movie", releaseInfo: "2026" },
      { id: "tt0077651", type: "movie", releaseInfo: "1978" },
      { id: "tt0107688", type: "movie", releaseInfo: "1993" },
    ],
  });
  responses.set(`${CINEMETA}/catalog/series/top.json`, {
    metas: [
      { id: "tt26598805", type: "series", releaseInfo: "2026–" },
      { id: "tt33043892", type: "series", releaseInfo: "2025–" },
      { id: "tt31510819", type: "series", releaseInfo: "2025–" },
    ],
  });
  responses.set(`${CINEMETA}/meta/series/tt33043892.json`, {
    meta: {
      id: "tt33043892",
      videos: [
        { id: "tt33043892:0:1", season: 0, episode: 1 },
        { id: "tt33043892:1:1", season: 1, episode: 1 },
      ],
    },
  });
  responses.set(`${CINEMETA}/meta/series/tt31510819.json`, {
    meta: { id: "tt31510819", videos: [{ id: "tt31510819:1:1", season: 1, episode: 1 }] },
  });
  responses.set(`${KITSU}/catalog/anime/kitsu-anime-trending.json`, {
    metas: [
      { id: "kitsu:7442", type: "series", imdb_id: "tt2560140", releaseInfo: "2013" },
      { id: "kitsu:49999", type: "series", releaseInfo: "2026" },
      { id: "kitsu:12", type: "series", imdb_id: "tt0388629", releaseInfo: "1999-" },
    ],
  });
  responses.set(`${KITSU}/meta/series/kitsu:7442.json`, kitsuMeta("kitsu:7442", "tt2560140"));
  responses.set(`${KITSU}/meta/series/kitsu:1376.json`, kitsuMeta("kitsu:1376", "tt0877057"));
  responses.set(`${KITSU}/meta/series/kitsu:3936.json`, kitsuMeta("kitsu:3936", "tt1355642"));
  responses.set(`${KITSU}/meta/series/kitsu:10740.json`, kitsuMeta("kitsu:10740", "tt4508902"));
  responses.set(`${KITSU}/meta/series/kitsu:12.json`, kitsuMeta("kitsu:12", "tt0388629"));
  responses.set(`${KITSU}/meta/movie/kitsu:176.json`, kitsuMeta("kitsu:176", "tt0245429", "movie"));
}

const ids = (cs: Array<{ type: string; id: string; episodeId?: string }>) =>
  cs.map((c) => `${c.type} ${c.episodeId ?? c.id}`);

beforeEach(() => {
  responses.clear();
  getJson.mockClear();
  seedSources();
  resetCycle(HEAD);
});

describe("candidatesFor", () => {
  it("leads a tt scraper with well-known titles, mixes in Cinemeta's older top titles, and alternates types", async () => {
    const cs = await candidatesFor(res(["movie", "series"], ["tt"]));
    expect(ids(cs)).toEqual([
      "movie tt0111161",
      "series tt0944947:1:1",
      "movie tt0107120",
      "series tt33043892:1:1",
      "movie tt1375666",
      "series tt0903747:1:1",
      "movie tt0077651",
      "series tt31510819:1:1",
    ]);
    expect(cs[0].source).toBe("well-known");
    expect(cs[2].source).toBe("cinemeta");
  });

  it("never offers a current-year Cinemeta release", async () => {
    const cs = await candidatesFor(res(["movie", "series"], ["tt"]));
    expect(cs.map((c) => c.id)).not.toContain("tt37287335");
    expect(cs.map((c) => c.id)).not.toContain("tt26598805");
  });

  it("rotates the well-known titles deterministically per cycle", async () => {
    const first = async () => (await candidatesFor(res(["movie"], ["tt"])))[0].id;
    expect(await first()).toBe("tt0111161");
    resetCycle(HEAD + 60_000);
    expect(await first()).toBe("tt0111161");
    resetCycle(HEAD + config.probeInterval);
    expect(await first()).toBe("tt1375666");
    resetCycle(HEAD + 2 * config.probeInterval);
    expect(await first()).toBe("tt0468569");
    resetCycle(HEAD);
    expect(await first()).toBe("tt0111161");
  });

  it("tries Kitsu first for an anime addon that also accepts tt, then the same episodes as IMDb IDs", async () => {
    // LTAN - ANIME's stream resource.
    const cs = await candidatesFor(res(["anime", "series"], ["kitsu", "tt"]));
    expect(ids(cs)).toEqual([
      "series kitsu:7442:1",
      "series kitsu:1376:1",
      "series tt2560140:1:1",
      "series tt0877057:1:1",
    ]);
    expect(cs.map((c) => c.source)).toEqual(["kitsu", "kitsu", "kitsu imdb", "kitsu imdb"]);
  });

  it("orders Kitsu first when kitsu is the only non-tt prefix, even without the anime type", async () => {
    const cs = await candidatesFor(res(["series"], ["tt", "kitsu:"]));
    expect(cs[0]).toMatchObject({ type: "series", episodeId: "kitsu:7442:1", source: "kitsu" });
  });

  it("resolves from every matching source, with live action after Kitsu for a broad anime addon", async () => {
    // PleiadesStream: movie, series and anime over tt, kitsu and tmdb.
    const cs = await candidatesFor(res(["movie", "series", "anime"], ["tt", "kitsu", "tmdb"]));
    expect(ids(cs)).toEqual([
      "movie kitsu:176",
      "series kitsu:7442:1",
      "movie tt0245429",
      "series kitsu:1376:1",
      "movie tt0111161",
      "series tt2560140:1:1",
      "movie tt0107120",
      "series tt0877057:1:1",
    ]);
    expect(new Set(cs.map((c) => c.source))).toEqual(
      new Set(["kitsu", "kitsu imdb", "well-known", "cinemeta"]),
    );
  });

  it("tests a tt-only anime addon with anime through Kitsu's IMDb mapping", async () => {
    const cs = await candidatesFor(res(["series", "anime"], ["tt"]));
    expect(ids(cs).slice(0, 2)).toEqual(["series tt2560140:1:1", "series tt0877057:1:1"]);
    expect(cs[2].source).toBe("well-known");
  });

  it("keeps Kitsu after live action for an addon that isn't anime-first", async () => {
    const cs = await candidatesFor(res(["series"], ["tt", "kitsu", "tmdb"]));
    expect(cs.slice(0, 4).map((c) => c.source)).toEqual([
      "well-known",
      "cinemeta",
      "well-known",
      "cinemeta",
    ]);
  });

  it("offers Kitsu IDs to a kitsu-only addon", async () => {
    const cs = await candidatesFor(res(["series", "movie"], ["kitsu"]));
    expect(ids(cs)).toEqual(["series kitsu:7442:1", "movie kitsu:176", "series kitsu:1376:1"]);
  });

  it("uses a complete IMDb ID declared as a prefix, with its first regular episode from Cinemeta", async () => {
    // Still: A Minecraft Series.
    responses.set(`${CINEMETA}/meta/series/tt38813105.json`, {
      meta: {
        id: "tt38813105",
        videos: [
          { id: "tt38813105:1:0", season: 1, number: 0 },
          { id: "tt38813105:1:1", season: 1, number: 1 },
        ],
      },
    });
    const cs = await candidatesFor(res(["series"], ["tt38813105"]));
    expect(cs).toEqual([
      { type: "series", id: "tt38813105", episodeId: "tt38813105:1:0", source: "manifest" },
    ]);
    expect(hasSourceFor(["tt38813105"])).toBe(true);
  });

  it("falls back to S1E1 for a declared IMDb series when Cinemeta has no meta", async () => {
    const cs = await candidatesFor(res(["series", "movie"], ["tt38813105"]));
    expect(ids(cs)).toEqual(["series tt38813105:1:1", "movie tt38813105"]);
  });

  it("offers fixed YouTube videos under the resource's own type", async () => {
    // YouTubio: type `YouTube`, prefix `yt_id:`.
    const cs = await candidatesFor(res(["YouTube"], ["yt_id:"]));
    expect(cs).toEqual([
      { type: "YouTube", id: "yt_id:dQw4w9WgXcQ", source: "youtube" },
      { type: "YouTube", id: "yt_id:jNQXAC9IVRw", source: "youtube" },
    ]);
    expect(getJson).not.toHaveBeenCalled();
  });

  it("matches types case-insensitively and returns the resource's spelling", async () => {
    const cs = await candidatesFor(res(["Movie"], ["tt"]));
    expect(cs[0]).toMatchObject({ type: "Movie", id: "tt0111161" });
    expect(cs.every((c) => c.type === "Movie")).toBe(true);
  });

  it("drops IDs the resource's prefixes don't accept", async () => {
    const cs = await candidatesFor(res(["series"], ["tt0944947"]));
    expect(cs.every((c) => c.id === "tt0944947")).toBe(true);
  });

  it("borrows IMDb and Kitsu IDs for a resource without prefixes, which accepts every ID", async () => {
    const cs = await candidatesFor(res(["movie", "series"], []));
    expect(cs.some((c) => c.type === "movie" && c.id.startsWith("tt"))).toBe(true);
    expect(cs.some((c) => c.type === "series" && (c.episodeId ?? c.id).startsWith("tt"))).toBe(true);
    expect((await candidatesFor(res(["movie"], [""]))).length).toBeGreaterThan(0);
    expect(hasSourceFor([])).toBe(true);
    expect(hasSourceFor([""])).toBe(true);
  });

  it("has no source for a prefix none supplies", () => {
    expect(hasSourceFor(["tmdb:"])).toBe(false);
  });

  it("degrades to the curated titles when Cinemeta and Kitsu are down", async () => {
    responses.clear();
    responses.set(`${CINEMETA}/catalog/movie/top.json`, new Error("fetch failed"));
    const cs = await candidatesFor(res(["movie", "series"], ["tt", "kitsu"]));
    expect(cs.length).toBeGreaterThan(0);
    expect(new Set(cs.map((c) => c.source))).toEqual(new Set(["well-known"]));
  });

  it("fetches each source once per cycle, not once per addon", async () => {
    await candidatesFor(res(["movie", "series"], ["tt", "kitsu"]));
    const calls = getJson.mock.calls.length;
    await candidatesFor(res(["movie", "series", "anime"], ["tt", "kitsu"]));
    await candidatesFor(res(["series"], ["tt"]));
    expect(getJson.mock.calls.length).toBe(calls);
    resetCycle(HEAD + config.probeInterval);
    await candidatesFor(res(["series"], ["tt"]));
    expect(getJson.mock.calls.length).toBeGreaterThan(calls);
  });
});
