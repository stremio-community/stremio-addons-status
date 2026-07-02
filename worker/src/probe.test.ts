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
  getJson: async (url: string) => router(url),
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

beforeEach(() => {
  idsourcesMock.hasSourceFor = () => false;
  idsourcesMock.resolveForPrefixes = async () => [];
});

// --- tests -----------------------------------------------------------------

describe("probe", () => {
  it("(a) catalog-less imdb scraper -> IDs from Cinemeta, ≥1 playable stream ⇒ UP", async () => {
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
      ["/stream/movie/tt1.json", { status: 200, data: { streams: [PLAYABLE, PLAYABLE] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.mode).toBe("content");
    expect(r.detail.streamCounts?.valid).toBeGreaterThanOrEqual(1);
  });

  it("(b) catalog-less kitsu scraper -> IDs from Anime Kitsu ⇒ UP (prefix registry path)", async () => {
    const m = addon({
      types: ["movie", "series", "anime"],
      resources: [{ name: "stream", types: ["movie", "series", "anime"], idPrefixes: ["kitsu"] }],
    });
    idsourcesMock.hasSourceFor = () => true;
    idsourcesMock.resolveForPrefixes = async () => [
      { type: "series", id: "kitsu:1", episodeId: "kitsu:1:1:1" },
    ];
    router = routes([
      ["/manifest.json", manifestOk(m.manifest)],
      ["/stream/series/kitsu:1:1:1.json", { status: 200, data: { streams: [PLAYABLE] } }],
    ]);
    const r = await probe(m);
    expect(r.success).toBe(true);
    expect(r.detail.streamCounts?.valid).toBe(1);
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

  it("(e) manifest 200 but streams empty/garbage ⇒ DOWN (manifest up · 0 streams)", async () => {
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
    expect(r.message).toContain("0 streams");
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
});
