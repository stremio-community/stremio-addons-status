import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import type { Manifest } from "@stremio-addon/sdk";
import type { NormalizedAddon } from "./types.js";
import type { TestContent } from "./idsources.js";
import type { Attempt, GetJsonOptions, ParseError, Route } from "./http.js";
import type { NormResource } from "./manifest.js";
import type { LinkPage, UrlCheck, UrlToCheck } from "./urlcheck.js";

// --- mocks -----------------------------------------------------------------

type RouteResult = {
  status: number;
  data: unknown;
  parseError?: ParseError;
  redirect?: string;
  /** Replaces the single direct attempt the mock reports by default. */
  attempts?: Attempt[];
  softBlockedOn?: Route;
  allowOrigin?: string;
};
let router: (url: string, options: GetJsonOptions<unknown>) => RouteResult | Promise<RouteResult>;
/** The options of every getJson call, by URL. */
const requestOptions = new Map<string, GetJsonOptions<unknown>>();

const idsourcesMock = {
  hasSourceFor: (_prefixes: readonly string[]) => false,
  candidatesFor: async (_res: NormResource): Promise<TestContent[]> => [],
};

/** Subtitle files by URL; any other file is unreachable. */
const subtitleFiles = new Map<string, string>();

vi.mock("./http.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http.js")>()),
  getSample: async (url: string) => {
    const { RequestFailedError } = await importOriginal<typeof import("./http.js")>();
    const body = subtitleFiles.get(url);
    if (body === undefined) throw new RequestFailedError("fetch failed", []);
    return {
      status: 200,
      bytes: new TextEncoder().encode(body),
      attempts: [{ route: "direct", status: 200, durationMs: 1 }],
    };
  },
  getJson: async (url: string, _timeout: number, options: GetJsonOptions<unknown> = {}) => {
    requestOptions.set(url, options);
    const { redirect, attempts, ...res } = await router(url, options);
    return {
      ...res,
      attempts: attempts ?? [
        { route: "direct", status: res.status, durationMs: 1, ...(redirect ? { redirect } : {}) },
      ],
    };
  },
}));

const PLAYS = (u: UrlToCheck): UrlCheck => ({
  host: new URL(u.url).hostname,
  verdict: "playable",
  outcome: "HTTP 206 video/mp4",
});
const urlcheckMock = {
  checkUrl: async (u: UrlToCheck): Promise<UrlCheck> => PLAYS(u),
  followLink: async (url: string): Promise<LinkPage> => ({
    host: new URL(url).hostname,
    status: 200,
  }),
};

vi.mock("./urlcheck.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./urlcheck.js")>()),
  checkUrl: (u: UrlToCheck) => urlcheckMock.checkUrl(u),
  followLink: (url: string) => urlcheckMock.followLink(url),
}));

vi.mock("./idsources.js", () => ({
  resetCycle: () => {},
  hasSourceFor: (p: readonly string[]) => idsourcesMock.hasSourceFor(p),
  candidatesFor: (res: NormResource) => idsourcesMock.candidatesFor(res),
}));

// Import after mocks are registered.
const { probe, forgetRememberedTargets } = await import("./probe.js");
const { OVERRIDES } = await import("./overrides.js");
const { RequestFailedError } = await import("./http.js");
const overrides = OVERRIDES as Record<string, import("./overrides.js").AddonOverride>;

// --- helpers ---------------------------------------------------------------

const BASE = "https://addon.test";

// Returns the addon plus the manifest the /manifest.json route should serve.
function addon(manifest: Partial<Manifest>): NormalizedAddon & { manifest: Manifest } {
  const m = {
    id: "x",
    name: "Test Addon",
    description: "",
    version: "1.0.0",
    types: [],
    catalogs: [],
    resources: [],
    ...manifest,
  } as Manifest;
  return {
    uuid: "u",
    slug: "test-addon",
    name: m.name,
    manifestUrl: `${BASE}/manifest.json`,
    baseUrl: BASE,
    stars: 0,
    categories: ["movies"],
    manifest: m,
  };
}

const PLAYABLE = { url: "http://cdn.test/file.mp4", title: "1080p" };
// Real streams differ per title; one identical for unrelated titles is a placeholder.
const EPISODE = { url: "http://cdn.test/episode.mp4", title: "S01E01 1080p" };
const MORE = { url: "http://cdn.test/file-720p.mp4", title: "720p" };

function routes(map: Array<[string, RouteResult | (() => never)]>): (url: string) => RouteResult {
  return (url: string) => {
    for (const [needle, res] of map) {
      if (url.includes(needle)) {
        if (typeof res === "function") return res();
        return res;
      }
    }
    throw new Error(`no route for ${url}`);
  };
}

const manifestOk = (m: Manifest): RouteResult => ({ status: 200, data: m, allowOrigin: "*" });

/** What getJson reports for an HTML page served with HTTP 200, e.g. an unconfigured addon's landing page. */
const HTML_PAGE: RouteResult = {
  status: 200,
  data: undefined,
  parseError: {
    html: true,
    contentType: "text/html; charset=utf-8",
    title: "Not found",
    excerpt: "<!DOCTYPE html>",
  },
};

beforeEach(() => {
  subtitleFiles.clear();
  urlcheckMock.checkUrl = async (u) => PLAYS(u);
  urlcheckMock.followLink = async (url) => ({ host: new URL(url).hostname, status: 200 });
  idsourcesMock.hasSourceFor = () => false;
  idsourcesMock.candidatesFor = async () => [];
  forgetRememberedTargets();
  requestOptions.clear();
});

// --- tests -----------------------------------------------------------------

describe("probe", () => {
  it("(a) catalog-less imdb scraper probes movie and series episode; one real stream each ⇒ UP", async () => {
    const m = addon({
      types: ["movie", "series"],
      resources: [{ name: "stream", types: ["movie", "series"], idPrefixes: ["tt", "kitsu"] }],
    });
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.candidatesFor = async () => [
      { type: "movie", id: "tt1" },
      { type: "series", id: "tt2", episodeId: "tt2:1:1" },
    ];
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/stream/movie/tt1.json", { status: 200, data: { streams: [PLAYABLE] } }],
      ["/stream/series/tt2:1:1.json", { status: 200, data: { streams: [EPISODE] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.mode).toBe("content");
    expect(r.detail.streamCounts).toEqual({ total: 2, playable: 2, links: 0 });
    expect(r.message).toContain("stream: movie 1 playable of 1 · series 1 playable of 1");
  });

  it("catalog-less imdb scraper ⇒ UP when movie has a playable stream and series has none", async () => {
    const m = addon({
      types: ["movie", "series"],
      resources: [{ name: "stream", types: ["movie", "series"], idPrefixes: ["tt"] }],
    });
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.candidatesFor = async () => [
      { type: "movie", id: "tt1" },
      { type: "series", id: "tt2", episodeId: "tt2:1:1" },
    ];
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/stream/movie/tt1.json", { status: 200, data: { streams: [PLAYABLE, MORE] } }],
      ["/stream/series/tt2:1:1.json", { status: 200, data: { streams: [{ name: "junk" }] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.message).toContain("movie 2 playable of 2");
    expect(r.message).toContain("series 0 playable of 1");
  });

  it("one target with content passes even when the other answers an error status", async () => {
    const m = addon({
      types: ["movie", "series"],
      resources: [{ name: "stream", types: ["movie", "series"], idPrefixes: ["tt"] }],
    });
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.candidatesFor = async () => [
      { type: "movie", id: "tt1" },
      { type: "series", id: "tt2", episodeId: "tt2:1:1" },
    ];
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/stream/movie/tt1.json", { status: 200, data: { streams: [PLAYABLE] } }],
      ["/stream/series/tt2:1:1.json", { status: 500, data: { streams: [EPISODE] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    const stream = r.detail.perResource.find((p) => p.resource === "stream");
    expect(stream?.summary).toBe("movie 1 playable of 1 · series HTTP 500");
  });

  it("catalog-less imdb scraper ⇒ DOWN when both movie and series return no playable streams", async () => {
    const m = addon({
      types: ["movie", "series"],
      resources: [{ name: "stream", types: ["movie", "series"], idPrefixes: ["tt"] }],
    });
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.candidatesFor = async () => [
      { type: "movie", id: "tt1" },
      { type: "series", id: "tt2", episodeId: "tt2:1:1" },
    ];
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/stream/movie/tt1.json", { status: 200, data: { streams: [{ name: "junk" }] } }],
      ["/stream/series/tt2:1:1.json", { status: 200, data: { streams: [{}] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(false);
    expect(r.message).toContain("movie 0 playable of 1");
    expect(r.message).toContain("series 0 playable of 1");
  });

  it("catalog-less imdb scraper advertising movie+series passes on the only target it can source", async () => {
    const m = addon({
      types: ["movie", "series"],
      resources: [{ name: "stream", types: ["movie", "series"], idPrefixes: ["tt"] }],
    });
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.candidatesFor = async () => [{ type: "movie", id: "tt1" }];
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/stream/movie/tt1.json", { status: 200, data: { streams: [PLAYABLE] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.streamCounts).toEqual({ total: 1, playable: 1, links: 0 });
    expect(r.message).toContain("movie 1 playable of 1");
    expect(r.message).toContain("series no test ID source");
  });

  it("catalog-less imdb scraper advertising movie+series falls back to S1E1 when series lacks an episode ID", async () => {
    const m = addon({
      types: ["movie", "series"],
      resources: [{ name: "stream", types: ["movie", "series"], idPrefixes: ["tt"] }],
    });
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.candidatesFor = async () => [
      { type: "movie", id: "tt1" },
      { type: "series", id: "tt2" },
    ];
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/stream/movie/tt1.json", { status: 200, data: { streams: [PLAYABLE] } }],
      [
        "/meta/series/tt2.json",
        { status: 200, data: { meta: { id: "tt2", type: "series", name: "T" } } },
      ],
      ["/stream/series/tt2:1:1.json", { status: 200, data: { streams: [EPISODE] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.message).toContain("movie 1 playable of 1");
    expect(r.message).toContain("series 1 playable of 1");
  });

  it("catalog-less non-imdb scraper advertising movie+series passes on movie when series lacks an episode ID", async () => {
    const m = addon({
      types: ["movie", "series"],
      resources: [{ name: "stream", types: ["movie", "series"], idPrefixes: ["custom"] }],
    });
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.candidatesFor = async () => [
      { type: "movie", id: "custom-movie" },
      { type: "series", id: "custom-series" },
    ];
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/stream/movie/custom-movie.json", { status: 200, data: { streams: [PLAYABLE] } }],
      [
        "/meta/series/custom-series.json",
        { status: 200, data: { meta: { id: "custom-series", type: "series", name: "T" } } },
      ],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.message).toContain("movie 1 playable of 1");
    expect(r.message).toContain("series no episode ID");
  });

  it("streams a series whose meta has no videos under its own ID, fetching that meta once (DEL KDRAMA)", async () => {
    const m = addon({
      types: ["series"],
      resources: [
        { name: "stream", types: ["series"], idPrefixes: ["tmdb:"] },
        { name: "meta", types: ["series"], idPrefixes: ["tmdb:"] },
      ],
    });
    idsourcesMock.candidatesFor = async () => [{ type: "series", id: "tmdb:307478" }];
    let metaCalls = 0;
    const metaNoVideos = {
      status: 200,
      data: { meta: { id: "tmdb:307478", type: "series", name: "Pro Bono" } },
    };
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/meta/series/tmdb:307478.json",
        () => {
          metaCalls++;
          return metaNoVideos as never;
        },
      ],
      ["/stream/series/tmdb:307478.json", { status: 200, data: { streams: [EPISODE] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.message).toContain("stream: series 1 playable of 1");
    expect(r.detail.perResource.find((x) => x.resource === "meta")).toMatchObject({
      ok: false,
      summary: "no videos",
    });
    expect(metaCalls).toBe(1);
  });

  it("(b) catalog-less kitsu scraper uses a borrowed anime candidate as a single stream target", async () => {
    const m = addon({
      types: ["anime"],
      resources: [{ name: "stream", types: ["anime"], idPrefixes: ["kitsu"] }],
    });
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.candidatesFor = async () => [
      { type: "anime", id: "kitsu:1", episodeId: "kitsu:1:1:1" },
    ];
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/stream/anime/kitsu:1:1:1.json", { status: 200, data: { streams: [PLAYABLE] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.mode).toBe("content");
    expect(r.detail.streamCounts).toEqual({ total: 1, playable: 1, links: 0 });
    expect(r.message).toContain("stream: anime 1 playable of 1");
  });

  it("mixed-type scraper falls back to a sourceable anime candidate as a single target", async () => {
    const m = addon({
      types: ["movie", "series", "anime"],
      resources: [{ name: "stream", types: ["movie", "series", "anime"], idPrefixes: ["kitsu"] }],
    });
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.candidatesFor = async () => [
      { type: "anime", id: "kitsu:1", episodeId: "kitsu:1:1:1" },
    ];
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/stream/anime/kitsu:1:1:1.json", { status: 200, data: { streams: [PLAYABLE] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.mode).toBe("content");
    expect(r.detail.streamCounts).toEqual({ total: 1, playable: 1, links: 0 });
    expect(r.message).toContain("stream: anime 1 playable of 1");
    expect(r.message).not.toContain("no test ID source");
  });

  it("(c) self-contained addon with own catalog -> test ID from its catalog, stream+meta validated", async () => {
    const m = addon({
      types: ["movie"],
      resources: ["catalog", "meta", "stream"],
      catalogs: [{ type: "movie", id: "top", name: "Top" }],
    });
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/movie/top.json",
        { status: 200, data: { metas: [{ id: "x1", type: "movie", name: "X" }] } },
      ],
      [
        "/meta/movie/x1.json",
        { status: 200, data: { meta: { id: "x1", type: "movie", name: "X" } } },
      ],
      ["/stream/movie/x1.json", { status: 200, data: { streams: [PLAYABLE] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.perResource.map((p) => p.resource).sort()).toEqual([
      "catalog",
      "meta",
      "stream",
    ]);
    expect(r.detail.perResource.every((p) => p.ok)).toBe(true);
    expect(idsourcesMock.hasSourceFor).toBeDefined(); // external source not required
  });

  it("self-contained anime stream addon deep-checks its own non-movie catalog target", async () => {
    const m = addon({
      types: ["anime"],
      resources: ["catalog", { name: "stream", types: ["anime"] }],
      catalogs: [{ type: "anime", id: "top", name: "Top" }],
    });
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/anime/top.json",
        { status: 200, data: { metas: [{ id: "kitsu:1", type: "anime", name: "A" }] } },
      ],
      ["/stream/anime/kitsu:1.json", { status: 500, data: { streams: [] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(false);
    expect(r.detail.mode).toBe("content");
    expect(r.error).toBe("stream");
    expect(r.message).toContain("catalog: 1 metas");
  });

  it("borrows for advertised movie and series even when its own catalog only covers another type (StreamViX)", async () => {
    const m = addon({
      types: ["movie", "series", "tv"],
      resources: [
        "catalog",
        { name: "stream", types: ["movie", "series", "tv"], idPrefixes: ["tt", "tv:"] },
      ],
      catalogs: [{ type: "tv", id: "streamvix_tv", name: "TV" }],
    });
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.candidatesFor = async () => [
      { type: "movie", id: "tt1", source: "cinemeta" },
      { type: "series", id: "tt2", episodeId: "tt2:1:1", source: "cinemeta" },
    ];
    const trailer = {
      name: "StreamViX",
      title: "Trailer",
      ytId: "a1",
      behaviorHints: { bingeGroup: "trailer" },
    };
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/tv/streamvix_tv.json",
        { status: 200, data: { metas: [{ id: "tv:rai1", type: "tv", name: "Rai 1" }] } },
      ],
      ["/stream/tv/tv:rai1.json", { status: 200, data: { streams: [PLAYABLE] } }],
      ["/stream/movie/tt1.json", { status: 200, data: { streams: [trailer] } }],
      ["/stream/series/tt2:1:1.json", { status: 200, data: { streams: [] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    const stream = r.detail.perResource.find((p) => p.resource === "stream");
    expect(stream?.summary).toBe(
      "movie 0 playable, 1 link of 1 · series no streams · tv 1 playable of 1",
    );
  });

  it("does not borrow IDs when own catalogs already cover movie and series stream targets", async () => {
    const m = addon({
      types: ["movie", "series"],
      resources: ["catalog", { name: "stream", types: ["movie", "series"], idPrefixes: ["tt"] }],
      catalogs: [
        { type: "movie", id: "top-movie", name: "Top Movies" },
        { type: "series", id: "top-series", name: "Top Series" },
      ],
    });
    const resolve = vi.fn(async (): Promise<TestContent[]> => {
      throw new Error("unexpected external ID lookup");
    });
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.candidatesFor = resolve;
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/movie/top-movie.json",
        { status: 200, data: { metas: [{ id: "tt1", type: "movie", name: "M" }] } },
      ],
      [
        "/catalog/series/top-series.json",
        { status: 200, data: { metas: [{ id: "tt2", type: "series", name: "S" }] } },
      ],
      ["/stream/movie/tt1.json", { status: 200, data: { streams: [PLAYABLE, MORE] } }],
      ["/stream/series/tt2:1:1.json", { status: 200, data: { streams: [EPISODE] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("doesn't borrow a type its own catalogs show it doesn't carry (CineTorrent)", async () => {
    const m = addon({
      types: ["movie", "series"],
      resources: [{ name: "stream", types: ["movie", "series"], idPrefixes: ["tt"] }],
      catalogs: [{ type: "movie", id: "top_movies", name: "Top Movies" }],
    });
    const candidates = vi.fn(async (): Promise<TestContent[]> => [
      { type: "movie", id: "tt-borrowed" },
      { type: "series", id: "tt2", episodeId: "tt2:1:1" },
    ]);
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.candidatesFor = candidates;
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/movie/top_movies.json",
        { status: 200, data: { metas: [{ id: "tt1", type: "movie", name: "M" }] } },
      ],
      ["/stream/movie/tt1.json", { status: 200, data: { streams: [PLAYABLE] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    const stream = r.detail.perResource.find((p) => p.resource === "stream");
    expect(stream?.summary).toBe("movie 1 playable of 1 · series not in own catalogs");
    expect(stream?.details).toContainEqual({
      label: "Skipped",
      value: "series: the addon's own catalogs list other types only",
    });
    expect(candidates).not.toHaveBeenCalled();
  });

  it("dual-target stream fetch that throws counts as that target failing, not the addon", async () => {
    const m = addon({
      types: ["movie", "series"],
      resources: [{ name: "stream", types: ["movie", "series"], idPrefixes: ["tt"] }],
    });
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.candidatesFor = async () => [
      { type: "movie", id: "tt1" },
      { type: "series", id: "tt2", episodeId: "tt2:1:1" },
    ];
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/stream/movie/tt1.json", { status: 200, data: { streams: [PLAYABLE] } }],
      [
        "/stream/series/tt2:1:1.json",
        () => {
          throw new Error("socket hang up");
        },
      ],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    const stream = r.detail.perResource.find((p) => p.resource === "stream");
    expect(stream?.summary).toBe("movie 1 playable of 1 · series unreachable");
    expect(stream?.details).toContainEqual({ label: "Reason", value: "socket hang up" });
  });

  it("catalog annotation reports failed catalog probes even when another target is sourced", async () => {
    const m = addon({
      types: ["movie", "series"],
      resources: ["catalog", { name: "stream", types: ["movie", "series"] }],
      catalogs: [
        { type: "movie", id: "top-movie", name: "Top Movies" },
        { type: "series", id: "top-series", name: "Top Series" },
      ],
    });
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/catalog/movie/top-movie.json", { status: 500, data: {} }],
      [
        "/catalog/series/top-series.json",
        { status: 200, data: { metas: [{ id: "tt2", type: "series", name: "S" }] } },
      ],
      ["/stream/series/tt2:1:1.json", { status: 200, data: { streams: [EPISODE] } }],
    ]);
    const r = await probe(m);
    const catalog = r.detail.perResource.find((p) => p.resource === "catalog");
    expect(r.success).toBe(true);
    expect(catalog?.ok).toBe(false);
    expect(catalog?.summary).toBe("movie HTTP 500 · series 1 metas");
    expect(catalog?.details).toContainEqual({
      label: "Reason",
      value: "addon responded with HTTP 500",
    });
  });

  it("movie-only stream addon with one playable stream ⇒ UP", async () => {
    const m = addon({
      types: ["movie"],
      resources: [{ name: "stream", types: ["movie"], idPrefixes: ["tt"] }],
    });
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.candidatesFor = async () => [{ type: "movie", id: "tt1" }];
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/stream/movie/tt1.json", { status: 200, data: { streams: [PLAYABLE] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.streamCounts).toEqual({ total: 1, playable: 1, links: 0 });
    expect(r.message).toContain("stream: movie 1 playable of 1");
  });

  it("(d) catalog/meta-only addon -> UP via catalog path, no stream check", async () => {
    const m = addon({
      types: ["movie"],
      resources: ["catalog", "meta"],
      catalogs: [{ type: "movie", id: "top", name: "Top" }],
    });
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/movie/top.json",
        { status: 200, data: { metas: [{ id: "x1", type: "movie", name: "X" }] } },
      ],
      [
        "/meta/movie/x1.json",
        { status: 200, data: { meta: { id: "x1", type: "movie", name: "X" } } },
      ],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.mode).toBe("content");
    expect(r.detail.perResource.some((p) => p.resource === "stream")).toBe(false);
  });

  it("(e) manifest 200 but streams empty/garbage ⇒ DOWN (per-resource breakdown)", async () => {
    const m = addon({
      types: ["movie"],
      resources: [{ name: "stream", types: ["movie"], idPrefixes: ["tt"] }],
    });
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.candidatesFor = async () => [{ type: "movie", id: "tt1" }];
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/stream/movie/tt1.json", { status: 200, data: { streams: [{ name: "junk" }, {}] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(false);
    expect(r.error).toBe("stream");
    // Failure message carries the full per-resource breakdown so Gatus's tooltip shows what was probed.
    expect(r.message).toContain("stream: movie 0 playable of 2");
    expect(r.detail.live).toBe(true);
  });

  it("(f) unreachable manifest ⇒ DOWN (liveness floor)", async () => {
    const m = addon({ resources: ["stream"], types: ["movie"] });
    router = routes([
      [
        "/manifest.json",
        () => {
          throw new Error("ECONNREFUSED");
        },
      ],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(false);
    expect(r.error).toBe("manifest");
    expect(r.detail.live).toBe(false);
  });

  it("(f2) non-2xx manifest ⇒ DOWN", async () => {
    const m = addon({ resources: ["stream"], types: ["movie"] });
    router = routes([["/manifest.json", { status: 502, data: "bad gateway" }]]);
    const r = await probe(m);
    expect(r.success).toBe(false);
    expect(r.error).toBe("manifest");
  });

  it("(g) configurationRequired with reachable manifest ⇒ UP needs-config", async () => {
    const m = addon({
      resources: ["stream"],
      types: ["movie"],
      behaviorHints: { configurationRequired: true },
    });
    router = routes([["/manifest.json", manifestOk(m.manifest)]]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.mode).toBe("needs-config");
    expect(r.detail.configReason).toBe("manifest sets configurationRequired");
  });

  it("catalog-less scraper with unknown ID prefix ⇒ UP liveness-only", async () => {
    const m = addon({
      resources: [{ name: "stream", types: ["movie"], idPrefixes: ["weirdprefix"] }],
      types: ["movie"],
    });
    idsourcesMock.hasSourceFor = () => false;
    router = routes([["/manifest.json", manifestOk(m.manifest)]]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.mode).toBe("liveness-only");
  });

  it("(f3) manifest that isn't a JSON object ⇒ DOWN with that reason", async () => {
    const m = addon({ resources: ["stream"], types: ["movie"] });
    router = routes([["/manifest.json", { status: 200, data: null }]]);
    const r = await probe(m);
    expect(r.success).toBe(false);
    expect(r.detail.livenessError).toBe("unreachable (response is not a JSON object)");
    expect(r.detail.manifestDetails).toEqual([
      { label: "Request", value: "/manifest.json" },
      { label: "Attempt", value: "direct · HTTP 200 · 1ms" },
      { label: "Reason", value: "response is not a JSON object" },
    ]);
  });
});

describe("probe manifest validation", () => {
  it("rejects a redirected JSON object that isn't a Stremio manifest, naming the missing fields", async () => {
    const m = addon({ resources: ["stream"], types: ["movie"] });
    router = routes([
      [
        "/manifest.json",
        { status: 200, data: { meta: {}, payload: {} }, redirect: "plexio.stream → github.com" },
      ],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(false);
    expect(r.error).toBe("manifest");
    expect(r.detail.livenessError).toBe(
      "not a Stremio manifest (missing id, version, name, resources, types)",
    );
    expect(r.detail.manifestDetails).toEqual([
      { label: "Request", value: "/manifest.json" },
      { label: "Attempt", value: "direct · HTTP 200 · 1ms" },
      { label: "Redirect", value: "plexio.stream → github.com" },
      { label: "Reason", value: "response lacks id, version, name, resources, types" },
    ]);
  });

  it("rejects an empty JSON object", async () => {
    const m = addon({});
    router = routes([["/manifest.json", { status: 200, data: {} }]]);
    const r = await probe(m);
    expect(r.success).toBe(false);
    expect(r.message).toBe("not a Stremio manifest (missing id, version, name, resources, types)");
  });

  it("accepts a manifest without description or catalogs", async () => {
    const m = addon({});
    const { description: _d, catalogs: _c, ...bare } = m.manifest;
    router = routes([["/manifest.json", { status: 200, data: bare }]]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.skipReason).toBe("no testable resource");
  });

  it("reports an HTML manifest as an HTML page with its title", async () => {
    const m = addon({});
    router = routes([["/manifest.json", HTML_PAGE]]);
    const r = await probe(m);
    expect(r.success).toBe(false);
    expect(r.detail.livenessError).toBe("unreachable (HTML page instead of JSON)");
    expect(r.detail.manifestDetails.slice(2)).toEqual([
      { label: "Reason", value: "HTML page instead of JSON" },
      { label: "Content-Type", value: "text/html; charset=utf-8" },
      { label: "Page title", value: "Not found" },
    ]);
  });
});

describe("probe unparsable bodies", () => {
  it("reports a malformed catalog as not valid JSON, not as empty", async () => {
    const m = addon({
      types: ["series"],
      idPrefixes: ["tt38813105"],
      resources: [
        { name: "catalog", types: ["series"], idPrefixes: ["tt38813105"] },
        { name: "meta", types: ["series"], idPrefixes: ["tt38813105"] },
      ],
      catalogs: [{ type: "series", id: "seen_catalog", name: "SEEN Studio", extra: [] }],
    });
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/series/seen_catalog.json",
        {
          status: 200,
          data: undefined,
          parseError: {
            html: false,
            contentType: "application/json; charset=utf-8",
            excerpt: '{ "metas": [ { "id": "tt38813105", "type": "series", "name": "Still",',
          },
        },
      ],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(false);
    const catalog = r.detail.perResource.find((p) => p.resource === "catalog");
    expect(catalog?.summary).toBe("not valid JSON");
    expect(catalog?.details).toContainEqual({
      label: "Reason",
      value: "response is not valid JSON",
    });
    expect(catalog?.details).toContainEqual({
      label: "Content-Type",
      value: "application/json; charset=utf-8",
    });
  });

  it("reports an HTML meta answer as an HTML page", async () => {
    const m = addon({
      types: ["movie"],
      resources: ["catalog", "meta"],
      catalogs: [{ type: "movie", id: "top", name: "Top" }],
    });
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/movie/top.json",
        { status: 200, data: { metas: [{ id: "x1", type: "movie", name: "X" }] } },
      ],
      ["/meta/movie/x1.json", HTML_PAGE],
    ]);
    const r = await probe(m);
    const meta = r.detail.perResource.find((p) => p.resource === "meta");
    expect(meta?.ok).toBe(false);
    expect(meta?.summary).toBe("HTML page");
    expect(meta?.details).toContainEqual({ label: "Reason", value: "HTML page instead of JSON" });
  });

  it("reports an HTML stream answer as an HTML page, not as no streams", async () => {
    const m = addon({
      types: ["movie"],
      resources: [{ name: "stream", types: ["movie"], idPrefixes: ["tt"] }],
    });
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.candidatesFor = async () => [{ type: "movie", id: "tt1" }];
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/stream/movie/tt1.json", HTML_PAGE],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(false);
    const stream = r.detail.perResource.find((p) => p.resource === "stream");
    expect(stream?.summary).toBe("movie HTML page");
    expect(stream?.details).toContainEqual({ label: "Reason", value: "HTML page instead of JSON" });
    expect(stream?.details).toContainEqual({ label: "Page title", value: "Not found" });
  });

  it("annotates an HTML subtitles answer as an HTML page", async () => {
    const m = addon({
      types: ["movie"],
      resources: ["catalog", "subtitles"],
      catalogs: [{ type: "movie", id: "top", name: "Top" }],
    });
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/movie/top.json",
        { status: 200, data: { metas: [{ id: "x1", type: "movie", name: "X" }] } },
      ],
      ["/subtitles/movie/x1", HTML_PAGE],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    const subs = r.detail.perResource.find((p) => p.resource === "subtitles");
    expect(subs?.summary).toBe("movie HTML page");
    expect(subs?.details).toContainEqual({ label: "Page title", value: "Not found" });
  });
});

describe("probe without a test ID for the primary resource", () => {
  it("meta-primary, no catalogs, unknown prefix ⇒ liveness-only", async () => {
    const m = addon({
      types: ["other"],
      idPrefixes: ["pl_id:"],
      resources: ["catalog", "meta"],
      catalogs: [],
      behaviorHints: { configurable: true },
    });
    router = routes([["/manifest.json", manifestOk(m.manifest)]]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.mode).toBe("liveness-only");
    expect(r.detail.skipReason).toBe("no test ID for meta");
  });

  it("catalog-primary whose every catalog needs an input the worker can't give ⇒ liveness-only", async () => {
    const m = addon({
      types: ["movie"],
      resources: ["catalog"],
      catalogs: [
        {
          type: "movie",
          id: "by-user",
          name: "By user",
          extra: [{ name: "user", isRequired: true }],
        },
      ],
    });
    router = routes([["/manifest.json", manifestOk(m.manifest)]]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.mode).toBe("liveness-only");
    expect(r.detail.skipReason).toBe("no testable catalog");
  });
});

describe("probe detail rows", () => {
  it("lists each stream request with its borrowed test ID, routes tried and failure reason", async () => {
    const m = addon({
      types: ["movie", "series"],
      resources: [{ name: "stream", types: ["movie", "series"], idPrefixes: ["tt"] }],
    });
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.candidatesFor = async () => [
      { type: "movie", id: "tt1", source: "cinemeta" },
      { type: "series", id: "tt2", episodeId: "tt2:1:1", source: "cinemeta" },
    ];
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/stream/movie/tt1.json", { status: 200, data: { streams: [{ title: "no source" }] } }],
      ["/stream/series/tt2:1:1.json", { status: 200, data: { streams: [] } }],
    ]);
    const r = await probe(m);
    const stream = r.detail.perResource.find((p) => p.resource === "stream");
    expect(stream?.summary).toBe("movie 0 playable of 1 · series no streams");
    expect(stream?.details).toEqual([
      { label: "Request", value: "/stream/movie/tt1.json" },
      { label: "Test ID", value: "tt1 (cinemeta)" },
      { label: "Attempt", value: "direct · HTTP 200 · 1ms" },
      { label: "Reason", value: "none of 1 streams has a playable source" },
      { label: "Request", value: "/stream/series/tt2:1:1.json" },
      { label: "Test ID", value: "tt2:1:1 (cinemeta)" },
      { label: "Attempt", value: "direct · HTTP 200 · 1ms" },
      { label: "Reason", value: "returned no streams" },
    ]);
    expect(r.detail.manifestDetails).toEqual([
      { label: "Request", value: "/manifest.json" },
      { label: "Attempt", value: "direct · HTTP 200 · 1ms" },
    ]);
  });

  it("names the fields a meta response is missing and marks own-catalog test IDs", async () => {
    const m = addon({
      types: ["movie"],
      resources: ["catalog", "meta"],
      catalogs: [{ type: "movie", id: "top", name: "Top" }],
    });
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/movie/top.json",
        { status: 200, data: { metas: [{ id: "m1", type: "movie", name: "M" }] } },
      ],
      ["/meta/movie/m1.json", { status: 200, data: { meta: { id: "m1", name: "M" } } }],
    ]);
    const r = await probe(m);
    const meta = r.detail.perResource.find((p) => p.resource === "meta");
    expect(meta?.summary).toBe("invalid");
    expect(meta?.details).toEqual([
      { label: "Request", value: "/meta/movie/m1.json" },
      { label: "Test ID", value: "m1 (own catalog)" },
      { label: "Attempt", value: "direct · HTTP 200 · 1ms" },
      { label: "Reason", value: "meta missing type" },
    ]);
  });

  it("says a meta came back without its wrapper (Nickelodeon)", async () => {
    const m = addon({
      types: ["movie"],
      idPrefixes: ["tmdb"],
      resources: ["catalog", "meta"],
      catalogs: [{ type: "movie", id: "nickelodeon_movies", name: "Nickelodeon" }],
    });
    const preview = { id: "tmdb:980431", type: "movie", name: "Avatar Aang: The Last Airbender" };
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/catalog/movie/nickelodeon_movies.json", { status: 200, data: { metas: [preview] } }],
      ["/meta/movie/tmdb:980431.json", { status: 200, data: { ...preview, genres: ["Kids"] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    const meta = r.detail.perResource.find((p) => p.resource === "meta");
    expect(meta).toMatchObject({ ok: false, summary: "invalid (meta not wrapped)" });
    expect(meta?.details).toContainEqual({
      label: "Reason",
      value: 'meta returned without the {"meta": …} wrapper',
    });
  });

  it("flags a stub meta for another ID without failing the catalog addon (Holiday Movies & Shows)", async () => {
    const m = addon({
      types: ["movie"],
      idPrefixes: ["tmdb"],
      resources: ["catalog", "meta"],
      catalogs: [{ type: "movie", id: "holiday_movies", name: "Holiday Movies" }],
    });
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/movie/holiday_movies.json",
        {
          status: 200,
          data: { metas: [{ id: "tmdb:1273221", type: "movie", name: "Scary Movie" }] },
        },
      ],
      [
        "/meta/movie/tmdb:1273221.json",
        {
          status: 200,
          data: {
            meta: {
              id: "tmdb:1273221.json",
              type: "movie",
              name: "Loading...",
              posterShape: "poster",
            },
          },
        },
      ],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    const meta = r.detail.perResource.find((p) => p.resource === "meta");
    expect(meta).toMatchObject({ ok: false, summary: "id mismatch" });
    expect(meta?.details).toContainEqual({
      label: "Reason",
      value: "meta id tmdb:1273221.json for request tmdb:1273221",
    });
  });

  it("keeps a meta-primary addon UP when its meta is only flawed, naming the flaw", async () => {
    const m = addon({
      types: ["series"],
      resources: [{ name: "meta", types: ["series"], idPrefixes: ["tt"] }],
    });
    overrides.u = { testIds: [{ type: "series", id: "tt0944947" }] };
    try {
      router = routes([
        ["/manifest.json", manifestOk(m.manifest)],
        [
          "/meta/series/tt0944947.json",
          { status: 200, data: { meta: { id: "tt0944947", type: "series", name: "GoT" } } },
        ],
      ]);
      const r = await probe(m);
      expect(r.success).toBe(true);
      expect(r.detail.primary).toBe("meta");
      expect(r.detail.perResource.find((p) => p.resource === "meta")).toMatchObject({
        ok: true,
        summary: "valid · no videos",
      });
    } finally {
      delete overrides.u;
    }
  });

  it("explains an empty catalog whose metas lack required fields", async () => {
    const m = addon({
      types: ["movie"],
      resources: ["catalog"],
      catalogs: [{ type: "movie", id: "top", name: "Top" }],
    });
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/catalog/movie/top.json", { status: 200, data: { metas: [{ id: "m1" }] } }],
    ]);
    const r = await probe(m);
    const catalog = r.detail.perResource.find((p) => p.resource === "catalog");
    expect(r.success).toBe(false);
    expect(catalog?.summary).toBe("invalid (1 meta without type, name)");
    expect(catalog?.details.at(-1)).toEqual({
      label: "Reason",
      value: "none of 1 metas has an id and type",
    });
  });

  it("passes a catalog of metas without names and names the gap (TorrentFreaks Top-10)", async () => {
    const m = addon({
      types: ["movie"],
      resources: ["catalog"],
      catalogs: [{ type: "movie", id: "torrentfreak-movies", name: "TorrentFreak" }],
    });
    const metas = Array.from({ length: 100 }, (_, i) => ({ type: "movie", id: `tt${1000 + i}` }));
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/catalog/movie/torrentfreak-movies.json", { status: 200, data: { metas } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.perResource.find((p) => p.resource === "catalog")?.summary).toBe(
      "100 metas without name",
    );
  });
});

describe("probe stream content", () => {
  // A catalog-less imdb scraper probed on one movie and one series episode, each answering `streams`.
  async function probeDual(
    movie: unknown[],
    series: unknown[],
    manifest: Partial<Manifest> = {},
  ): Promise<Awaited<ReturnType<typeof probe>>> {
    const m = addon({
      types: ["movie", "series"],
      resources: [{ name: "stream", types: ["movie", "series"], idPrefixes: ["tt"] }],
      ...manifest,
    });
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.candidatesFor = async () => [
      { type: "movie", id: "tt0111161" },
      { type: "series", id: "tt0903747", episodeId: "tt0903747:1:1" },
    ];
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/stream/movie/tt0111161.json", { status: 200, data: { streams: movie } }],
      ["/stream/series/tt0903747:1:1.json", { status: 200, data: { streams: series } }],
    ]);
    return probe(m);
  }

  const streamOf = (r: Awaited<ReturnType<typeof probe>>) =>
    r.detail.perResource.find((p) => p.resource === "stream");

  it("passes a ratings addon answering one per-title externalUrl card as a link addon", async () => {
    const card = (rating: string, id: string) => ({
      name: "IMDb Rating",
      description: `────────────────\n⭐ IMDb: ${rating}\n────────────────`,
      externalUrl: `https://www.imdb.com/title/${id}/`,
    });
    const r = await probeDual(
      [card("9.3/10 (3,100,000 votes)", "tt0111161")],
      [card("9.2/10 (59,298 votes)", "tt0903747")],
    );
    expect(r.success).toBe(true);
    expect(r.detail.mode).toBe("content");
    expect(r.detail.streamCounts).toEqual({ total: 2, playable: 0, links: 2 });
    expect(streamOf(r)?.summary).toBe(
      "movie 0 playable, 1 link of 1 · series 0 playable, 1 link of 1",
    );
    expect(streamOf(r)?.details).toContainEqual({
      label: "Note",
      value: "link addon: links only, not content-checked",
    });
  });

  it("passes a scraper with a single real stream per title (KKPhim)", async () => {
    const r = await probeDual(
      [
        {
          name: "Nhà Tù Shawshank • 1994",
          title: "KKPhim • Vietsub • 1080p",
          url: "https://s6.kkphim.test/a/index.m3u8",
        },
      ],
      [
        {
          name: "Tập 1",
          title: "KKPhim • Vietsub • 1080p",
          url: "https://s2.kkphim.test/b/index.m3u8",
        },
      ],
    );
    expect(r.success).toBe(true);
    expect(streamOf(r)?.summary).toBe("movie 1 playable of 1 · series 1 playable of 1");
  });

  it("keeps a stream title repeated across titles as content when its URLs differ (Cotonet)", async () => {
    const r = await probeDual(
      [{ title: "Opção 1", url: "https://boss.cotonet.test/movie/1.mkv" }],
      [{ title: "Opção 1", url: "https://boss.cotonet.test/series/2.mkv" }],
    );
    expect(r.success).toBe(true);
    expect(r.detail.streamCounts).toEqual({ total: 2, playable: 2, links: 0 });
  });

  it("reports an addon answering only a configure plea as needing configuration (Jackettio)", async () => {
    const plea = {
      name: "Jackettio | ElfHosted",
      title: "ℹ Kindly configure this addon to access streams.",
      url: "https://jackettio.test/static/videos/configure.mp4",
    };
    const r = await probeDual([plea], [plea], { behaviorHints: { configurable: true } });
    expect(r.success).toBe(true);
    expect(r.detail.mode).toBe("needs-config");
    expect(r.detail.configReason).toBe(
      "Jackettio | ElfHosted · ℹ Kindly configure this addon to access streams.",
    );
    expect(r.detail.primary).toBeUndefined();
    expect(streamOf(r)?.ok).toBe(false);
    expect(r.message).toContain("needs configuration");
  });

  it("reports an obsolete Comet configuration as needing configuration", async () => {
    const plea = {
      name: "[❌] Comet",
      description: "⚠️ OBSOLETE CONFIGURATION, PLEASE RE-CONFIGURE ON https://comet.test ⚠️",
      url: "https://comet.test/placeholder",
    };
    const r = await probeDual([plea], [plea]);
    expect(r.success).toBe(true);
    expect(r.detail.mode).toBe("needs-config");
  });

  it("reports a debrid-only server refusing torrents as needing configuration (Torrin)", async () => {
    const info = {
      name: "[INFO] Comet",
      description: "Direct torrent playback is disabled on this server.",
      url: "https://comet.test",
    };
    const r = await probeDual([info], [info]);
    expect(r.detail.mode).toBe("needs-config");
  });

  it("is DOWN with the addon's own words when it says it is deprecated, even behind a playable url (Pulp Watch)", async () => {
    const notice = {
      name: "ADDON DEPRECATED - Visit lnk.bio/cinepro",
      description:
        "This addon is no longer active. Get the new version at: https://lnk.bio/cinepro",
      url: "https://archive.org/download/x/deprecated.mp4",
    };
    const r = await probeDual([notice], [notice]);
    expect(r.success).toBe(false);
    expect(r.error).toBe("stream");
    expect(streamOf(r)?.details).toContainEqual({
      label: "Reason",
      value: expect.stringMatching(/^addon says: ADDON DEPRECATED - Visit lnk\.bio\/cinepro · /),
    });
  });

  const UPSELL = {
    name: "FayaTV",
    title: "✨ $3/Month • Go Premium",
    externalUrl: "https://payments.faya.test/packages",
  };

  it("reads an upsell beside a real per-title link as noise (FayaTV)", async () => {
    const watch = (channel: string) => ({
      name: "MPD",
      title: `🌐 ${channel}`,
      externalUrl: `https://faya.test/watch/${encodeURIComponent(channel)}`,
    });
    const r = await probeDual([watch("TNT SPORTS FHD"), UPSELL], [watch("ESPN HD"), UPSELL], {
      behaviorHints: { configurable: true },
    });
    expect(r.success).toBe(true);
    expect(r.detail.mode).toBe("content");
    expect(streamOf(r)?.summary).toBe(
      "movie 0 playable, 1 link of 2 · series 0 playable, 1 link of 2",
    );
  });

  it("keeps an upsell beside a request link as needing configuration", async () => {
    const request = (id: string) => ({
      name: "REQUEST",
      title: "Request this title",
      externalUrl: `https://faya.test/request?id=${id}`,
    });
    const r = await probeDual([request("tt0111161"), UPSELL], [request("tt0903747"), UPSELL]);
    expect(r.success).toBe(true);
    expect(r.detail.mode).toBe("needs-config");
    expect(r.detail.configReason).toBe("FayaTV · ✨ $3/Month • Go Premium");
  });

  it("is DOWN when the addon refuses access, whatever links come with the refusal (WLATINO)", async () => {
    const refusal = {
      name: "INFO | WLATINO",
      title: "Acceso no autorizado",
      description:
        "Email no autorizado. Contacta al administrador para renovar o corregir tu acceso.",
      externalUrl: "https://wlatino.test/acceso",
    };
    const request = (id: string) => ({
      name: "SOLICITAR | ¿No encuentras este contenido?",
      title: "Solicítalo aquí",
      externalUrl: `https://wlatino.test/solicitar?id=${id}`,
    });
    const r = await probeDual([refusal, request("tt0111161")], [refusal, request("tt0903747")]);
    expect(r.success).toBe(false);
    expect(streamOf(r)?.details).toContainEqual({
      label: "Reason",
      value: expect.stringMatching(/^addon says: INFO \| WLATINO · Acceso no autorizado · /),
    });
  });

  it("doesn't count a 'no sources' card and a greeting as content (LTstream)", async () => {
    const greeting = {
      name: "👋 Sveiki!",
      title: "💬 Tikiuosi, mėgaujatės filmais ir serialais lietuvių kalba",
      externalUrl: "https://t.me/ltstream",
    };
    const none = {
      name: "😔 Nėra šaltinių",
      title: "Deja, bet šaltinių šiam filmui/serialui nėra.",
      externalUrl: "https://ltstream.test/",
    };
    const real = { name: "VIP LTstream 2160p BDRip", url: "https://ltstream.test/v/1.mkv" };
    const r = await probeDual([greeting, real], [none, greeting]);
    expect(r.success).toBe(true);
    expect(streamOf(r)?.summary).toBe("movie 1 playable of 2 · series 0 playable of 2");
    expect(r.detail.streamCounts).toEqual({ total: 4, playable: 1, links: 0 });

    const seriesOnly = await probeDual([greeting], [none, greeting]);
    expect(seriesOnly.success).toBe(false);
  });

  it("ignores an update nag repeated for every title (addons.zrk.app)", async () => {
    const nag = {
      name: "Made By",
      title: "Made By v1.1.0 available. Tap to update your install.",
      externalUrl: "https://addons.zrk.test/made-by/configure",
    };
    const card = (studio: string, id: string) => ({
      name: "Made By 🎬",
      title: studio,
      externalUrl: `https://www.themoviedb.org/${id}`,
    });
    const r = await probeDual(
      [card("Castle Rock Entertainment", "movie/278"), nag],
      [card("Sony Pictures Television", "tv/1396"), nag],
    );
    expect(r.success).toBe(true);
    expect(r.detail.streamCounts).toEqual({ total: 4, playable: 0, links: 2 });
  });

  it("treats a card repeated for unrelated titles as a placeholder, whatever its wording", async () => {
    const same = {
      name: "Kinopoisk рейтинг",
      title: "⭐ Кинопоиск",
      externalUrl: "https://kp.test/",
    };
    const r = await probeDual([same], [same]);
    expect(r.success).toBe(false);
    expect(streamOf(r)?.details).toContainEqual({
      label: "Reason",
      value: "same stream for unrelated titles: Kinopoisk рейтинг · ⭐ Кинопоиск",
    });

    const configurable = await probeDual([same], [same], { behaviorHints: { configurable: true } });
    expect(configurable.detail.mode).toBe("needs-config");
  });

  it("keeps cards an addon is pinned to repeat for every title (Stremio Status)", async () => {
    const card = {
      name: "Stremio Status",
      title: "⛔ Torrentio · Status: Down",
      url: "https://status.test/torrentio",
    };
    overrides.u = { name: "Stremio Status", sameStreamsForEveryTitle: "a status board" };
    // Its cards open status pages, which aren't media and aren't meant to be.
    let checked = 0;
    urlcheckMock.checkUrl = async (u) => {
      checked++;
      return { host: new URL(u.url).hostname, verdict: "webpage", outcome: "HTTP 200 text/html" };
    };
    try {
      const r = await probeDual([card], [card], { behaviorHints: { configurable: true } });
      expect(checked).toBe(0);
      expect(r.success).toBe(true);
      expect(r.detail.mode).toBe("content");
    } finally {
      delete overrides.u;
    }
  });

  it("is DOWN when every title gets 'no data' (Kinopoisk рейтинг)", async () => {
    const none = {
      name: "Kinopoisk рейтинг",
      title: "⭐ Кинопоиск: нет данных",
      externalUrl: "https://www.kinopoisk.ru/",
    };
    const r = await probeDual([none], [none]);
    expect(r.success).toBe(false);
    expect(r.detail.mode).toBe("content");
  });

  it("doesn't count a trailer as content (StreamViX)", async () => {
    const trailer = (id: string) => ({
      name: "StreamViX",
      title: "Trailer",
      ytId: id,
      behaviorHints: { bingeGroup: "trailer" },
    });
    const r = await probeDual([trailer("a1")], []);
    expect(streamOf(r)?.summary).toBe("movie 0 playable, 1 link of 1 · series no streams");
    expect(r.detail.streamCounts).toEqual({ total: 1, playable: 0, links: 1 });
  });

  it("doesn't count loopback URLs as playable (Linkañol)", async () => {
    const local = (id: string) => ({
      name: "Linkañol",
      title: "1080p",
      url: `http://localhost:5871/proxy/debrid?link=${id}`,
    });
    const r = await probeDual([local("a")], [local("b")]);
    expect(r.success).toBe(false);
    expect(streamOf(r)?.summary).toBe("movie 0 playable of 1 · series 0 playable of 1");
  });

  it("reports a paywall card on a live channel as needing configuration (Magyar TV)", async () => {
    const m = addon({
      types: ["tv"],
      resources: ["catalog", "meta", "stream"],
      catalogs: [{ type: "tv", id: "magyar-all", name: "Összes" }],
    });
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/tv/magyar-all.json",
        { status: 200, data: { metas: [{ id: "magyar:m1-hd", type: "tv", name: "M1 HD" }] } },
      ],
      [
        "/meta/tv/magyar:m1-hd.json",
        { status: 200, data: { meta: { id: "magyar:m1-hd", type: "tv", name: "M1 HD" } } },
      ],
      [
        "/stream/tv/magyar:m1-hd.json",
        {
          status: 200,
          data: {
            streams: [
              {
                name: "Magyar TV",
                title: "Teljes hozzáférés aktiválása",
                externalUrl: "https://stremiptv.test/activate",
              },
            ],
          },
        },
      ],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.mode).toBe("needs-config");
    expect(r.detail.configReason).toBe("Magyar TV · Teljes hozzáférés aktiválása");
  });
});

describe("probe catalog notices", () => {
  const notice = (id: string, name: string, type = "movie") => ({ id, type, name });

  it("skips a promo tile and tests the next catalog item", async () => {
    const m = addon({
      types: ["movie"],
      resources: ["catalog", { name: "stream", types: ["movie"], idPrefixes: ["tt", "ir:"] }],
      catalogs: [{ type: "movie", id: "ir-top", name: "Top" }],
    });
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/movie/ir-top.json",
        {
          status: 200,
          data: {
            metas: [
              notice("ir:promo-unlock", "🔓 Unlock all languages"),
              { id: "tt1", type: "movie", name: "Real" },
            ],
          },
        },
      ],
      ["/stream/movie/tt1.json", { status: 200, data: { streams: [PLAYABLE] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.message).toContain("stream: movie 1 playable of 1");
  });

  it("reports an addon whose only catalog item asks for a key as needing configuration (Pictorium)", async () => {
    const m = addon({
      types: ["movie"],
      resources: ["catalog", "meta"],
      catalogs: [{ type: "movie", id: "pictorium-jw-movies", name: "JustWatch" }],
    });
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/movie/pictorium-jw-movies.json",
        {
          status: 200,
          data: { metas: [notice("pictorium:notice:missing-tmdb-key", "Chiave TMDB richiesta")] },
        },
      ],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.mode).toBe("needs-config");
    expect(r.detail.configReason).toBe("Chiave TMDB richiesta");
    const catalog = r.detail.perResource.find((p) => p.resource === "catalog");
    expect(catalog?.summary).toBe("only notices");
    expect(catalog?.details.at(-1)).toEqual({
      label: "Reason",
      value: "addon says: Chiave TMDB richiesta",
    });
  });

  it("stops at a catalog asking for a key rather than passing on a later catalog (Pictorium)", async () => {
    const m = addon({
      types: ["movie"],
      resources: ["catalog", "meta"],
      catalogs: [
        { type: "movie", id: "pictorium-jw-movies", name: "JustWatch" },
        { type: "movie", id: "pictorium-netflix-movies", name: "Netflix" },
      ],
    });
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/movie/pictorium-jw-movies.json",
        {
          status: 200,
          data: { metas: [notice("pictorium:notice:missing-tmdb-key", "Chiave TMDB richiesta")] },
        },
      ],
      [
        "/catalog/movie/pictorium-netflix-movies.json",
        { status: 200, data: { metas: [{ id: "tmdb:1571955", type: "movie", name: "Real" }] } },
      ],
    ]);
    const r = await probe(m);
    expect(r.detail.mode).toBe("needs-config");
    expect(r.detail.configReason).toBe("Chiave TMDB richiesta");
  });

  it("is DOWN when the only catalog item says the service ended (Nebula Sports)", async () => {
    const m = addon({
      types: ["sports"],
      resources: ["catalog", "meta", "stream"],
      catalogs: [{ type: "sports", id: "all", name: "Create a private free manifest" }],
    });
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/sports/all.json",
        {
          status: 200,
          data: {
            metas: [
              notice("streamed:nebula-shared-free-expired", "Private manifest required", "sports"),
            ],
          },
        },
      ],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(false);
    expect(r.error).toBe("catalog");
    expect(r.detail.primary).toBe("catalog");
    expect(r.message).toBe("manifest up · catalog: only notices");
  });

  it("reports needs-config when catalogs hold only key notices and borrowed titles get nothing (UploadedPremiumLink)", async () => {
    const m = addon({
      types: ["movie", "series"],
      resources: [
        "catalog",
        "meta",
        { name: "stream", types: ["movie", "series"], idPrefixes: ["tt", "upl:"] },
      ],
      catalogs: [
        { type: "movie", id: "upl_files", name: "Files" },
        { type: "series", id: "upl_series", name: "Series" },
      ],
    });
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.candidatesFor = async () => [
      { type: "movie", id: "tt1" },
      { type: "series", id: "tt2", episodeId: "tt2:1:1" },
    ];
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/movie/upl_files.json",
        { status: 200, data: { metas: [notice("upl:invalid_apikey", "⚠️ Invalid API Key")] } },
      ],
      [
        "/catalog/series/upl_series.json",
        {
          status: 200,
          data: { metas: [notice("upl:invalid_apikey", "⚠️ Invalid API Key", "series")] },
        },
      ],
      ["/stream/movie/tt1.json", { status: 200, data: { streams: [] } }],
      ["/stream/series/tt2:1:1.json", { status: 200, data: { streams: [] } }],
      ["/meta/", { status: 200, data: { meta: null } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.mode).toBe("needs-config");
    expect(r.detail.configReason).toBe("⚠️ Invalid API Key");
  });

  it("judges a catalog addon on its catalogs when its stream resource answers nothing for its own titles (Scary Only)", async () => {
    const m = addon({
      types: ["movie", "series"],
      resources: ["catalog", "stream"],
      idPrefixes: ["tt"],
      catalogs: [
        { type: "movie", id: "scary-news", name: "🆕 New & Updates" },
        { type: "series", id: "scary-series-slasher", name: "📺 Slasher" },
      ],
      behaviorHints: { configurable: true },
    });
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.candidatesFor = async () => [{ type: "movie", id: "tt1" }];
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/movie/scary-news.json",
        {
          status: 200,
          data: {
            metas: [notice("scary-news-donate-qr", "❤️ Support Scary Only — Scan to Donate")],
          },
        },
      ],
      [
        "/catalog/series/scary-series-slasher.json",
        { status: 200, data: { metas: [{ id: "tt2", type: "series", name: "Slasher" }] } },
      ],
      ["/stream/movie/tt1.json", { status: 200, data: { streams: [] } }],
      ["/stream/series/tt2:1:1.json", { status: 200, data: { streams: [] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.primary).toBe("catalog");
    expect(r.detail.perResource.find((p) => p.resource === "catalog")?.summary).toBe(
      "movie only notices · series 1 metas",
    );
  });

  it("keeps judging on streams when the addon's own titles use its own ID space (Pinoy Movies)", async () => {
    const m = addon({
      types: ["movie"],
      resources: ["catalog", "stream"],
      catalogs: [{ type: "movie", id: "pinoy", name: "Pinoy" }],
    });
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/movie/pinoy.json",
        { status: 200, data: { metas: [{ id: "tmdb:1719326", type: "movie", name: "Real" }] } },
      ],
      ["/stream/movie/tmdb:1719326.json", { status: 200, data: { streams: [] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(false);
    expect(r.detail.primary).toBe("stream");
  });

  it("keeps judging on streams when they answer notices for the addon's own titles", async () => {
    const m = addon({
      types: ["movie"],
      resources: ["catalog", "stream"],
      catalogs: [{ type: "movie", id: "top", name: "Top" }],
    });
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/movie/top.json",
        { status: 200, data: { metas: [{ id: "tt1", type: "movie", name: "Real" }] } },
      ],
      [
        "/stream/movie/tt1.json",
        {
          status: 200,
          data: {
            streams: [{ title: "⭐ Кинопоиск: нет данных", externalUrl: "https://kp.test/" }],
          },
        },
      ],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(false);
    expect(r.detail.primary).toBe("stream");
  });
});

describe("probe catalog addons whose streams are empty for their own titles", () => {
  afterEach(() => {
    for (const uuid of Object.keys(overrides)) delete overrides[uuid];
  });

  const ttCatalogAddon = (manifest: Partial<Manifest> = {}, categories = ["movies"]) => {
    const m = addon({
      types: ["movie"],
      resources: ["catalog", "stream"],
      idPrefixes: ["tt"],
      catalogs: [{ type: "movie", id: "top", name: "Top" }],
      ...manifest,
    });
    m.categories = categories;
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/movie/top.json",
        { status: 200, data: { metas: [{ id: "tt1", type: "movie", name: "Real" }] } },
      ],
      ["/stream/movie/tt1.json", { status: 200, data: { streams: [] } }],
    ]);
    return m;
  };

  it("is DOWN when nothing says its streams are optional", async () => {
    const r = await probe(ttCatalogAddon({ description: "Movies with direct links" }));
    expect(r.success).toBe(false);
    expect(r.detail.primary).toBe("stream");
  });

  it("judges it on its catalogs when it is configurable", async () => {
    const r = await probe(ttCatalogAddon({ behaviorHints: { configurable: true } }));
    expect(r.success).toBe(true);
    expect(r.detail.primary).toBe("catalog");
  });

  it("judges it on its catalogs when its description calls it a catalog add-on (Indian Regional Catalog)", async () => {
    const r = await probe(
      ttCatalogAddon({
        description:
          "🇮🇳 Indian Regional Movies & Series Catalog Add-on. Available Catalogs: Telugu",
      }),
    );
    expect(r.success).toBe(true);
    expect(r.detail.primary).toBe("catalog");
  });

  it("judges it on its catalogs when its listing files it under metadata only (Pinoy Movies)", async () => {
    const r = await probe(
      ttCatalogAddon({ description: "Philippines R-18 movies from TMDB." }, [
        "movies",
        "metadata",
        "nsfw",
      ]),
    );
    expect(r.success).toBe(true);
    expect(r.detail.primary).toBe("catalog");
  });

  it("stays DOWN when its listing files it under metadata and a stream source", async () => {
    const r = await probe(ttCatalogAddon({}, ["metadata", "movies", "http streams"]));
    expect(r.success).toBe(false);
    expect(r.detail.primary).toBe("stream");
  });

  it("judges it on its catalogs when its override says its streams are optional, and says why", async () => {
    const m = ttCatalogAddon();
    overrides[m.uuid] = { name: "Stub", streamsOptional: "its homepage says no media is hosted" };
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.primary).toBe("catalog");
    expect(r.detail.perResource.find((p) => p.resource === "stream")?.details).toContainEqual({
      label: "Note",
      value:
        "no streams for the addon's own catalog titles (its homepage says no media is hosted); judged on its catalogs",
    });
  });
});

describe("probe needs-configuration", () => {
  afterEach(() => {
    for (const uuid of Object.keys(overrides)) delete overrides[uuid];
  });

  const requested: string[] = [];
  const recording = (map: Array<[string, RouteResult]>) => {
    requested.length = 0;
    const route = routes(map);
    return (url: string) => {
      requested.push(url);
      return route(url);
    };
  };

  /** Express's answer for a path no route matches, as an unconfigured Magnetio or Zamunda BG serves it. */
  const CANNOT_GET: RouteResult = {
    status: 404,
    data: undefined,
    parseError: {
      html: true,
      contentType: "text/html; charset=utf-8",
      title: "Error",
      excerpt:
        '<!DOCTYPE html> <html lang="en"> <head> <meta charset="utf-8"> <title>Error</title>',
    },
  };

  const CONFIGURE_PAGE: RouteResult = {
    ...HTML_PAGE,
    parseError: { ...HTML_PAGE.parseError!, title: "Configure" },
  };

  const scraper = (manifest: Partial<Manifest> = {}) => {
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.candidatesFor = async () => [
      { type: "movie", id: "tt0111161" },
      { type: "series", id: "tt0903747", episodeId: "tt0903747:1:1" },
    ];
    return addon({
      types: ["movie", "series"],
      resources: [{ name: "stream", types: ["movie", "series"], idPrefixes: ["tt"] }],
      ...manifest,
    });
  };

  it("honours a root-level configurationRequired without asking for content (ItsOut | ElfHosted)", async () => {
    const m = scraper();
    const manifest = { ...m.manifest, configurable: true, configurationRequired: true };
    router = recording([["/manifest.json", manifestOk(manifest as Manifest)]]);
    const r = await probe(m);
    expect(r.detail.mode).toBe("needs-config");
    expect(r.detail.configReason).toBe("manifest sets configurationRequired");
    expect(requested).toEqual([`${BASE}/manifest.json`]);
  });

  it("treats a required setting without a default as configurationRequired (Eh! Iptv)", async () => {
    const m = scraper({ behaviorHints: { configurable: true } });
    const manifest = {
      ...m.manifest,
      config: [{ key: "token", type: "text", title: "Access token", required: true }],
    };
    router = recording([["/manifest.json", manifestOk(manifest as Manifest)]]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.configReason).toBe("manifest requires setting token");
  });

  const stashdb = () => {
    const m = addon({
      types: ["movie"],
      idPrefixes: ["stashdb:"],
      resources: ["catalog", "meta", "stream"],
      catalogs: [{ type: "movie", id: "stashdb-trending", name: "Trending" }],
      behaviorHints: { configurable: true, configurationRequired: false },
    });
    const manifest = {
      ...m.manifest,
      config: [
        { key: "easynewsUsername", type: "text", title: "Easynews Username", required: true },
        { key: "easynewsPassword", type: "password", title: "Easynews Password", required: true },
      ],
    } as Manifest;
    return { ...m, manifest };
  };

  it("is DOWN when a required setting is declared but the own catalogs, the only ID source, are empty (StashDB - Easynews)", async () => {
    const m = stashdb();
    router = recording([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/catalog/movie/stashdb-trending.json", { status: 200, data: { metas: [] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(false);
    expect(r.detail.mode).toBe("content");
    expect(r.detail.primary).toBe("catalog");
    expect(r.detail.perResource.find((p) => p.resource === "catalog")?.summary).toBe("empty");
    expect(requested.some((u) => u.includes("/stream/"))).toBe(false);
  });

  it("keeps a declared required setting needs-config when the own catalogs list titles", async () => {
    const m = stashdb();
    router = recording([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/movie/stashdb-trending.json",
        { status: 200, data: { metas: [{ id: "stashdb:abc", type: "movie", name: "Scene" }] } },
      ],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.mode).toBe("needs-config");
    expect(r.detail.configReason).toBe(
      "manifest requires setting easynewsUsername, easynewsPassword",
    );
    expect(requested.some((u) => u.includes("/stream/"))).toBe(false);
  });

  it("keeps a declared required setting needs-config without asking catalogs when an ID source covers the stream prefixes (Eh! Iptv)", async () => {
    const m = scraper({
      types: ["tv", "movie", "series"],
      idPrefixes: ["ehiptv:", "tt"],
      resources: ["catalog", "meta", "stream"],
      catalogs: [{ type: "tv", id: "ehiptv-live", name: "Live" }],
      behaviorHints: { configurable: true },
    });
    const manifest = {
      ...m.manifest,
      config: [{ key: "token", type: "text", title: "Token de Acesso", required: true }],
    } as Manifest;
    router = recording([["/manifest.json", manifestOk(manifest)]]);
    const r = await probe(m);
    expect(r.detail.mode).toBe("needs-config");
    expect(r.detail.configReason).toBe("manifest requires setting token");
    expect(requested).toEqual([`${BASE}/manifest.json`]);
  });

  it("reports a configurable addon whose stream route is missing as needing configuration (Magnetio)", async () => {
    const m = scraper({ behaviorHints: { configurable: true } });
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/stream/", CANNOT_GET],
      ["/configure", CONFIGURE_PAGE],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.mode).toBe("needs-config");
    expect(r.detail.configReason).toBe("unconfigured content routes answer HTTP 404");
    expect(r.detail.perResource.find((p) => p.resource === "stream")?.ok).toBe(false);
  });

  it("keeps a missing stream route DOWN when the addon offers no configuration (40th PROJECT)", async () => {
    const m = scraper();
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/stream/", CANNOT_GET],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(false);
  });

  it("keeps a configurable addon answering no streams DOWN (WebStreamrMBG)", async () => {
    const m = scraper({ behaviorHints: { configurable: true } });
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/stream/", { status: 200, data: { streams: [] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(false);
  });

  it("reports the same 403 on both routes as needing configuration when the manifest loaded (Comet | ElfHosted)", async () => {
    const m = scraper({ behaviorHints: { configurable: true } });
    const forbidden: RouteResult = {
      status: 403,
      data: undefined,
      parseError: { html: false, contentType: "text/plain", excerpt: "Forbidden" },
      attempts: [
        { route: "WARP", status: 403, durationMs: 1 },
        { route: "direct", status: 403, durationMs: 1 },
      ],
    };
    router = routes([
      [
        "/manifest.json",
        { ...manifestOk(m.manifest), attempts: [{ route: "WARP", status: 200, durationMs: 1 }] },
      ],
      ["/stream/", forbidden],
      ["/configure", CONFIGURE_PAGE],
    ]);
    const r = await probe(m);
    expect(r.detail.mode).toBe("needs-config");
    expect(r.detail.configReason).toBe("unconfigured content routes answer HTTP 403");
  });

  it("reports a configurable catalog addon whose catalog route is missing as needing configuration", async () => {
    const m = addon({
      types: ["movie"],
      resources: ["catalog"],
      catalogs: [{ type: "movie", id: "pending", name: "Pending" }],
      behaviorHints: { configurable: true },
    });
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/catalog/", { status: 404, data: { detail: "Not Found" } }],
      ["/configure", CONFIGURE_PAGE],
    ]);
    const r = await probe(m);
    expect(r.detail.mode).toBe("needs-config");
  });

  it("keeps a missing route DOWN when the configure page leads to another site (TOP Posters Addon Wrapper)", async () => {
    const m = scraper({ behaviorHints: { configurable: true } });
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/stream/", { status: 404, data: { detail: "Not Found" } }],
      ["/configure", { ...CONFIGURE_PAGE, redirect: "api.top-posters.test → top-posters.test" }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(false);
  });

  it("lets a needsConfig pin win without asking for content (Kast Alldebrid)", async () => {
    const m = scraper({ behaviorHints: { configurable: true } });
    overrides[m.uuid] = {
      name: "Kast Alldebrid",
      needsConfig: "streams need the user's AllDebrid key",
    };
    router = recording([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/stream/", { status: 200, data: { streams: [PLAYABLE] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.mode).toBe("needs-config");
    expect(r.detail.configReason).toBe("streams need the user's AllDebrid key");
    expect(requested).toEqual([`${BASE}/manifest.json`]);
  });

  it("keeps a pinned addon DOWN when its manifest is unreachable", async () => {
    const m = scraper();
    overrides[m.uuid] = { name: "Statusio", needsConfig: "empty without debrid tokens" };
    router = routes([["/manifest.json", { status: 502, data: undefined }]]);
    const r = await probe(m);
    expect(r.success).toBe(false);
  });

  it("probes curated test IDs before any ID source (40th PROJECT)", async () => {
    const m = scraper({
      types: ["series"],
      resources: [{ name: "stream", types: ["series"], idPrefixes: ["tt"] }],
    });
    overrides[m.uuid] = {
      name: "40th PROJECT",
      testIds: [
        { type: "series", id: "tt0280249" },
        { type: "series", id: "tt0121220" },
      ],
    };
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/stream/series/tt0280249:1:1.json", { status: 200, data: { streams: [EPISODE] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.mode).toBe("content");
    const stream = r.detail.perResource.find((p) => p.resource === "stream");
    expect(stream?.details).toContainEqual({ label: "Test ID", value: "tt0280249:1:1 (curated)" });
  });

  it("content-checks a configurationRequired addon under its public test config, which no row shows (Anime Catalogs)", async () => {
    const testConfig = "%7B%22search%22%3A%22on%22%7D";
    const m = addon({
      types: ["anime"],
      resources: ["catalog"],
      catalogs: [],
      behaviorHints: { configurable: true, configurationRequired: true },
    });
    overrides[m.uuid] = { name: "Anime Catalogs", testConfig };
    const configured = {
      ...m.manifest,
      catalogs: [{ type: "anime", id: "top-airing", name: "Top Airing" }],
      behaviorHints: { configurable: true },
    };
    const configuredBase = `${BASE}/${testConfig}`;
    router = recording([
      [`${configuredBase}/manifest.json`, manifestOk(configured as Manifest)],
      [
        `${configuredBase}/catalog/anime/top-airing.json`,
        { status: 200, data: { metas: [{ id: "kitsu:12", type: "series", name: "One Piece" }] } },
      ],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.mode).toBe("content");
    expect(r.detail.manifestDetails).toContainEqual({
      label: "Note",
      value: "probed with a public test config",
    });
    const rows = [r.detail.manifestDetails, ...r.detail.perResource.map((p) => p.details)].flat();
    expect(rows.some((row) => row.value.includes(testConfig))).toBe(false);
    expect(requested.every((url) => url.startsWith(configuredBase))).toBe(true);
  });

  it("probes under the test config even when the configured manifest still says configurationRequired", async () => {
    const m = scraper({ behaviorHints: { configurable: true, configurationRequired: true } });
    overrides[m.uuid] = { name: "Strelingo", testConfig: "eng" };
    router = routes([
      [`${BASE}/eng/manifest.json`, manifestOk(m.manifest)],
      [`${BASE}/eng/stream/movie/`, { status: 200, data: { streams: [PLAYABLE] } }],
      [`${BASE}/eng/stream/series/`, { status: 200, data: { streams: [EPISODE] } }],
    ]);
    const r = await probe(m);
    expect(r.detail.mode).toBe("content");
  });
});

describe("probe test-ID scope", () => {
  it("skips the meta check when no title is in the meta resource's scope (Halloween After Dark)", async () => {
    const m = addon({
      types: ["movie", "series", "other"],
      resources: [
        { name: "catalog", types: ["movie", "series", "other"] },
        { name: "meta", types: ["series"], idPrefixes: ["had:episode:"] },
      ],
      catalogs: [{ type: "other", id: "recent-horror", name: "Recent" }],
    });
    const requested: string[] = [];
    const route = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/other/recent-horror.json",
        { status: 200, data: { metas: [{ id: "tt34890576", type: "movie", name: "Obsession" }] } },
      ],
    ]);
    router = (url) => {
      requested.push(url);
      return route(url);
    };
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(requested.some((u) => u.includes("/meta/"))).toBe(false);
    const meta = r.detail.perResource.find((p) => p.resource === "meta");
    expect(meta).toEqual({
      resource: "meta",
      ok: true,
      summary: "no test ID in scope",
      details: [
        {
          label: "Skipped",
          value: "no test ID in the meta resource's scope (series · had:episode:)",
        },
      ],
    });
  });

  it("checks meta with the first catalog title in its scope (French Stream)", async () => {
    const m = addon({
      types: ["movie"],
      resources: ["catalog", { name: "meta", types: ["movie"], idPrefixes: ["fs:"] }],
      catalogs: [{ type: "movie", id: "fs-derniers-films", name: "Films" }],
    });
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/movie/fs-derniers-films.json",
        {
          status: 200,
          data: {
            metas: [
              { id: "tt35856037", type: "movie", name: "A" },
              { id: "fs:123", type: "movie", name: "B" },
            ],
          },
        },
      ],
      [
        "/meta/movie/fs:123.json",
        { status: 200, data: { meta: { id: "fs:123", type: "movie", name: "B" } } },
      ],
    ]);
    const r = await probe(m);
    expect(r.message).toContain("meta: valid");
  });

  it("judges an addon on its catalogs when its meta hands every own title to other addons' IDs (Sitcom Surprise)", async () => {
    const m = addon({
      types: ["series"],
      resources: [
        "catalog",
        { name: "meta", types: ["series"], idPrefixes: ["shuffle:"] },
        { name: "stream", types: ["series"], idPrefixes: ["shuffle:"] },
      ],
      catalogs: [{ type: "series", id: "shuffle", name: "Shuffle" }],
    });
    const requested: string[] = [];
    const route = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/series/shuffle.json",
        {
          status: 200,
          data: { metas: [{ id: "shuffle:office", type: "series", name: "The Office" }] },
        },
      ],
      [
        "/meta/series/shuffle:office.json",
        {
          status: 200,
          data: {
            meta: {
              id: "shuffle:office",
              type: "series",
              name: "The Office",
              behaviorHints: { defaultVideoId: "tt0386676:2:7" },
            },
          },
        },
      ],
    ]);
    router = (url) => {
      requested.push(url);
      return route(url);
    };
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.mode).toBe("content");
    expect(r.detail.primary).toBe("catalog");
    const stream = r.detail.perResource.find((p) => p.resource === "stream");
    expect(stream?.summary).toBe("no ID in stream scope");
    expect(stream?.details).toContainEqual({
      label: "Skipped",
      value: "tt0386676:2:7: outside the stream resource's scope",
    });
    expect(requested.some((u) => u.includes("/stream/"))).toBe(false);
  });

  it("stays liveness-only when no own title is in the stream resource's scope and the catalogs list only notices", async () => {
    const m = addon({
      types: ["series"],
      resources: [
        "catalog",
        { name: "meta", types: ["series"], idPrefixes: ["shuffle:"] },
        { name: "stream", types: ["series"], idPrefixes: ["shuffle:"] },
      ],
      catalogs: [{ type: "series", id: "shuffle", name: "Shuffle" }],
    });
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/series/shuffle.json",
        {
          status: 200,
          data: { metas: [{ id: "shuffle:donate", type: "series", name: "Buy me a coffee" }] },
        },
      ],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.mode).toBe("liveness-only");
  });

  it("tests a navigation addon with a borrowed movie when its own episodes are outside its stream scope (Watch Order)", async () => {
    const m = addon({
      types: ["movie", "series"],
      resources: [
        "catalog",
        { name: "stream", types: ["movie", "series"], idPrefixes: ["tt"] },
        { name: "meta", types: ["series"], idPrefixes: ["wo:"] },
      ],
      catalogs: [
        {
          type: "series",
          id: "wo.universes",
          name: "Universes",
          extra: [{ name: "genre", isRequired: true, options: ["Marvel"] }],
        },
      ],
    });
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.candidatesFor = async () => [
      { type: "movie", id: "tt13968252", source: "cinemeta" },
    ];
    const link = {
      name: "Watch Order",
      title: "Next: Thor",
      externalUrl: "stremio:///detail/movie/tt0800369",
    };
    const requested: string[] = [];
    const route = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/series/wo.universes/genre=Marvel.json",
        { status: 200, data: { metas: [{ id: "wo:mcu", type: "series", name: "MCU" }] } },
      ],
      [
        "/meta/series/wo:mcu.json",
        {
          status: 200,
          data: {
            meta: {
              id: "wo:mcu",
              type: "series",
              name: "MCU",
              videos: [{ id: "wo:mcu:ep:tt13968252", season: 1, episode: 1 }],
            },
          },
        },
      ],
      ["/stream/movie/tt13968252.json", { status: 200, data: { streams: [link] } }],
    ]);
    router = (url) => {
      requested.push(url);
      return route(url);
    };
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(requested.some((u) => u.includes("/stream/series/"))).toBe(false);
    const stream = r.detail.perResource.find((p) => p.resource === "stream");
    expect(stream?.details).toContainEqual({
      label: "Skipped",
      value: "wo:mcu:ep:tt13968252: outside the stream resource's scope",
    });
  });

  it("asks Cinemeta, not its own meta, for an IMDb series its meta resource doesn't claim", async () => {
    const m = addon({
      types: ["series"],
      resources: [
        "catalog",
        { name: "meta", types: ["series"], idPrefixes: ["had:episode:"] },
        { name: "stream", types: ["series"], idPrefixes: ["tt"] },
      ],
      catalogs: [{ type: "series", id: "spooky-tv", name: "Spooky TV" }],
    });
    const requested: string[] = [];
    const route = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/series/spooky-tv.json",
        {
          status: 200,
          data: { metas: [{ id: "tt0103352", type: "series", name: "Are You Afraid" }] },
        },
      ],
      [
        "v3-cinemeta.strem.io/meta/series/tt0103352.json",
        {
          status: 200,
          data: {
            meta: {
              id: "tt0103352",
              videos: [
                { id: "tt0103352:0:1", season: 0, episode: 1 },
                { id: "tt0103352:1:2", season: 1, episode: 2 },
              ],
            },
          },
        },
      ],
      ["/stream/series/tt0103352:1:2.json", { status: 200, data: { streams: [EPISODE] } }],
    ]);
    router = (url) => {
      requested.push(url);
      return route(url);
    };
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(requested.some((u) => u.startsWith(`${BASE}/meta/`))).toBe(false);
  });
});

describe("probe episode IDs", () => {
  it("streams a custom-type title with the episode its meta lists (Heroes)", async () => {
    const m = addon({
      types: ["Heroes"],
      resources: [
        "catalog",
        { name: "meta", types: ["Heroes"], idPrefixes: ["tt", "hub:"] },
        { name: "stream", types: ["Heroes"], idPrefixes: ["tt", "hub:"] },
      ],
      catalogs: [{ type: "Heroes", id: "99575:kamen-rider", name: "Kamen Rider" }],
    });
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/Heroes/99575:kamen-rider.json",
        { status: 200, data: { metas: [{ id: "tt41416782", type: "Heroes", name: "Zeztz" }] } },
      ],
      [
        "/meta/Heroes/tt41416782.json",
        {
          status: 200,
          data: {
            meta: {
              id: "tt41416782",
              type: "Heroes",
              name: "Zeztz",
              videos: [{ id: "tt41416782:1:1", season: 1, episode: 1 }],
            },
          },
        },
      ],
      ["/stream/Heroes/tt41416782:1:1.json", { status: 200, data: { streams: [EPISODE] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.message).toContain("stream: Heroes 1 playable of 1");
  });

  it("prefers a regular episode over a season-0 special (One Pace)", async () => {
    const m = addon({
      types: ["anime"],
      resources: ["catalog", "meta", "stream"],
      catalogs: [{ type: "anime", id: "seriesCatalog", name: "One Pace" }],
    });
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/anime/seriesCatalog.json",
        { status: 200, data: { metas: [{ id: "pp_onepace", type: "anime", name: "One Pace" }] } },
      ],
      [
        "/meta/anime/pp_onepace.json",
        {
          status: 200,
          data: {
            meta: {
              id: "pp_onepace",
              type: "anime",
              name: "One Pace",
              videos: [
                { id: "SP_1", season: 0, episode: 1 },
                { id: "RO_1", season: 1, episode: 1 },
              ],
            },
          },
        },
      ],
      ["/stream/anime/RO_1.json", { status: 200, data: { streams: [EPISODE] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
  });

  it("moves on to the next title when one has no episode ID, noting it (KhmerDub)", async () => {
    const m = addon({
      types: ["series"],
      resources: ["catalog", "meta", "stream"],
      catalogs: [{ type: "series", id: "vip", name: "VIP" }],
    });
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/series/vip.json",
        {
          status: 200,
          data: {
            metas: [
              { id: "vip:1", type: "series", name: "A" },
              { id: "vip:2", type: "series", name: "B" },
            ],
          },
        },
      ],
      ["/meta/series/vip:1.json", { status: 200, data: { meta: null } }],
      [
        "/meta/series/vip:2.json",
        {
          status: 200,
          data: { meta: { id: "vip:2", type: "series", name: "B", videos: [{ id: "vip:2:1" }] } },
        },
      ],
      ["/stream/series/vip:2:1.json", { status: 200, data: { streams: [EPISODE] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    const stream = r.detail.perResource.find((p) => p.resource === "stream");
    expect(stream?.details).toContainEqual({ label: "Skipped", value: "vip:1: no episode ID" });
  });
});

describe("probe own catalogs as the ID source", () => {
  const ownCatalogAddon = (catalogs: Manifest["catalogs"], types = ["movie"]) =>
    addon({
      types,
      idPrefixes: ["custom:"],
      resources: ["catalog", "meta", "stream"],
      catalogs,
    });

  it("is DOWN when the addon's own catalog, its only ID source, answers HTTP 500 (Crunch, AnimePahe)", async () => {
    const m = ownCatalogAddon([{ type: "movie", id: "top", name: "Top" }]);
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/catalog/movie/top.json", { status: 500, data: { error: "Unexpected token '<'" } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(false);
    expect(r.detail.mode).toBe("content");
    expect(r.detail.primary).toBe("catalog");
    expect(r.error).toBe("catalog");
    expect(r.message).toBe("manifest up · catalog: movie HTTP 500");
    const catalog = r.detail.perResource.find((p) => p.resource === "catalog");
    expect(catalog?.details).toContainEqual({
      label: "Reason",
      value: "addon responded with HTTP 500: Unexpected token '<'",
    });
  });

  it("is DOWN only once every catalog it tries is empty (IndTorrents), and UP when a later one has titles (Motorsport Hub)", async () => {
    const catalogs = ["a", "b", "c", "d"].map((id) => ({ type: "movie", id, name: id }));
    const m = ownCatalogAddon(catalogs);
    const empty = { status: 200, data: { metas: [] } };
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/catalog/movie/", empty],
    ]);
    const down = await probe(m);
    expect(down.success).toBe(false);
    expect(down.message).toBe(
      "manifest up · catalog: movie empty (3 tries) · catalogs: 0 of 4 OK · a empty, b empty, c empty, d empty",
    );

    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/catalog/movie/a.json", empty],
      [
        "/catalog/movie/b.json",
        { status: 200, data: { metas: [{ id: "custom:1", type: "movie", name: "X" }] } },
      ],
      [
        "/meta/movie/custom:1.json",
        { status: 200, data: { meta: { id: "custom:1", type: "movie", name: "X" } } },
      ],
      ["/stream/movie/custom:1.json", { status: 200, data: { streams: [PLAYABLE] } }],
    ]);
    const up = await probe(m);
    expect(up.success).toBe(true);
    const catalog = up.detail.perResource.find((p) => p.resource === "catalog");
    expect(catalog?.ok).toBe(true);
    expect(catalog?.details).toContainEqual({
      label: "Also tried",
      value: "/catalog/movie/a.json · empty",
    });
  });

  it("tries several search terms before calling a search-only catalog empty, and stops at an error (Iran Provider, Crunch)", async () => {
    const m = ownCatalogAddon([
      {
        type: "movie",
        id: "search",
        name: "Search",
        extra: [{ name: "search", isRequired: true }],
      },
    ]);
    const requested: string[] = [];
    let route = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/catalog/movie/search/", { status: 200, data: { metas: [] } }],
    ]);
    router = (url) => {
      requested.push(url);
      return route(url);
    };
    const empty = await probe(m);
    expect(empty.success).toBe(false);
    expect(requested.filter((u) => u.includes("/catalog/"))).toEqual([
      `${BASE}/catalog/movie/search/search=batman.json`,
      `${BASE}/catalog/movie/search/search=naruto.json`,
      `${BASE}/catalog/movie/search/search=love.json`,
    ]);

    requested.length = 0;
    route = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/catalog/movie/search/", { status: 500, data: {} }],
    ]);
    const failed = await probe(m);
    expect(failed.message).toBe("manifest up · catalog: movie HTTP 500");
    expect(requested.filter((u) => u.includes("/catalog/"))).toHaveLength(1);
  });

  it("stays liveness-only when its catalogs need input the worker can't give", async () => {
    const m = ownCatalogAddon([
      { type: "movie", id: "mine", name: "Mine", extra: [{ name: "user", isRequired: true }] },
    ]);
    router = routes([["/manifest.json", manifestOk(m.manifest)]]);
    const r = await probe(m);
    expect(r.detail.mode).toBe("liveness-only");
  });

  it("stays liveness-only when an external source covers its prefixes, so the catalog isn't its only ID source", async () => {
    const m = addon({
      types: ["movie"],
      resources: ["catalog", { name: "stream", types: ["movie"], idPrefixes: ["tt"] }],
      catalogs: [{ type: "movie", id: "top", name: "Top" }],
    });
    idsourcesMock.hasSourceFor = () => true;
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/catalog/movie/top.json", { status: 500, data: {} }],
    ]);
    const r = await probe(m);
    expect(r.detail.mode).toBe("liveness-only");
  });

  it("queries catalogs the manifest declares without a catalog resource (Napflix)", async () => {
    const m = addon({
      types: ["channel"],
      resources: [
        { name: "stream", types: ["channel"], idPrefixes: ["nf_id:"] },
        { name: "meta", types: ["channel"], idPrefixes: ["nf_id:"] },
      ],
      catalogs: [{ type: "channel", id: "Napflix", name: "Napflix" }],
    });
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/channel/Napflix.json",
        { status: 200, data: { metas: [{ id: "nf_id:1", type: "channel", name: "Siesta" }] } },
      ],
      [
        "/meta/channel/nf_id:1.json",
        { status: 200, data: { meta: { id: "nf_id:1", type: "channel", name: "Siesta" } } },
      ],
      [
        "/stream/channel/nf_id:1.json",
        { status: 200, data: { streams: [{ ytId: "abc", title: "Siesta" }] } },
      ],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.mode).toBe("content");
    expect(r.message).toContain("stream: channel 1 playable of 1");
  });

  it("looks in catalogs of any type for titles of a stream type when no catalog declares one (Adult Stremio Addon)", async () => {
    const m = addon({
      types: ["porn"],
      resources: [
        { name: "catalog", types: ["porn"] },
        { name: "stream", types: ["movie"], idPrefixes: ["asa:scene:"] },
      ],
      catalogs: [{ type: "porn", id: "recent", name: "Recent" }],
    });
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/porn/recent.json",
        { status: 200, data: { metas: [{ id: "asa:scene:1", type: "movie", name: "Scene" }] } },
      ],
      ["/stream/movie/asa:scene:1.json", { status: 200, data: { streams: [PLAYABLE] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.message).toContain("stream: movie 1 playable of 1");
  });

  it("labels a check by the title's own type, not its catalog's (Animee)", async () => {
    const m = addon({
      types: ["movie", "series"],
      idPrefixes: ["oa"],
      resources: ["catalog", "stream"],
      catalogs: [{ type: "series", id: "sort_ForYou", name: "For You" }],
    });
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/series/sort_ForYou.json",
        { status: 200, data: { metas: [{ id: "oa1", type: "movie", name: "A" }] } },
      ],
      ["/stream/movie/oa1.json", { status: 200, data: { streams: [PLAYABLE] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.perResource.find((p) => p.resource === "stream")?.summary).toBe(
      "movie 1 playable of 1",
    );
  });

  it("passes a catalog addon whose first catalog is empty when a later one has titles (Bharat Binge)", async () => {
    const m = addon({
      types: ["movie", "series"],
      resources: ["catalog", "meta"],
      catalogs: [
        { type: "movie", id: "flixpatrol-netflix-movies", name: "Netflix" },
        { type: "series", id: "provider-sonyliv-series", name: "SonyLIV" },
      ],
    });
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/catalog/movie/flixpatrol-netflix-movies.json", { status: 200, data: { metas: [] } }],
      [
        "/catalog/series/provider-sonyliv-series.json",
        { status: 200, data: { metas: [{ id: "tt1", type: "series", name: "S" }] } },
      ],
      [
        "/meta/series/tt1.json",
        { status: 200, data: { meta: { id: "tt1", type: "series", name: "S" } } },
      ],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.message).toContain("catalog: 1 metas");
  });

  it("retries an empty catalog once with an optional extra's first option, encoding extra names and types (ArabCinemeta)", async () => {
    const m = addon({
      types: ["DC Universe"],
      resources: ["catalog"],
      catalogs: [
        {
          type: "DC Universe",
          id: "elcinema-now",
          name: "Now",
          extra: [{ name: "skip" }, { name: "Saga Name", options: ["Egypt & Co", "Lebanon"] }],
        },
      ],
    });
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/DC%20Universe/elcinema-now/Saga%20Name=Egypt%20%26%20Co.json",
        { status: 200, data: { metas: [{ id: "x1", type: "movie", name: "X" }] } },
      ],
      ["/catalog/DC%20Universe/elcinema-now.json", { status: 200, data: { metas: [] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.perResource.find((p) => p.resource === "catalog")?.details).toContainEqual({
      label: "Also tried",
      value: "/catalog/DC%20Universe/elcinema-now.json · empty",
    });
  });
});

describe("probe several titles per type", () => {
  it("tries the next catalog titles until one has streams, showing every ID tried (Tubi Movies)", async () => {
    const m = addon({
      types: ["movie"],
      resources: ["catalog", "stream"],
      idPrefixes: ["tubi:"],
      catalogs: [{ type: "movie", id: "tubi-movies", name: "Tubi" }],
    });
    const ids = ["tubi:515934", "tubi:605225", "tubi:100065772", "tubi:401469"];
    let streamRequests = 0;
    const route = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/movie/tubi-movies.json",
        { status: 200, data: { metas: ids.map((id) => ({ id, type: "movie", name: id })) } },
      ],
      ["/stream/movie/tubi:100065772.json", { status: 200, data: { streams: [PLAYABLE] } }],
      ["/stream/movie/", { status: 200, data: { streams: [] } }],
    ]);
    router = (url) => {
      if (url.includes("/stream/")) streamRequests++;
      return route(url);
    };
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(streamRequests).toBe(3);
    const stream = r.detail.perResource.find((p) => p.resource === "stream");
    expect(stream?.summary).toBe("movie 1 playable of 1");
    expect(stream?.details).toEqual(
      expect.arrayContaining([
        { label: "Test ID", value: "tubi:100065772 (own catalog)" },
        { label: "Also tried", value: "/stream/movie/tubi:515934.json (own catalog) · no streams" },
        { label: "Also tried", value: "/stream/movie/tubi:605225.json (own catalog) · no streams" },
      ]),
    );
  });

  it("stops at three stream requests per type and says how many IDs it tried", async () => {
    const m = addon({
      types: ["movie"],
      resources: [{ name: "stream", types: ["movie"], idPrefixes: ["tt"] }],
    });
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.candidatesFor = async () =>
      ["tt1", "tt2", "tt3", "tt4"].map((id) => ({ type: "movie", id, source: "cinemeta" }));
    let streamRequests = 0;
    router = (url) => {
      if (url.includes("/stream/")) streamRequests++;
      return routes([
        ["/manifest.json", manifestOk(m.manifest)],
        ["/stream/movie/", { status: 200, data: { streams: [] } }],
      ])(url);
    };
    const r = await probe(m);
    expect(r.success).toBe(false);
    expect(streamRequests).toBe(3);
    expect(r.message).toBe("manifest up · stream: movie no streams (3 IDs)");
  });

  it("tries curated IDs, then its own titles, then borrowed ones", async () => {
    const m = addon({
      types: ["movie"],
      resources: ["catalog", { name: "stream", types: ["movie"], idPrefixes: ["tt"] }],
      catalogs: [{ type: "movie", id: "top", name: "Top" }],
    });
    overrides[m.uuid] = { name: "Test", testIds: [{ type: "movie", id: "tt-curated" }] };
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.candidatesFor = async () => [{ type: "movie", id: "tt-borrowed" }];
    const streams: string[] = [];
    const route = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/movie/top.json",
        { status: 200, data: { metas: [{ id: "tt-own", type: "movie", name: "Own" }] } },
      ],
      ["/stream/movie/tt-borrowed.json", { status: 200, data: { streams: [PLAYABLE] } }],
      ["/stream/movie/", { status: 200, data: { streams: [] } }],
    ]);
    router = (url) => {
      if (url.includes("/stream/")) streams.push(url.slice(url.lastIndexOf("/") + 1));
      return route(url);
    };
    try {
      const r = await probe(m);
      expect(r.success).toBe(true);
      expect(streams).toEqual(["tt-curated.json", "tt-own.json", "tt-borrowed.json"]);
    } finally {
      delete overrides[m.uuid];
    }
  });

  it("keeps at most two types' requests in flight", async () => {
    const m = addon({
      types: ["movie", "series", "anime"],
      resources: [
        { name: "stream", types: ["movie", "series", "anime"], idPrefixes: ["tt", "kitsu"] },
      ],
    });
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.candidatesFor = async () => [
      { type: "movie", id: "tt1" },
      { type: "movie", id: "tt3" },
      { type: "series", id: "tt2", episodeId: "tt2:1:1" },
      { type: "anime", id: "kitsu:1", episodeId: "kitsu:1:1" },
    ];
    let inFlight = 0;
    let most = 0;
    router = async (url) => {
      if (url.endsWith("/manifest.json")) return manifestOk(m.manifest);
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return { status: 200, data: { streams: [] } };
    };
    const r = await probe(m);
    expect(r.detail.perResource.find((p) => p.resource === "stream")?.summary).toBe(
      "movie no streams (2 IDs) · series no streams · anime no streams",
    );
    expect(most).toBe(2);
  });

  it("stops trying further IDs once two stream requests got no answer", async () => {
    const m = addon({
      types: ["movie"],
      resources: [{ name: "stream", types: ["movie"], idPrefixes: ["tt"] }],
    });
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.candidatesFor = async () =>
      ["tt1", "tt2", "tt3"].map((id) => ({ type: "movie", id }));
    let streamRequests = 0;
    router = (url) => {
      if (url.endsWith("/manifest.json")) return manifestOk(m.manifest);
      streamRequests++;
      throw new Error("timeout");
    };
    const r = await probe(m);
    expect(r.success).toBe(false);
    expect(streamRequests).toBe(2);
  });

  it("falls back to the last own title that worked when its catalog fails, before borrowing (Anixio)", async () => {
    const m = addon({
      types: ["series"],
      resources: [
        "catalog",
        { name: "meta", types: ["series"], idPrefixes: ["anixart"] },
        { name: "stream", types: ["series"], idPrefixes: ["anixart", "tt"] },
      ],
      catalogs: [{ type: "series", id: "anixart_popular", name: "Popular" }],
    });
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.candidatesFor = async () => [
      { type: "series", id: "tt2", episodeId: "tt2:1:1", source: "cinemeta" },
    ];
    const stream = { status: 200, data: { streams: [EPISODE] } };
    const meta: [string, RouteResult] = [
      "/meta/series/anixart:1.json",
      {
        status: 200,
        data: {
          meta: { id: "anixart:1", type: "series", name: "A", videos: [{ id: "anixart:1:1:1" }] },
        },
      },
    ];
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/series/anixart_popular.json",
        { status: 200, data: { metas: [{ id: "anixart:1", type: "series", name: "A" }] } },
      ],
      meta,
      ["/stream/series/anixart:1:1:1.json", stream],
    ]);
    expect((await probe(m)).success).toBe(true);

    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/catalog/series/anixart_popular.json", { status: 504, data: {} }],
      meta,
      ["/stream/series/anixart:1:1:1.json", stream],
      ["/stream/series/tt2:1:1.json", { status: 200, data: { streams: [] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.perResource.find((p) => p.resource === "stream")?.details).toContainEqual({
      label: "Test ID",
      value: "anixart:1:1:1 (own catalog, earlier cycle)",
    });
  });

  it("still sees a stream repeated across titles it tried for one type as a placeholder", async () => {
    const m = addon({
      types: ["movie", "series"],
      resources: [{ name: "stream", types: ["movie", "series"], idPrefixes: ["tt"] }],
    });
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.candidatesFor = async () => [
      { type: "movie", id: "tt1" },
      { type: "series", id: "tt2", episodeId: "tt2:1:1" },
    ];
    const card = { name: "Info", title: "Visit our site", url: "https://addon.test/info.mp4" };
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/stream/", { status: 200, data: { streams: [card] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(false);
  });
});

describe("probe catalog coverage", () => {
  it("checks the series catalog a catalog addon's movie catalog passed without (Cartoon Network)", async () => {
    const m = addon({
      types: ["movie", "series"],
      idPrefixes: ["tmdb"],
      resources: ["catalog"],
      catalogs: [
        { type: "movie", id: "cartoon_network_movie", name: "Cartoon Network" },
        { type: "series", id: "cartoon_network_series", name: "Cartoon Network" },
      ],
    });
    const series = Array.from({ length: 20 }, (_, i) => ({
      id: `tmdb:${15260 + i}`,
      type: "series",
      poster: "https://image.tmdb.org/t/p/w500/x.jpg",
    }));
    let movieRequests = 0;
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/movie/cartoon_network_movie.json",
        () => {
          movieRequests++;
          return {
            status: 200,
            data: {
              metas: [{ id: "tmdb:16000", type: "movie", name: "Ben 10: Race Against Time" }],
            },
          } as never;
        },
      ],
      ["/catalog/series/cartoon_network_series.json", { status: 200, data: { metas: series } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.perResource.map((p) => p.resource)).toEqual(["catalog", "catalogs"]);
    expect(r.detail.perResource[1]).toMatchObject({
      ok: false,
      summary: "1 of 2 OK · cartoon_network_series without name",
    });
    expect(movieRequests).toBe(1);
  });

  it("names a stream addon's broken sibling catalogs without changing its verdict (OnlyPorn)", async () => {
    const ids = ["eporner", "spankbang", "missav", "xhamster.hd+", "xhamster.4k"];
    const m = addon({
      types: ["movie"],
      resources: ["catalog", "stream"],
      catalogs: ids.map((id) => ({ type: "movie", id, name: id })),
    });
    const titled = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `ep:${i}`, type: "movie", name: `T${i}` }));
    const nameless = Array.from({ length: 39 }, (_, i) => ({ id: `xh:${i}`, type: "movie" }));
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/catalog/movie/eporner.json", { status: 200, data: { metas: titled(65) } }],
      ["/catalog/movie/spankbang.json", { status: 200, data: { metas: [] } }],
      ["/catalog/movie/missav.json", { status: 200, data: { metas: [] } }],
      [
        "/catalog/movie/xhamster.hd%2B.json",
        { status: 200, data: { metas: [...titled(12), ...nameless] } },
      ],
      ["/stream/movie/ep:0.json", { status: 200, data: { streams: [PLAYABLE] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.primary).toBe("stream");
    expect(r.detail.perResource.find((p) => p.resource === "catalogs")).toMatchObject({
      ok: false,
      summary: "1 of 4 OK · spankbang empty, missav empty, xhamster.hd+ without name",
    });
  });

  it("leaves search-only catalogs out", async () => {
    const m = addon({
      types: ["movie"],
      resources: ["catalog"],
      catalogs: [
        { type: "movie", id: "top", name: "Top" },
        {
          type: "movie",
          id: "search",
          name: "Search",
          extra: [{ name: "search", isRequired: true }],
        },
      ],
    });
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/movie/top.json",
        { status: 200, data: { metas: [{ id: "x:1", type: "movie", name: "X" }] } },
      ],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.perResource.map((p) => p.resource)).toEqual(["catalog"]);
  });
});

describe("probe addon catalogs", () => {
  /** stremio-addons.net's manifest, trimmed. */
  const listing = () =>
    addon({
      id: "community.stremio.stremio-addons-dot-net",
      types: ["movie", "series", "channel", "tv"],
      resources: ["addon_catalog"],
      catalogs: [],
      addonCatalogs: [{ type: "all", id: "stremio-addons.net", name: "stremio-addons.net" }],
    });
  const entry = {
    transportUrl: "https://brazuca.test/manifest.json",
    transportName: "http",
    manifest: { id: "community.brazuca-play", name: "Brazuca Play", version: "1.0.0" },
  };

  it("content-checks an addon whose only resource is addon_catalog (stremio-addons.net)", async () => {
    const m = listing();
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/addon_catalog/all/stremio-addons.net.json",
        { status: 200, data: { addons: Array.from({ length: 750 }, () => entry) } },
      ],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.mode).toBe("content");
    expect(r.detail.primary).toBe("addon_catalog");
    expect(r.message).toBe("addon_catalog: 750 addons");
    expect(requestOptions.get(`${BASE}/addon_catalog/all/stremio-addons.net.json`)).toMatchObject({
      retry: true,
    });
  });

  it("is DOWN when the addon catalog lists no addons", async () => {
    const m = listing();
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/addon_catalog/all/stremio-addons.net.json", { status: 200, data: { addons: [] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(false);
    expect(r.error).toBe("addon_catalog");
    expect(r.message).toBe("manifest up · addon_catalog: empty");
  });

  it("only annotates an addon catalog next to a primary resource", async () => {
    const m = addon({
      types: ["movie"],
      resources: ["catalog", "addon_catalog"],
      catalogs: [{ type: "movie", id: "top", name: "Top" }],
      addonCatalogs: [{ type: "all", id: "mine", name: "Mine" }],
    });
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/movie/top.json",
        { status: 200, data: { metas: [{ id: "x:1", type: "movie", name: "X" }] } },
      ],
      ["/addon_catalog/all/mine.json", { status: 404, data: undefined }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.primary).toBe("catalog");
    expect(r.detail.perResource.find((p) => p.resource === "addon_catalog")).toMatchObject({
      ok: false,
      summary: "HTTP 404",
    });
  });
});

describe("probe catalog order and notices per title", () => {
  it("alternates catalog sources, so one failing backend doesn't use up every try (Latanime)", async () => {
    const m = addon({
      types: ["series"],
      idPrefixes: ["latanime:", "av1:"],
      resources: ["catalog", "meta", "stream"],
      catalogs: [
        "latanime-latest",
        "latanime-airing",
        "latanime-directory",
        "animeav1-directory",
      ].map((id) => ({ type: "series", id, name: id })),
    });
    const catalogRequests: string[] = [];
    const route = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/catalog/series/latanime-", { status: 502, data: undefined }],
      [
        "/catalog/series/animeav1-directory.json",
        { status: 200, data: { metas: [{ id: "av1:1", type: "series", name: "A" }] } },
      ],
      [
        "/meta/series/av1:1.json",
        {
          status: 200,
          data: { meta: { id: "av1:1", type: "series", name: "A", videos: [{ id: "av1:1:1" }] } },
        },
      ],
      ["/stream/series/av1:1:1.json", { status: 200, data: { streams: [EPISODE] } }],
    ]);
    router = (url) => {
      if (url.includes("/catalog/")) catalogRequests.push(url.slice(BASE.length));
      return route(url);
    };
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(catalogRequests.slice(0, 2)).toEqual([
      "/catalog/series/latanime-latest.json",
      "/catalog/series/animeav1-directory.json",
    ]);
  });

  it("gives each extra stream type with a catalog of its own a probe, so tv channels are tried after sports events (FayaTV)", async () => {
    const m = addon({
      types: ["sports", "tv"],
      idPrefixes: ["faya"],
      resources: ["catalog", "stream"],
      catalogs: [
        { type: "sports", id: "live-and-upcoming", name: "Live" },
        { type: "tv", id: "tv_Sports", name: "Sports" },
      ],
    });
    const upsell = {
      name: "FayaTV",
      title: "✨ $3/Month • Go Premium",
      externalUrl: "https://payments.faya.test/packages",
    };
    const events = ["faya:se:6rEHzS", "faya:se:r0zxRq", "faya:se:nhKTVu", "faya:se:x4"];
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/sports/live-and-upcoming.json",
        {
          status: 200,
          data: { metas: events.map((id) => ({ id, type: "sports", name: `Event ${id}` })) },
        },
      ],
      [
        "/catalog/tv/tv_Sports.json",
        { status: 200, data: { metas: [{ id: "faya:H62UqG", type: "tv", name: "ESPN HD" }] } },
      ],
      ["/stream/sports/", { status: 200, data: { streams: [upsell] } }],
      [
        "/stream/tv/faya:H62UqG.json",
        {
          status: 200,
          data: { streams: [{ name: "ESPN HD", url: "http://iptv.test/espn/index.m3u8" }, upsell] },
        },
      ],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.mode).toBe("content");
    expect(r.detail.perResource.find((p) => p.resource === "stream")?.summary).toMatch(
      /tv 1 playable of 2/,
    );
  });

  it("tries the next title when one of its own answers a per-title paywall notice (StremVerse)", async () => {
    const m = addon({
      types: ["tv"],
      resources: ["catalog", "stream"],
      catalogs: [{ type: "tv", id: "stremverse_live_events", name: "Live" }],
    });
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/tv/stremverse_live_events.json",
        {
          status: 200,
          data: {
            metas: [
              { id: "ev:1", type: "tv", name: "Chapecoense vs Mirassol" },
              { id: "ev:2", type: "tv", name: "Atlético Madrid vs Bayern" },
            ],
          },
        },
      ],
      [
        "/stream/tv/ev:1.json",
        {
          status: 200,
          data: {
            streams: [
              {
                name: "That's it?",
                title: "Use Mediaflow proxy or Xtra subscription.",
                externalUrl: "https://stremverse.test/xtra",
              },
            ],
          },
        },
      ],
      ["/stream/tv/ev:2.json", { status: 200, data: { streams: [PLAYABLE] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.mode).toBe("content");
  });
});

describe("probe catalog titles as Stremio opens them", () => {
  it("streams a title without videos under its catalog ID even when its meta names itself differently (StremTV US)", async () => {
    const m = addon({
      types: ["tv"],
      idPrefixes: ["stremtv-us:"],
      resources: ["catalog", "meta", "stream"],
      catalogs: [{ type: "tv", id: "us-all", name: "US" }],
    });
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/tv/us-all.json",
        {
          status: 200,
          data: { metas: [{ id: "stremtv-us:00sReplay.us", type: "tv", name: "00s Replay" }] },
        },
      ],
      [
        "/meta/tv/stremtv-us:00sReplay.us.json",
        {
          status: 200,
          data: {
            meta: { id: "stremtv:00sReplay.us", type: "tv", name: "00s Replay", videos: [] },
          },
        },
      ],
      ["/stream/tv/stremtv-us:00sReplay.us.json", { status: 200, data: { streams: [PLAYABLE] } }],
    ]);
    const r = await probe(m);
    expect(r.detail.mode).toBe("content");
    expect(r.success).toBe(true);
  });

  it("takes only titles of a probed type from catalogs typed outside every stream type, listing each catalog once (Stremio Status)", async () => {
    const m = addon({
      types: ["tv", "movie", "series"],
      resources: ["catalog", "stream"],
      catalogs: [{ type: "other", id: "addon-status", name: "Status" }],
    });
    idsourcesMock.hasSourceFor = () => true;
    const streams: string[] = [];
    const route = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/other/addon-status.json",
        {
          status: 200,
          data: { metas: [{ id: "stremio-status:torrentio", type: "tv", name: "Torrentio" }] },
        },
      ],
      ["/stream/tv/stremio-status:torrentio.json", { status: 200, data: { streams: [PLAYABLE] } }],
    ]);
    router = (url) => {
      if (url.includes("/stream/")) streams.push(url.slice(BASE.length));
      return route(url);
    };
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(streams).toEqual(["/stream/tv/stremio-status:torrentio.json"]);
    expect(r.detail.perResource.find((p) => p.resource === "catalog")?.summary).toBe(
      "other 1 metas",
    );
  });
});

describe("probe transport", () => {
  const scraperAddon = () =>
    addon({
      types: ["movie"],
      resources: [{ name: "stream", types: ["movie"], idPrefixes: ["tt"] }],
    });
  const catalogAddon = () =>
    addon({
      types: ["movie"],
      resources: ["catalog"],
      catalogs: [{ type: "movie", id: "top", name: "Top" }],
    });
  const borrowMovie = () => {
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.candidatesFor = async () => [{ type: "movie", id: "tt0111161" }];
  };
  const STREAM_URL = `${BASE}/stream/movie/tt0111161.json`;
  const attempt = (route: Route, status: number, durationMs = 1): Attempt => ({
    route,
    status,
    durationMs,
  });

  /** Answers like getJson: a WARP answer the caller finds unusable sends the request direct too, and a usable direct answer wins. */
  const overRoutes =
    (warp: RouteResult, direct: RouteResult) =>
    (_url: string, { usable }: GetJsonOptions<unknown>): RouteResult => {
      const tried = [attempt("WARP", warp.status)];
      if (!usable || usable(warp.data)) return { ...warp, attempts: tried };
      tried.push(attempt("direct", direct.status));
      return usable(direct.data)
        ? { ...direct, attempts: tried, softBlockedOn: "WARP" }
        : { ...direct, attempts: tried };
    };

  const timeouts = (ms: number) =>
    new RequestFailedError(`timed out after ${ms}ms`, [
      { route: "WARP", error: `timed out after ${ms}ms`, timedOut: true, durationMs: ms },
      { route: "direct", error: `timed out after ${ms}ms`, timedOut: true, durationMs: ms },
      { route: "direct", error: `timed out after ${ms}ms`, timedOut: true, durationMs: ms },
    ]);

  it("retries the manifest request", async () => {
    const m = scraperAddon();
    borrowMovie();
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/stream/movie/tt0111161.json", { status: 200, data: { streams: [PLAYABLE] } }],
    ]);
    await probe(m);
    expect(requestOptions.get(`${BASE}/manifest.json`)).toEqual({
      retry: true,
      headers: { Origin: "https://web.stremio.com" },
    });
  });

  it("reports a manifest rate limited on every try as rate limited (Torrentio instance)", async () => {
    const m = scraperAddon();
    router = routes([
      [
        "/manifest.json",
        {
          status: 429,
          data: undefined,
          attempts: [
            attempt("WARP", 429),
            attempt("WARP", 429),
            attempt("direct", 429),
            attempt("direct", 429),
          ],
        },
      ],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(false);
    expect(r.detail.livenessError).toBe("unreachable (rate limited)");
    expect(r.detail.manifestDetails).toContainEqual({
      label: "Reason",
      value: "addon responded with HTTP 429 (rate limited)",
    });
  });

  it("reports a manifest that timed out on every try as timed out, listing each try (AIO Substitle)", async () => {
    const m = scraperAddon();
    router = routes([
      [
        "/manifest.json",
        () => {
          throw timeouts(15000);
        },
      ],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(false);
    expect(r.detail.livenessError).toBe("timed out");
    expect(r.detail.manifestDetails.filter((d) => d.label === "Attempt")).toHaveLength(3);
    expect(r.detail.manifestDetails).toContainEqual({
      label: "Reason",
      value: "timed out after 15000ms",
    });
  });

  it("keeps the transport error for a manifest that was refused", async () => {
    const m = scraperAddon();
    router = routes([
      [
        "/manifest.json",
        () => {
          throw new RequestFailedError("fetch failed (ECONNREFUSED)", [
            { route: "direct", error: "fetch failed (ECONNREFUSED)", durationMs: 1 },
          ]);
        },
      ],
    ]);
    const r = await probe(m);
    expect(r.detail.livenessError).toBe("unreachable (fetch failed (ECONNREFUSED))");
  });

  it("is UP when WARP's stream answer is empty but direct's is playable, listing both attempts (yastream)", async () => {
    const m = scraperAddon();
    borrowMovie();
    const route = routes([["/manifest.json", manifestOk(m.manifest)]]);
    const stream = overRoutes(
      { status: 200, data: { streams: [] } },
      { status: 200, data: { streams: [PLAYABLE] } },
    );
    router = (url, options) => (url === STREAM_URL ? stream(url, options) : route(url));
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.mode).toBe("content");
    const details = r.detail.perResource.find((p) => p.resource === "stream")?.details;
    expect(details).toContainEqual({ label: "Attempt", value: "WARP · HTTP 200 · 1ms" });
    expect(details).toContainEqual({ label: "Attempt", value: "direct · HTTP 200 · 1ms" });
    expect(details).toContainEqual({ label: "Note", value: "soft-blocked on WARP" });
    expect(requestOptions.get(STREAM_URL)?.retry).toBe(true);
  });

  it("counts only playable streams as a usable stream answer", async () => {
    const m = scraperAddon();
    borrowMovie();
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/stream/movie/tt0111161.json", { status: 200, data: { streams: [PLAYABLE] } }],
    ]);
    await probe(m);
    const usable = requestOptions.get(STREAM_URL)?.usable;
    expect(usable?.({ streams: [PLAYABLE] })).toBe(true);
    expect(usable?.({ streams: [] })).toBe(false);
    expect(usable?.({ streams: [{ externalUrl: "https://www.imdb.com/title/tt0111161/" }] })).toBe(
      false,
    );
    expect(
      usable?.({
        streams: [
          {
            name: "[❌] Comet",
            description: "⚠️ OBSOLETE CONFIGURATION, PLEASE RE-CONFIGURE ON https://comet.test ⚠️",
            url: "https://comet.test/placeholder",
          },
        ],
      }),
    ).toBe(false);
    expect(usable?.(null)).toBe(false);
  });

  it("is UP when WARP's catalog answer is empty but direct's has titles (SosacTV2)", async () => {
    const m = catalogAddon();
    const route = routes([["/manifest.json", manifestOk(m.manifest)]]);
    const catalog = overRoutes(
      { status: 200, data: { metas: [] } },
      { status: 200, data: { metas: [{ id: "x1", type: "movie", name: "One" }] } },
    );
    router = (url, options) => (url.includes("/catalog/") ? catalog(url, options) : route(url));
    const r = await probe(m);
    expect(r.success).toBe(true);
    const details = r.detail.perResource.find((p) => p.resource === "catalog")?.details;
    expect(details).toContainEqual({ label: "Note", value: "soft-blocked on WARP" });
    const usable = requestOptions.get(`${BASE}/catalog/movie/top.json`)?.usable;
    expect(usable?.({ metas: [{ id: "x1", type: "movie", name: "One" }] })).toBe(true);
    expect(
      usable?.({
        metas: [
          { id: "pictorium:notice:missing-tmdb-key", type: "movie", name: "Chiave TMDB richiesta" },
        ],
      }),
    ).toBe(false);
    expect(usable?.({ metas: [{ id: "x1", type: "movie" }] })).toBe(true);
    expect(usable?.({ metas: [{ id: "x1", name: "One" }] })).toBe(false);
  });

  it("retries only the requests that decide the verdict", async () => {
    const m = addon({
      types: ["movie"],
      resources: [
        "catalog",
        { name: "meta", types: ["movie"], idPrefixes: ["tt"] },
        { name: "stream", types: ["movie"], idPrefixes: ["tt"] },
        { name: "subtitles", types: ["movie"], idPrefixes: ["tt"] },
      ],
      catalogs: [{ type: "movie", id: "top", name: "Top" }],
    });
    idsourcesMock.hasSourceFor = () => true;
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/catalog/movie/top.json", { status: 200, data: { metas: [] } }],
      [
        "/meta/movie/tt0111161.json",
        { status: 200, data: { meta: { id: "tt0111161", type: "movie", name: "x" } } },
      ],
      ["/stream/movie/tt0111161.json", { status: 200, data: { streams: [PLAYABLE] } }],
      ["/subtitles/", { status: 200, data: { subtitles: [] } }],
    ]);
    borrowMovie();
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(requestOptions.get(STREAM_URL)?.retry).toBe(true);
    for (const [url, options] of requestOptions) {
      if (url.includes("/catalog/") || url.includes("/meta/")) {
        expect(options, url).toEqual({});
      }
      if (url.includes("/subtitles/")) expect(options.retry, url).toBe(false);
    }
  });

  it("reports a stream request rate limited on every route as rate limited", async () => {
    const m = scraperAddon();
    borrowMovie();
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/stream/movie/tt0111161.json", { status: 429, data: undefined }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(false);
    expect(r.detail.perResource.find((p) => p.resource === "stream")?.summary).toBe(
      "movie rate limited",
    );
  });

  it("reports a stream request that timed out on every try as timed out (Hellspy)", async () => {
    const m = scraperAddon();
    borrowMovie();
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/stream/movie/tt0111161.json",
        () => {
          throw timeouts(30000);
        },
      ],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(false);
    const stream = r.detail.perResource.find((p) => p.resource === "stream");
    expect(stream?.summary).toBe("movie timed out");
    expect(stream?.details).toContainEqual({ label: "Reason", value: "timed out after 30000ms" });
  });

  it("stops retrying stream requests once one timed out, so a hanging addon costs at most one retry (Hellspy)", async () => {
    const m = scraperAddon();
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.candidatesFor = async () =>
      ["tt1", "tt2", "tt3"].map((id) => ({ type: "movie", id }));
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/stream/",
        () => {
          throw timeouts(30000);
        },
      ],
    ]);
    await probe(m);
    expect(requestOptions.get(`${BASE}/stream/movie/tt1.json`)?.retry).toBe(true);
    expect(requestOptions.get(`${BASE}/stream/movie/tt2.json`)?.retry).toBe(false);
    expect(requestOptions.has(`${BASE}/stream/movie/tt3.json`)).toBe(false);
  });

  it("stops retrying stream requests once one timed out on a route, even when another route answered", async () => {
    const m = scraperAddon();
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.candidatesFor = async () => ["tt1", "tt2"].map((id) => ({ type: "movie", id }));
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/stream/",
        {
          status: 403,
          data: undefined,
          attempts: [
            attempt("WARP", 403),
            {
              route: "direct",
              error: "timed out after 30000ms",
              timedOut: true,
              durationMs: 30000,
            },
          ],
        },
      ],
    ]);
    await probe(m);
    expect(requestOptions.get(`${BASE}/stream/movie/tt1.json`)?.retry).toBe(true);
    expect(requestOptions.get(`${BASE}/stream/movie/tt2.json`)?.retry).toBe(false);
  });

  it("shows the addon's own JSON error in the reason row (Ruído)", async () => {
    const m = addon({
      types: ["series"],
      resources: [{ name: "stream", types: ["series"], idPrefixes: ["tt"] }],
    });
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.candidatesFor = async () => [
      { type: "series", id: "tt36601237", episodeId: "tt36601237:1:1" },
    ];
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/stream/series/tt36601237:1:1.json",
        {
          status: 503,
          data: {
            error: "SOURCE_UNAVAILABLE",
            message: "Não foi possível obter vídeo da fonte. Tenta novamente mais tarde.",
          },
        },
      ],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(false);
    const stream = r.detail.perResource.find((p) => p.resource === "stream");
    expect(stream?.summary).toBe("series HTTP 503");
    expect(stream?.details).toContainEqual({
      label: "Reason",
      value: expect.stringMatching(
        /^addon responded with HTTP 503: SOURCE_UNAVAILABLE: Não foi possível obter vídeo/,
      ),
    });
  });

  it("marks a content UP whose deciding request took over 10 s as slow, without changing the verdict", async () => {
    const m = scraperAddon();
    borrowMovie();
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/stream/movie/tt0111161.json",
        {
          status: 200,
          data: { streams: [PLAYABLE] },
          attempts: [attempt("WARP", 503, 20), attempt("direct", 200, 14_200)],
        },
      ],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.mode).toBe("content");
    const stream = r.detail.perResource.find((p) => p.resource === "stream");
    expect(stream?.summary).toBe("movie 1 playable of 1 · slow (14 s)");
    expect(stream?.details).toContainEqual({
      label: "Slow",
      value: "/stream/movie/tt0111161.json answered in 14.2 s",
    });
  });

  it("does not mark a fast content UP or a DOWN as slow", async () => {
    const m = scraperAddon();
    borrowMovie();
    const answer = (streams: unknown[], durationMs: number): RouteResult => ({
      status: 200,
      data: { streams },
      attempts: [attempt("WARP", 200, durationMs)],
    });
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/stream/movie/tt0111161.json", answer([PLAYABLE], 9_000)],
    ]);
    const fast = await probe(m);
    expect(fast.success).toBe(true);
    expect(fast.message).not.toContain("slow");

    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/stream/movie/tt0111161.json", answer([], 20_000)],
    ]);
    const down = await probe(m);
    expect(down.success).toBe(false);
    expect(down.message).not.toContain("slow");
  });

  it("marks a slow catalog-primary UP as slow", async () => {
    const m = catalogAddon();
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/movie/top.json",
        {
          status: 200,
          data: { metas: [{ id: "x1", type: "movie", name: "One" }] },
          attempts: [attempt("WARP", 200, 17_000)],
        },
      ],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.perResource.find((p) => p.resource === "catalog")?.summary).toBe(
      "1 metas · slow (17 s)",
    );
  });
});

describe("probe CORS", () => {
  const scraper = () => {
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.candidatesFor = async () => [{ type: "movie", id: "tt0111161" }];
    return addon({
      types: ["movie"],
      resources: [{ name: "stream", types: ["movie"], idPrefixes: ["tt"] }],
    });
  };

  it("annotates a manifest Stremio Web can't read without changing the verdict (Cinemata Remover)", async () => {
    const m = scraper();
    router = routes([
      ["/manifest.json", { status: 200, data: m.manifest }],
      ["/stream/movie/tt0111161.json", { status: 200, data: { streams: [PLAYABLE] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.primary).toBe("stream");
    expect(r.detail.perResource.find((x) => x.resource === "cors")).toMatchObject({
      ok: false,
      summary: "missing, fails in Stremio Web",
    });
  });

  it("annotates an addon that needs configuration too (Cast List)", async () => {
    const m = addon({
      types: ["movie"],
      resources: ["stream"],
      behaviorHints: { configurable: true, configurationRequired: true },
    });
    router = routes([["/manifest.json", { status: 200, data: m.manifest }]]);
    const r = await probe(m);
    expect(r.detail.mode).toBe("needs-config");
    expect(r.detail.perResource.map((x) => x.resource)).toEqual(["cors"]);
  });

  it("says nothing when the manifest allows Stremio Web's origin", async () => {
    const m = scraper();
    router = routes([
      ["/manifest.json", { status: 200, data: m.manifest, allowOrigin: "https://web.stremio.com" }],
      ["/stream/movie/tt0111161.json", { status: 200, data: { streams: [PLAYABLE] } }],
    ]);
    const r = await probe(m);
    expect(r.detail.perResource.map((x) => x.resource)).not.toContain("cors");
  });
});

describe("probe stream URL checks", () => {
  /** A live-TV addon whose own catalog lists `channels`, each answering `streamsOf(id)`. */
  async function probeTv(
    channels: string[],
    streamsOf: (id: string) => unknown[],
    extra: Array<[string, RouteResult]> = [],
  ) {
    const m = addon({
      types: ["tv"],
      resources: ["catalog", "stream"],
      catalogs: [{ type: "tv", id: "channels", name: "Channels" }],
    });
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/tv/channels.json",
        { status: 200, data: { metas: channels.map((id) => ({ id, type: "tv", name: id })) } },
      ],
      ...extra,
      ...channels.map((id): [string, RouteResult] => [
        `/stream/tv/${id}.json`,
        { status: 200, data: { streams: streamsOf(id) } },
      ]),
    ]);
    return probe(m);
  }

  const streamOf = (r: Awaited<ReturnType<typeof probe>>) =>
    r.detail.perResource.find((p) => p.resource === "stream");
  const verdictOf =
    (verdicts: Record<string, Omit<UrlCheck, "host">>) =>
    async (u: UrlToCheck): Promise<UrlCheck> => ({
      host: new URL(u.url).hostname,
      ...(verdicts[new URL(u.url).hostname] ?? { verdict: "playable", outcome: "HTTP 206" }),
    });
  const NXDOMAIN = { verdict: "dead", outcome: "NXDOMAIN" } as const;
  const GEO = { verdict: "unverifiable", outcome: "HTTP 403 text/html, blocked" } as const;

  it("is DOWN when every checked stream URL is dead, naming hosts but never the URL (FTV Channels)", async () => {
    const checked: UrlToCheck[] = [];
    urlcheckMock.checkUrl = async (u) => {
      checked.push(u);
      return verdictOf({ "fash1.erosnow.test": NXDOMAIN })(u);
    };
    const hls = (id: string, q: string) => ({
      name: "FTV Paris",
      title: q,
      url: `https://fash1.erosnow.test/slive/${id}_${q}/chunklist.m3u8?token=secret`,
    });
    const r = await probeTv(["ftv_paris", "ftv_midnight"], (id) =>
      ["1080p", "720p", "480p"].map((q) => hls(id, q)),
    );
    expect(r.success).toBe(false);
    expect(r.error).toBe("stream");
    expect(streamOf(r)?.summary).toBe("tv 2 of 2 URLs dead (2 IDs)");
    expect(r.detail.streamCounts?.playable).toBe(0);
    expect(streamOf(r)?.details).toContainEqual({
      label: "Reason",
      value:
        "no checked stream URL plays: fash1.erosnow.test NXDOMAIN; fash1.erosnow.test NXDOMAIN",
    });
    expect(streamOf(r)?.details).toContainEqual({
      label: "URL check",
      value: "2 dead of 2 · fash1.erosnow.test: NXDOMAIN; fash1.erosnow.test: NXDOMAIN",
    });
    // Only the first two URLs of each title, and a second title before giving up.
    expect(checked).toHaveLength(4);
    expect(JSON.stringify(r)).not.toContain("secret");
  });

  it("tries another title when one title's URLs are dead, and passes on one that plays (a removed file)", async () => {
    urlcheckMock.checkUrl = verdictOf({ "gone.test": { verdict: "dead", outcome: "HTTP 404" } });
    const r = await probeTv(["a", "b"], (id) => [
      { title: id, url: `https://${id === "a" ? "gone" : "cdn"}.test/${id}.m3u8` },
    ]);
    expect(r.success).toBe(true);
    expect(streamOf(r)?.summary).toBe("tv 1 playable of 1");
    expect(streamOf(r)?.details).toContainEqual({
      label: "URL check",
      value: "1 playable of 1 · cdn.test: HTTP 206",
    });
  });

  it("stays UP when the checked URL is geo-blocked or rate limited, which may play elsewhere (Israeli TV)", async () => {
    urlcheckMock.checkUrl = verdictOf({ "cloudfront.test": GEO });
    const r = await probeTv(["iltv_5goldil"], () => [
      { title: "5Gold", url: "https://cloudfront.test/live/playlist.m3u8" },
    ]);
    expect(r.success).toBe(true);
    expect(streamOf(r)?.summary).toBe("tv 1 stream, URLs unverifiable");
    expect(streamOf(r)?.details).toContainEqual({
      label: "URL check",
      value: "1 unverifiable of 1 · cloudfront.test: HTTP 403 text/html, blocked",
    });
  });

  it("says when the deciding target's checked URLs are all unverifiable, keeping it UP (Tvvio)", async () => {
    urlcheckMock.checkUrl = verdictOf({ "d1.cdn10embed.test": GEO, "d2.cdn10embed.test": GEO });
    const r = await probeTv(["ec:aee"], () => [
      { name: "A&E (direto)", url: "https://d1.cdn10embed.test/aee/index.m3u8" },
      { name: "A&E (direto)", url: "https://d2.cdn10embed.test/aee/index.m3u8" },
      { name: "A&E (relay)", url: "https://relay.test/aee/index.m3u8" },
    ]);
    expect(r.success).toBe(true);
    expect(r.detail.mode).toBe("content");
    expect(streamOf(r)?.summary).toBe("tv 3 streams, URLs unverifiable");
    expect(r.detail.streamCounts).toEqual({ total: 3, playable: 3, links: 0 });
  });

  it("keeps the playable count when one checked URL plays beside an unverifiable one", async () => {
    urlcheckMock.checkUrl = verdictOf({ "cdn.test": GEO });
    const r = await probeTv(["a"], () => [
      { name: "A", url: "https://cdn.test/a.m3u8" },
      { name: "B", url: "https://plays.test/b.m3u8" },
    ]);
    expect(streamOf(r)?.summary).toBe("tv 2 playable of 2");
  });

  it("passes an informational addon whose stream URLs all open web pages as a link addon (Stremio Stinger)", async () => {
    urlcheckMock.checkUrl = async (u) => ({
      host: new URL(u.url).hostname,
      verdict: "webpage",
      outcome: "HTTP 200 text/html, web page",
    });
    const r = await probeTv(["a"], () => [
      { name: "🍿 Mid & Post-Credits Scenes", url: "https://aftercredits.test/2019/04/a/" },
    ]);
    expect(r.success).toBe(true);
    expect(streamOf(r)?.summary).toBe("tv 1 of 1 URLs web pages");
    expect(streamOf(r)?.details).toContainEqual({
      label: "Note",
      value: "link addon: links only, not content-checked",
    });
  });

  it("is DOWN when stream URLs are web pages beside a dead host (StreamPlay's embeds)", async () => {
    urlcheckMock.checkUrl = verdictOf({
      "vidlink.test": { verdict: "webpage", outcome: "HTTP 200 text/html, web page" },
      "vidsrc.test": NXDOMAIN,
    });
    const r = await probeTv(["a", "b"], (id) => [
      { name: "Vidlink", url: `https://vidlink.test/movie/${id}` },
      { name: "Vidsrc", url: `https://vidsrc.test/embed/movie/${id}` },
    ]);
    expect(r.success).toBe(false);
    expect(streamOf(r)?.summary).toBe("tv no URL plays (2 IDs)");
  });

  it("does not check torrents or debrid links, which a dead URL beside them couldn't fail", async () => {
    let calls = 0;
    urlcheckMock.checkUrl = async (u) => {
      calls++;
      return { host: new URL(u.url).hostname, ...NXDOMAIN };
    };
    const r = await probeTv(["a"], () => [
      { title: "web", url: "https://gone.test/a.mp4" },
      { title: "torrent", infoHash: "a".repeat(40) },
    ]);
    expect(r.success).toBe(true);
    expect(calls).toBe(0);
  });

  it("is DOWN when playable streams are dead, even with links beside them (Ultrapelis)", async () => {
    urlcheckMock.checkUrl = verdictOf({
      "archive.test": { verdict: "dead", outcome: "HTTP 403 text/html, gone" },
    });
    const m = addon({
      types: ["movie", "series"],
      resources: [{ name: "stream", types: ["movie", "series"], idPrefixes: ["tt"] }],
    });
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.candidatesFor = async () => [
      { type: "movie", id: "tt0111161" },
      { type: "series", id: "tt0903747", episodeId: "tt0903747:1:1" },
    ];
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/stream/movie/tt0111161.json",
        {
          status: 200,
          data: {
            streams: [{ name: "Servidor principal", externalUrl: "https://vimeos.test/e/1" }],
          },
        },
      ],
      [
        "/stream/series/tt0903747:1:1.json",
        {
          status: 200,
          data: {
            streams: [
              { name: "Servidor alterno", externalUrl: "https://myvidplay.test/e/2" },
              { name: "Archive", url: "https://archive.test/serve/item/e1.mp4" },
            ],
          },
        },
      ],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(false);
    expect(streamOf(r)?.summary).toBe("movie 0 playable, 1 link of 1 · series 1 of 1 URLs dead");
  });

  describe("negative control", () => {
    const embeds = (kind: string, id: string) => [
      { name: "[StreamPlay] Vidlink 1080p", url: `https://vidlink.test/${kind}/${id}` },
      { name: "[StreamPlay] Server Vidsrc", url: `https://vidsrc.test/embed/${kind}/${id}` },
      { name: "[StreamPlay] AutoEmbed Fast", url: `https://autoembed.test/embed/${kind}/${id}` },
    ];
    /** A catalog-less addon answering every `tt` ID with `streamsOf`, the nonexistent one included. */
    async function probeTemplated(streamsOf: (type: string, id: string) => unknown[] | undefined) {
      const m = addon({
        types: ["movie", "series"],
        resources: [{ name: "stream", types: ["movie", "series"], idPrefixes: ["tt"] }],
      });
      idsourcesMock.hasSourceFor = () => true;
      idsourcesMock.candidatesFor = async () => [
        { type: "movie", id: "tt0111161" },
        { type: "series", id: "tt0903747", episodeId: "tt0903747:1:1" },
      ];
      const asked: string[] = [];
      router = (url) => {
        if (url.endsWith("/manifest.json")) return manifestOk(m.manifest);
        const match = /\/stream\/(\w+)\/([^/]+)\.json$/.exec(url);
        if (!match) throw new Error(`no route for ${url}`);
        asked.push(match[2]);
        const streams = streamsOf(match[1], match[2]);
        return streams ? { status: 200, data: { streams } } : { status: 404, data: undefined };
      };
      return { r: await probe(m), asked };
    }

    it("is DOWN when an addon answers a nonexistent ID with stream URLs and none of them plays (StreamPlay)", async () => {
      urlcheckMock.checkUrl = verdictOf({
        "vidlink.test": GEO,
        "vidsrc.test": { verdict: "unverifiable", outcome: "timed out" },
      });
      const { r, asked } = await probeTemplated((type, id) =>
        embeds(type === "series" ? "tv" : "movie", id),
      );
      expect(asked.filter((id) => id.startsWith("tt9999999999"))).toEqual(["tt9999999999"]);
      expect(r.success).toBe(false);
      expect(streamOf(r)?.summary).toBe(
        "movie templated, no URL plays · series templated, no URL plays",
      );
      expect(streamOf(r)?.details).toContainEqual({
        label: "Note",
        value: "templated: the nonexistent tt9999999999 gets 3 streams too",
      });
    });

    it("passes a templating addon whose checked URL plays", async () => {
      urlcheckMock.checkUrl = verdictOf({ "vidsrc.test": GEO });
      const { r } = await probeTemplated((type, id) => embeds(type, id));
      expect(r.success).toBe(true);
    });

    it("trusts unverifiable URLs of an addon that answers nothing for a nonexistent ID", async () => {
      urlcheckMock.checkUrl = verdictOf({ "vidlink.test": GEO, "vidsrc.test": GEO });
      const { r, asked } = await probeTemplated((type, id) =>
        id.startsWith("tt9999999999") ? [] : embeds(type, id),
      );
      expect(asked).toContain("tt9999999999");
      expect(r.success).toBe(true);
    });

    it("does not take a static card the real title got too for a template (Flix-Streams upsell)", async () => {
      urlcheckMock.checkUrl = verdictOf({ "vidlink.test": GEO, "vidsrc.test": GEO });
      const upsell = {
        name: "FlixNest",
        title: "Need more sources? Open Flix-Streams",
        externalUrl: "https://flix.test/",
      };
      const { r } = await probeTemplated((type, id) =>
        id.startsWith("tt9999999999") ? [upsell] : [...embeds(type, id), upsell],
      );
      expect(r.success).toBe(true);
    });

    it("does not take a lookup-failure card for a nonexistent ID as a template (Sensitivity Notes)", async () => {
      let opened = 0;
      urlcheckMock.followLink = async (url) => {
        opened++;
        return { host: new URL(url).hostname, status: 403, label: "Just a moment..." };
      };
      const { r, asked } = await probeTemplated((_type, id) =>
        id.startsWith("tt9999999999")
          ? [
              {
                name: "⚠ Sensitivity Notes",
                description: "Could not reach DoesTheDogDie right now — tap to open the site.",
                externalUrl: "https://www.doesthedogdie.test",
              },
            ]
          : [
              {
                name: "⚠ Sensitivity Notes · 20 flags",
                description: `a dog dies · ${id}`,
                externalUrl: `https://www.doesthedogdie.test/media/${id}`,
              },
            ],
      );
      expect(asked).toContain("tt9999999999");
      expect(r.success).toBe(true);
      expect(opened).toBe(0);
      expect(streamOf(r)?.details).not.toContainEqual(
        expect.objectContaining({ value: expect.stringMatching(/^templated/) }),
      );
    });

    it("annotates templated links, and opens one to read what its page says (MoviesInDetail)", async () => {
      const opened: string[] = [];
      urlcheckMock.followLink = async (url) => {
        opened.push(url);
        return {
          host: "moviesindetail.test",
          status: 200,
          label: "Movies in Detail – One place for trailers, images, soundtracks & reviews",
        };
      };
      const { r } = await probeTemplated((_type, id) => [
        {
          name: "MoviesInDetail",
          title: `Open ${id} in MoviesInDetail`,
          externalUrl: `https://moviesindetail.test/?q=${id}`,
        },
      ]);
      expect(r.success).toBe(true);
      expect(r.detail.mode).toBe("content");
      expect(opened).toHaveLength(3);
      expect(streamOf(r)?.summary).toBe(
        "movie 0 playable, 1 link of 1 · series 0 playable, 1 link of 1 · templated links",
      );
      expect(streamOf(r)?.details).toContainEqual({
        label: "Note",
        value: "link addon: templated links (not content-checked)",
      });
      expect(streamOf(r)?.details).toContainEqual({
        label: "Link check",
        value:
          "moviesindetail.test · HTTP 200 · Movies in Detail – One place for trailers, images, soundtracks & reviews",
      });
    });

    it("reports a templated link whose page asks for an API key as needing configuration (Content Deep Dive Companion)", async () => {
      // A popular title's deep dive is cached, so only the other title's page asks for a key.
      urlcheckMock.followLink = async (url) =>
        url.includes("tt0111161")
          ? { host: "deepdive.test", status: 200, label: "Deep Dive: The Shawshank Redemption" }
          : {
              host: "deepdive.test",
              status: 200,
              label: "API Key Required - Content Deep Dive",
              placeholder: "needs-config",
            };
      const { r } = await probeTemplated((_type, id) => [
        {
          name: "🔍 Deep Dive Analysis",
          description: "Open detailed content analysis in browser",
          externalUrl: `https://deepdive.test/deep_dive/${id}`,
        },
      ]);
      expect(r.success).toBe(true);
      expect(r.detail.mode).toBe("needs-config");
      expect(r.detail.configReason).toBe("API Key Required - Content Deep Dive");
    });

    it("reads the nonexistent ID's link page too, so cached pages of popular titles can't hide an API key notice (Content Deep Dive Companion)", async () => {
      const opened: string[] = [];
      urlcheckMock.followLink = async (url) => {
        opened.push(url);
        return url.includes("tt9999999999")
          ? {
              host: "deepdive.test",
              status: 200,
              label: "API Key Required - Content Deep Dive",
              placeholder: "needs-config",
            }
          : { host: "deepdive.test", status: 200, label: "Deep Dive: a cached title" };
      };
      const { r } = await probeTemplated((_type, id) => [
        {
          name: "🔍 Deep Dive Analysis",
          description: "Open detailed content analysis in browser",
          externalUrl: `https://deepdive.test/deep_dive/${id}`,
        },
      ]);
      expect(r.success).toBe(true);
      expect(r.detail.mode).toBe("needs-config");
      expect(r.detail.configReason).toBe("API Key Required - Content Deep Dive");
      expect(opened.filter((u) => u.includes("tt9999999999"))).toHaveLength(1);
    });

    it("does not open the links of an addon that answers nothing for a nonexistent ID (IMDb ratings)", async () => {
      let opened = 0;
      urlcheckMock.followLink = async (url) => {
        opened++;
        return { host: new URL(url).hostname, status: 200 };
      };
      const { r } = await probeTemplated((_type, id) =>
        id.startsWith("tt9999999999")
          ? undefined
          : [{ name: "IMDb Rating", externalUrl: `https://imdb.test/title/${id}/` }],
      );
      expect(r.success).toBe(true);
      expect(opened).toBe(0);
    });
  });
});

describe("probe subtitles-only addons", () => {
  afterEach(() => {
    for (const uuid of Object.keys(overrides)) delete overrides[uuid];
  });

  const subtitlesAddon = (manifest: Partial<Manifest> = {}) =>
    addon({
      types: ["movie", "series"],
      resources: [{ name: "subtitles", types: ["movie", "series"], idPrefixes: ["tt"] }],
      ...manifest,
    });
  const SRT = [
    "1\n00:00:01,000 --> 00:00:02,000\nWe need to go deeper.\n",
    "2\n00:00:03,000 --> 00:00:04,000\nAn idea is like a virus.\n",
  ].join("\n");

  it("content-checks a subtitles-only addon with borrowed titles and a file name (Napisy24)", async () => {
    const m = subtitlesAddon({
      resources: [{ name: "subtitles", types: ["movie", "series"] }],
    } as Partial<Manifest>);
    idsourcesMock.candidatesFor = async () => [
      { type: "movie", id: "tt1375666", source: "well-known" },
    ];
    subtitleFiles.set("https://subs.test/1.srt", SRT);
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/meta/movie/tt1375666.json",
        { status: 200, data: { meta: { name: "Inception", year: "2010" } } },
      ],
      [
        "/subtitles/movie/tt1375666/filename=Inception.2010.1080p.WEB-DL.mkv.json",
        {
          status: 200,
          data: { subtitles: [{ id: "1", lang: "pol", url: "https://subs.test/1.srt" }] },
        },
      ],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.mode).toBe("content");
    expect(r.detail.primary).toBe("subtitles");
    expect(r.message).toBe("subtitles: movie 1 found");
  });

  it("goes DOWN when every answer is a notice (Demo Titlovi.com)", async () => {
    const m = subtitlesAddon();
    idsourcesMock.candidatesFor = async () => [{ type: "movie", id: "tt1375666" }];
    const url = "https://stremio.titlovi.com/files/api-disabled.vtt";
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/subtitles/movie/tt1375666",
        {
          status: 200,
          data: { subtitles: ["bos", "srp", "eng"].map((lang) => ({ id: "0", lang, url })) },
        },
      ],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(false);
    expect(r.error).toBe("subtitles");
    expect(r.message).toBe("manifest up · subtitles: movie notices only");
  });

  it("reports a plea to configure as needs-config (SubMaker)", async () => {
    const m = subtitlesAddon();
    idsourcesMock.candidatesFor = async () => [{ type: "movie", id: "tt1375666" }];
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/subtitles/movie/tt1375666",
        {
          status: 200,
          data: {
            subtitles: [
              {
                id: "config_error_session_token",
                lang: "!SubMaker Error",
                url: "https://submaker.test/error/session-token-not-found.srt",
              },
            ],
          },
        },
      ],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.mode).toBe("needs-config");
    expect(r.detail.configReason).toBe("!SubMaker Error");
  });

  it("goes DOWN when nothing comes back for the titles its override names (TR Altyazı)", async () => {
    const m = subtitlesAddon();
    overrides[m.uuid] = { name: "TR Altyazı", testIds: [{ type: "movie", id: "tt0468569" }] };
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/subtitles/", { status: 200, data: { subtitles: [] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(false);
    expect(r.detail.primary).toBe("subtitles");
  });

  it("stays UP, annotated, when nothing comes back for borrowed titles, configurable or not (DualSubs)", async () => {
    const m = subtitlesAddon({ behaviorHints: { configurable: true } });
    idsourcesMock.candidatesFor = async () => [{ type: "movie", id: "tt1375666" }];
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/subtitles/", { status: 200, data: { subtitles: [] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.mode).toBe("content");
    expect(r.message).toBe("subtitles: movie 0 found");
  });

  it("judges nothing for every title under a public test config as a verdict, not a missing config (yifysubtitles)", async () => {
    const m = subtitlesAddon({
      behaviorHints: { configurable: true, configurationRequired: true },
    });
    overrides[m.uuid] = {
      name: "yifysubtitles",
      testConfig: "english",
      testIds: [{ type: "movie", id: "tt1375666" }],
    };
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/subtitles/", { status: 200, data: { subtitles: [] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(false);
    expect(r.detail.primary).toBe("subtitles");
  });

  it("is liveness-only without a title in the resource's scope", async () => {
    const m = subtitlesAddon({
      resources: [{ name: "subtitles", types: ["series"], idPrefixes: ["RO_"] }],
    });
    router = routes([["/manifest.json", manifestOk(m.manifest)]]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.mode).toBe("liveness-only");
    expect(r.detail.skipReason).toBe("no test ID for subtitles");
  });
});

describe("probe wrong title", () => {
  const ULT_FRIENDS = [
    "I Made Friends with the Second Prettiest Girl in My Class S01E01 1080p CR WEB-DL AAC2.0 H 264-VARYG",
    "[Judas] Class de 2-banme ni Kawaii Onnanoko to Tomodachi ni Natta (I Made Friends with the Second Prettiest Girl in My Class) - S01E01 [1080p]",
  ].map((title, i) => ({
    name: "ULT AddOn [FHD]\n📅 22.09.1994.",
    title: `${title}\n💾 Unknown | 👥 S: 54 | [Nyaa]`,
    infoHash: String(i + 1).repeat(40),
  }));

  function ultAddon() {
    const m = addon({
      types: ["series"],
      resources: [{ name: "stream", types: ["series"], idPrefixes: ["tt"] }],
    });
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.candidatesFor = async () => [
      { type: "series", id: "tt0108778", episodeId: "tt0108778:1:1", names: ["Friends"] },
      { type: "series", id: "tt0903747", episodeId: "tt0903747:1:1", names: ["Breaking Bad"] },
    ];
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/stream/series/tt0108778:1:1.json", { status: 200, data: { streams: ULT_FRIENDS } }],
      ["/stream/series/tt0903747:1:1.json", { status: 200, data: { streams: [] } }],
    ]);
    return m;
  }

  it("isn't UP on streams naming another title than the borrowed one asked for (ULT AddOn)", async () => {
    const r = await probe(ultAddon());
    expect(r.success).toBe(false);
    expect(r.detail.streamCounts).toEqual({ total: 2, playable: 0, links: 0 });
    const stream = r.detail.perResource.find((p) => p.resource === "stream");
    expect(stream?.summary).toBe("series 2 streams, wrong title (2 IDs)");
    expect(stream?.details).toContainEqual({
      label: "Reason",
      value: "streams for another title: I Made Friends with the Second Prettiest Girl in My Class",
    });
  });

  it("notes streams for another title beside ones without a release name, which still count", async () => {
    const m = ultAddon();
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/stream/series/tt0108778:1:1.json",
        { status: 200, data: { streams: [...ULT_FRIENDS, PLAYABLE] } },
      ],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.streamCounts).toEqual({ total: 3, playable: 1, links: 0 });
    const stream = r.detail.perResource.find((p) => p.resource === "stream");
    expect(stream?.details).toContainEqual({
      label: "Note",
      value:
        "wrong title: 2 of 3 streams name I Made Friends with the Second Prettiest Girl in My Class",
    });
  });

  it("keeps an own catalog title's streams whatever they name", async () => {
    const m = ultAddon();
    idsourcesMock.candidatesFor = async () => [
      { type: "series", id: "tt0108778", episodeId: "tt0108778:1:1", names: ["Friends"] },
    ];
    m.manifest.catalogs = [{ type: "series", id: "top", name: "Top" }];
    m.manifest.resources = [
      ...m.manifest.resources,
      { name: "catalog", types: ["series"], idPrefixes: ["tt"] },
    ];
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/series/top.json",
        {
          status: 200,
          data: {
            metas: [
              { id: "tt0108778", type: "series", name: "Friends", poster: "https://p.test/x.jpg" },
            ],
          },
        },
      ],
      ["/stream/series/tt0108778:1:1.json", { status: 200, data: { streams: ULT_FRIENDS } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
  });
});
