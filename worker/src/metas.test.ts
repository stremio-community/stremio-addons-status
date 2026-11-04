import { describe, expect, it } from "vitest";
import { metaBodyDefect, metaDefects, metaFlaws, metasWithout } from "./metas.js";

describe("metaDefects", () => {
  it("counts metas without a name (TorrentFreaks Top-10)", () => {
    const metas = Array.from({ length: 100 }, (_, i) => ({ id: `tt${i}`, type: "movie" }));
    expect(metaDefects(metas)).toEqual({ total: 100, incomplete: 100, missing: ["name"] });
  });

  it("lists every field the incomplete metas lack between them", () => {
    expect(metaDefects([{ id: "a", type: "movie", name: "A" }, { type: "movie" }, {}])).toEqual({
      total: 3,
      incomplete: 2,
      missing: ["id", "type", "name"],
    });
  });
});

describe("metasWithout", () => {
  it("words all or some metas lacking fields", () => {
    expect(metasWithout(100, 100, ["name"])).toBe("100 metas without name");
    expect(metasWithout(39, 51, ["name"])).toBe("39 of 51 metas without name");
    expect(metasWithout(1, 1, ["id", "name"])).toBe("1 meta without id, name");
  });
});

describe("metaBodyDefect", () => {
  it("says a meta came back without its wrapper (Nickelodeon)", () => {
    const body = { id: "tmdb:980431", type: "movie", name: "Avatar Aang: The Last Airbender" };
    expect(metaBodyDefect(body)).toEqual({
      summary: "invalid (meta not wrapped)",
      reason: 'meta returned without the {"meta": …} wrapper',
    });
  });

  it("calls an unwrapped series meta lacking its name unwrapped too (Cartoon Network)", () => {
    expect(metaBodyDefect({ id: "tmdb:15260", type: "series", poster: "p" })?.summary).toBe(
      "invalid (meta not wrapped)",
    );
  });

  it("says there is no meta object when the body isn't one", () => {
    expect(metaBodyDefect({ metas: [] })).toEqual({
      summary: "invalid",
      reason: "response has no meta object",
    });
    expect(metaBodyDefect(null)?.reason).toBe("response has no meta object");
  });

  it("names the fields a wrapped meta lacks, and accepts a complete one", () => {
    expect(metaBodyDefect({ meta: { name: "A" } })?.reason).toBe("meta missing id, type");
    expect(metaBodyDefect({ meta: { id: "a", type: "movie", name: "A" } })).toBeUndefined();
  });

  it("accepts a wrapped meta without a name, which Stremio loads untitled", () => {
    expect(metaBodyDefect({ meta: { id: "tt1", type: "movie" } })).toBeUndefined();
  });
});

describe("metaFlaws", () => {
  it("flags the stub Holiday Movies & Shows answers for every title", () => {
    const meta = {
      id: "tmdb:1273221.json",
      type: "movie",
      name: "Loading...",
      posterShape: "poster",
    };
    expect(metaFlaws(meta, "movie", "tmdb:1273221")).toEqual([
      { summary: "id mismatch", reason: "meta id tmdb:1273221.json for request tmdb:1273221" },
    ]);
  });

  it("flags a meta that drops the requested ID's prefix (Raccoonmendations)", () => {
    expect(
      metaFlaws({ id: "155", type: "movie", name: "The Dark Knight" }, "movie", "tmdb:155"),
    ).toEqual([{ summary: "id mismatch", reason: "meta id 155 for request tmdb:155" }]);
  });

  it("accepts a meta mapped to another ID space (Watchario, TVDB Search)", () => {
    expect(
      metaFlaws({ id: "kitsu:13911", type: "movie", name: "A" }, "movie", "anilist:100248"),
    ).toEqual([]);
    expect(
      metaFlaws({ id: "tt0096895", type: "movie", name: "Batman" }, "movie", "tvdb-1204"),
    ).toEqual([]);
  });

  it("flags a series meta without videos", () => {
    const meta = { id: "tmdb:1413", type: "series", name: "American Horror Story" };
    expect(metaFlaws(meta, "series", "tmdb:1413")).toEqual([
      { summary: "no videos", reason: "series meta has no videos" },
    ]);
    expect(metaFlaws({ ...meta, videos: [] }, "series", "tmdb:1413")).toHaveLength(1);
  });

  it("flags a meta without a name", () => {
    expect(metaFlaws({ id: "tt1", type: "movie" }, "movie", "tt1")).toEqual([
      { summary: "without name", reason: "meta has no name" },
    ]);
  });

  it("passes a meta describing the requested title", () => {
    const meta = { id: "tt1", type: "series", name: "Show", videos: [{ id: "tt1:1:1" }] };
    expect(metaFlaws(meta, "series", "tt1")).toEqual([]);
  });
});
