import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Manifest } from "@stremio-addon/sdk";
import type { NormalizedAddon } from "./types.js";
import type { TestContent } from "./idsources.js";
import type { ParseError } from "./http.js";

// --- mocks -----------------------------------------------------------------

type RouteResult = { status: number; data: unknown; parseError?: ParseError; redirect?: string };
let router: (url: string) => RouteResult;

const idsourcesMock = {
  hasSourceFor: (_prefixes: readonly string[]) => false,
  resolveForPrefixes: async (_prefixes: readonly string[]): Promise<TestContent[]> => [],
};

vi.mock("./http.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http.js")>()),
  getJson: async (url: string) => {
    const { redirect, ...res } = router(url);
    return {
      ...res,
      attempts: [
        { route: "direct", status: res.status, durationMs: 1, ...(redirect ? { redirect } : {}) },
      ],
    };
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
  idsourcesMock.hasSourceFor = () => false;
  idsourcesMock.resolveForPrefixes = async () => [];
});

// --- tests -----------------------------------------------------------------

describe("probe", () => {
  it("(a) catalog-less imdb scraper probes movie and series episode; 1+1 playable ⇒ DOWN", async () => {
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
      ["/stream/series/tt2:1:1.json", { status: 200, data: { streams: [PLAYABLE] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(false);
    expect(r.detail.mode).toBe("content");
    expect(r.error).toBe("stream");
    expect(r.message).toContain("stream: movie 1 of 1 valid");
    expect(r.message).toContain("series 1 of 1 valid");
  });

  it("catalog-less imdb scraper ⇒ UP when either movie or series returns more than 1 playable stream", async () => {
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
      ["/stream/series/tt2:1:1.json", { status: 200, data: { streams: [PLAYABLE, PLAYABLE] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.mode).toBe("content");
    expect(r.detail.streamCounts).toEqual({ total: 3, valid: 3 });
    expect(r.message).toContain("stream: movie 1 of 1 valid");
    expect(r.message).toContain("series 2 of 2 valid");
  });

  it("catalog-less imdb scraper ⇒ UP when movie has more than 1 playable stream and series fails", async () => {
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
      ["/stream/movie/tt1.json", { status: 200, data: { streams: [PLAYABLE, PLAYABLE] } }],
      ["/stream/series/tt2:1:1.json", { status: 200, data: { streams: [{ name: "junk" }] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.message).toContain("movie 2 of 2 valid");
    expect(r.message).toContain("series 0 of 1 valid");
  });

  it("dual-target verdict requires a successful stream response", async () => {
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
      ["/stream/series/tt2:1:1.json", { status: 500, data: { streams: [PLAYABLE, PLAYABLE] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(false);
    expect(r.message).toContain("movie 1 of 1 valid");
    expect(r.message).toContain("series HTTP 500");
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
    expect(r.message).toContain("movie 0 of 1 valid");
    expect(r.message).toContain("series 0 of 1 valid");
  });

  it("catalog-less imdb scraper advertising movie+series keeps the single-target rule when only one target is sourceable", async () => {
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
    expect(r.detail.streamCounts).toEqual({ total: 1, valid: 1 });
    expect(r.message).toContain("movie 1 of 1 valid");
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
      ["/stream/series/tt2:1:1.json", { status: 200, data: { streams: [PLAYABLE] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(false);
    expect(r.message).toContain("movie 1 of 1 valid");
    expect(r.message).toContain("series 1 of 1 valid");
  });

  it("catalog-less non-imdb scraper advertising movie+series keeps the single-target rule when series lacks an episode ID", async () => {
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
    expect(r.message).toContain("movie 1 of 1 valid");
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
    expect(r.detail.streamCounts).toEqual({ total: 1, valid: 1 });
    expect(r.message).toContain("stream: anime 1 of 1 valid");
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
    expect(r.detail.streamCounts).toEqual({ total: 1, valid: 1 });
    expect(r.message).toContain("stream: anime 1 of 1 valid");
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
      ["/stream/movie/movie1.json", { status: 200, data: { streams: [PLAYABLE, PLAYABLE] } }],
      ["/stream/series/tt2:1:1.json", { status: 200, data: { streams: [PLAYABLE] } }],
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
      ["/stream/series/tt2:1:1.json", { status: 200, data: { streams: [PLAYABLE, PLAYABLE] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.message).toContain("movie 1 of 1 valid");
    expect(r.message).toContain("series 2 of 2 valid");
  });

  it("dual-target stream fetch that throws counts as that target failing", async () => {
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
    expect(r.success).toBe(false);
    expect(r.error).toBe("stream");
    expect(r.message).toContain("movie 1 of 1 valid");
    expect(r.message).toContain("series unreachable");
    const stream = r.detail.perResource.find((p) => p.resource === "stream");
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
      ["/stream/series/tt2:1:1.json", { status: 200, data: { streams: [PLAYABLE, PLAYABLE] } }],
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

  it("movie-only stream addon keeps single-target ≥1 playable stream ⇒ UP behavior", async () => {
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
    expect(r.detail.streamCounts).toEqual({ total: 1, valid: 1 });
    expect(r.message).toContain("stream: movie 1 of 1 valid");
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
    expect(r.message).toContain("stream: movie 0 of 2 valid");
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
      ["/subtitles/movie/x1.json", HTML_PAGE],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    const subs = r.detail.perResource.find((p) => p.resource === "subtitles");
    expect(subs?.summary).toBe("HTML page");
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
    expect(stream?.summary).toBe("movie 0 of 1 valid · series 0 of 0 valid");
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

  it("explains a dual-target DOWN where each target passed on its own", async () => {
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
      ["/stream/series/tt2:1:1.json", { status: 200, data: { streams: [PLAYABLE] } }],
    ]);
    const r = await probe(m);
    const stream = r.detail.perResource.find((p) => p.resource === "stream");
    expect(r.success).toBe(false);
    expect(stream?.details.at(-1)).toEqual({
      label: "Reason",
      value: "no target returned more than 1 playable stream",
    });
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
