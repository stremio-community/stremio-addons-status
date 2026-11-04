import { describe, expect, it } from "vitest";
import { metaBodyDefect, metaDefects, metaFlaws, metasWithout } from "./metas.js";

describe("metaDefects", () => {
  it("counts metas without a name (TorrentFreaks Top-10)", () => {
    const metas = Array.from({ length: 100 }, (_, i) => ({ id: `tt${i}`, type: "movie" }));
    expect(metaDefects(metas)).toEqual({ invalid: 100, missing: ["name"] });
  });

  it("lists every field the invalid metas lack between them", () => {
    expect(metaDefects([{ id: "a", type: "movie", name: "A" }, { type: "movie" }, {}])).toEqual({
      invalid: 2,
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
    expect(metaBodyDefect({ meta: { id: "a", type: "movie" } })?.reason).toBe("meta missing name");
    expect(metaBodyDefect({ meta: { id: "a", type: "movie", name: "A" } })).toBeUndefined();
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
      { summary: "placeholder", reason: "addon says: Loading..." },
    ]);
  });

  it("flags a series meta without videos", () => {
    const meta = { id: "tmdb:1413", type: "series", name: "American Horror Story" };
    expect(metaFlaws(meta, "series", "tmdb:1413")).toEqual([
      { summary: "no videos", reason: "series meta has no videos" },
    ]);
    expect(metaFlaws({ ...meta, videos: [] }, "series", "tmdb:1413")).toHaveLength(1);
  });

  it("passes a meta describing the requested title", () => {
    const meta = { id: "tt1", type: "series", name: "Show", videos: [{ id: "tt1:1:1" }] };
    expect(metaFlaws(meta, "series", "tt1")).toEqual([]);
  });
});
