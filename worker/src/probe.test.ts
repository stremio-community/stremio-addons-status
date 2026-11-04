import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Manifest } from "@stremio-addon/sdk";
import type { NormalizedAddon } from "./types.js";
import type { TestContent } from "./idsources.js";

// --- mocks -----------------------------------------------------------------

type RouteResult = { status: number; data: unknown };
let router: (url: string) => RouteResult;

const idsourcesMock = {
  hasSourceFor: (_prefixes: readonly string[]) => false,
  resolveForPrefixes: async (_prefixes: readonly string[]): Promise<TestContent[]> => [],
};

vi.mock("./http.js", () => ({
  getJson: async (url: string) => {
    const res = router(url);
    return { ...res, attempts: [{ route: "direct", status: res.status, durationMs: 1 }] };
  },
  attemptsOf: () => [],
}));

vi.mock("./idsources.js", () => ({
  resetCycle: () => {},
  hasSourceFor: (p: readonly string[]) => idsourcesMock.hasSourceFor(p),
  resolveForPrefixes: (p: readonly string[]) => idsourcesMock.resolveForPrefixes(p),
}));

// Import after mocks are registered.
const { probe } = await import("./probe.js");

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

const manifestOk = (m: Manifest): RouteResult => ({ status: 200, data: m });

beforeEach(() => {
  idsourcesMock.hasSourceFor = () => false;
  idsourcesMock.resolveForPrefixes = async () => [];
});

// --- tests -----------------------------------------------------------------

describe("probe", () => {
  it("(a) catalog-less imdb scraper probes movie and series episode; one real stream each ⇒ UP", async () => {
    const m = addon({
      types: ["movie", "series"],
      resources: [{ name: "stream", types: ["movie", "series"], idPrefixes: ["tt", "kitsu"] }],
    });
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.resolveForPrefixes = async () => [
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
    idsourcesMock.resolveForPrefixes = async () => [
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
    idsourcesMock.resolveForPrefixes = async () => [
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
    idsourcesMock.resolveForPrefixes = async () => [
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
    idsourcesMock.resolveForPrefixes = async () => [{ type: "movie", id: "tt1" }];
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
    idsourcesMock.resolveForPrefixes = async () => [
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
    idsourcesMock.resolveForPrefixes = async () => [
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

  it("looks up a stream target's episode ID only once when meta has no videos", async () => {
    const m = addon({
      types: ["series"],
      resources: [
        { name: "stream", types: ["series"], idPrefixes: ["custom"] },
        { name: "meta", types: ["series"], idPrefixes: ["custom"] },
      ],
    });
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.resolveForPrefixes = async () => [{ type: "series", id: "custom-series" }];
    let metaCalls = 0;
    const metaNoVideos = { status: 200, data: { meta: { id: "custom-series", type: "series" } } };
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/meta/series/custom-series.json",
        () => {
          metaCalls++;
          return metaNoVideos as never;
        },
      ],
    ]);
    const r = await probe(m);
    expect(r.detail.mode).toBe("liveness-only");
    expect(metaCalls).toBe(1);
  });

  it("(b) catalog-less kitsu scraper uses a borrowed anime candidate as a single stream target", async () => {
    const m = addon({
      types: ["anime"],
      resources: [{ name: "stream", types: ["anime"], idPrefixes: ["kitsu"] }],
    });
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.resolveForPrefixes = async () => [
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
    idsourcesMock.resolveForPrefixes = async () => [
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

  it("mixed-type stream addon deep-checks its own non-movie catalog instead of borrowing", async () => {
    const m = addon({
      types: ["movie", "series", "anime"],
      resources: [
        "catalog",
        { name: "stream", types: ["movie", "series", "anime"], idPrefixes: ["tt", "kitsu"] },
      ],
      catalogs: [{ type: "anime", id: "top", name: "Top" }],
    });
    const resolve = vi.fn(async (): Promise<TestContent[]> => {
      throw new Error("unexpected external ID lookup");
    });
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.resolveForPrefixes = resolve;
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
    expect(r.message).toContain("anime HTTP 500");
    expect(resolve).not.toHaveBeenCalled();
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
    idsourcesMock.resolveForPrefixes = resolve;
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/movie/top-movie.json",
        { status: 200, data: { metas: [{ id: "movie1", type: "movie", name: "M" }] } },
      ],
      [
        "/catalog/series/top-series.json",
        { status: 200, data: { metas: [{ id: "tt2", type: "series", name: "S" }] } },
      ],
      ["/stream/movie/movie1.json", { status: 200, data: { streams: [PLAYABLE, MORE] } }],
      ["/stream/series/tt2:1:1.json", { status: 200, data: { streams: [EPISODE] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("borrows only the stream target type its own catalogs don't cover", async () => {
    const m = addon({
      types: ["movie", "series"],
      resources: ["catalog", { name: "stream", types: ["movie", "series"], idPrefixes: ["tt"] }],
      catalogs: [{ type: "movie", id: "top-movie", name: "Top Movies" }],
    });
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.resolveForPrefixes = async () => [
      { type: "movie", id: "tt-borrowed" },
      { type: "series", id: "tt2", episodeId: "tt2:1:1" },
    ];
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      [
        "/catalog/movie/top-movie.json",
        { status: 200, data: { metas: [{ id: "movie1", type: "movie", name: "M" }] } },
      ],
      ["/stream/movie/movie1.json", { status: 200, data: { streams: [PLAYABLE] } }],
      ["/stream/series/tt2:1:1.json", { status: 200, data: { streams: [EPISODE, MORE] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.message).toContain("movie 1 playable of 1");
    expect(r.message).toContain("series 2 playable of 2");
  });

  it("dual-target stream fetch that throws counts as that target failing, not the addon", async () => {
    const m = addon({
      types: ["movie", "series"],
      resources: [{ name: "stream", types: ["movie", "series"], idPrefixes: ["tt"] }],
    });
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.resolveForPrefixes = async () => [
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
    idsourcesMock.resolveForPrefixes = async () => [{ type: "movie", id: "tt1" }];
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
    idsourcesMock.resolveForPrefixes = async () => [{ type: "movie", id: "tt1" }];
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

  it("(g) configurationRequired with reachable manifest ⇒ UP liveness-only", async () => {
    const m = addon({
      resources: ["stream"],
      types: ["movie"],
      behaviorHints: { configurationRequired: true },
    });
    router = routes([["/manifest.json", manifestOk(m.manifest)]]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.mode).toBe("liveness-only");
    expect(r.message).toContain("configurationRequired");
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
    router = routes([["/manifest.json", { status: 200, data: undefined }]]);
    const r = await probe(m);
    expect(r.success).toBe(false);
    expect(r.detail.livenessError).toBe("response is not a JSON object");
    expect(r.detail.manifestDetails).toEqual([
      { label: "Request", value: "/manifest.json" },
      { label: "Attempt", value: "direct · HTTP 200 · 1ms" },
      { label: "Reason", value: "response is not a JSON object" },
    ]);
  });
});

describe("probe detail rows", () => {
  it("lists each stream request with its borrowed test ID, routes tried and failure reason", async () => {
    const m = addon({
      types: ["movie", "series"],
      resources: [{ name: "stream", types: ["movie", "series"], idPrefixes: ["tt"] }],
    });
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.resolveForPrefixes = async () => [
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
      ["/meta/movie/m1.json", { status: 200, data: { meta: { id: "m1", type: "movie" } } }],
    ]);
    const r = await probe(m);
    const meta = r.detail.perResource.find((p) => p.resource === "meta");
    expect(meta?.summary).toBe("invalid");
    expect(meta?.details).toEqual([
      { label: "Request", value: "/meta/movie/m1.json" },
      { label: "Test ID", value: "m1 (own catalog)" },
      { label: "Attempt", value: "direct · HTTP 200 · 1ms" },
      { label: "Reason", value: "meta missing name" },
    ]);
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
    expect(catalog?.summary).toBe("empty");
    expect(catalog?.details.at(-1)).toEqual({
      label: "Reason",
      value: "none of 1 metas has an id, type and name",
    });
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
    idsourcesMock.resolveForPrefixes = async () => [
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
    idsourcesMock.resolveForPrefixes = async () => [
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
    idsourcesMock.resolveForPrefixes = async () => [{ type: "movie", id: "tt1" }];
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
