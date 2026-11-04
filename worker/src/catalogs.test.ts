import { describe, expect, it } from "vitest";
import {
  catalogCoverage,
  coveragePicks,
  type CatalogOutcome,
  type CatalogRef,
} from "./catalogs.js";

const ref = (type: string, id: string): CatalogRef => ({ type, id });
const same = (c: CatalogRef) => c;

describe("coveragePicks", () => {
  it("fetches one catalog of each type the primary check didn't reach (Cartoon Network)", () => {
    const catalogs = [
      ref("movie", "cartoon_network_movie"),
      ref("series", "cartoon_network_series"),
    ];
    expect(coveragePicks(catalogs, same, [catalogs[0]])).toEqual([catalogs[1]]);
  });

  it("fills up with siblings of a covered type (OnlyPorn)", () => {
    const catalogs = ["eporner", "spankbang", "missav", "xhamster.hd+", "xhamster.4k"].map((id) =>
      ref("movie", id),
    );
    expect(coveragePicks(catalogs, same, [catalogs[0]]).map((c) => c.id)).toEqual([
      "spankbang",
      "missav",
      "xhamster.hd+",
    ]);
  });

  it("reaches uncovered types before siblings, and never fetches more than four", () => {
    const catalogs = [
      ref("movie", "a"),
      ref("movie", "b"),
      ref("series", "c"),
      ref("anime", "d"),
      ref("tv", "e"),
      ref("channel", "f"),
      ref("other", "g"),
    ];
    expect(coveragePicks(catalogs, same, []).map((c) => c.id)).toEqual(["a", "c", "d", "e"]);
  });

  it("fetches nothing more once enough catalogs are covered, but still one per new type", () => {
    const catalogs = [ref("movie", "a"), ref("movie", "b"), ref("movie", "c"), ref("movie", "d")];
    expect(coveragePicks(catalogs, same, catalogs.slice(0, 4))).toEqual([]);
    const typed = [...catalogs, ref("Series", "e")];
    expect(coveragePicks(typed, same, catalogs)).toEqual([typed[4]]);
  });
});

const items = (type: string, id: string, total: number, invalid = 0): CatalogOutcome => ({
  catalog: ref(type, id),
  path: `/catalog/${type}/${id}.json`,
  kind: "items",
  ok: true,
  summary: `${total} metas`,
  metas: { total, invalid, missing: invalid > 0 ? ["name"] : [] },
});
const empty = (type: string, id: string): CatalogOutcome => ({
  catalog: ref(type, id),
  path: `/catalog/${type}/${id}.json`,
  kind: "empty",
  ok: false,
  summary: "empty",
  metas: { total: 0, invalid: 0, missing: [] },
});

describe("catalogCoverage", () => {
  it("names a sibling catalog whose metas lack names (Cartoon Network)", () => {
    const series: CatalogOutcome = {
      ...empty("series", "cartoon_network_series"),
      summary: "invalid (20 metas without name)",
      metas: { total: 20, invalid: 20, missing: ["name"] },
    };
    const r = catalogCoverage([items("movie", "cartoon_network_movie", 20), series]);
    expect(r).toEqual({
      resource: "catalogs",
      ok: false,
      summary: "1 of 2 OK · cartoon_network_series without name",
      details: [
        { label: "Catalog", value: "/catalog/movie/cartoon_network_movie.json · 20 metas" },
        {
          label: "Catalog",
          value: "/catalog/series/cartoon_network_series.json · invalid (20 metas without name)",
        },
      ],
    });
  });

  it("names empty catalogs and catalogs with some nameless metas (OnlyPorn)", () => {
    const r = catalogCoverage([
      items("movie", "eporner", 65),
      empty("movie", "spankbang"),
      empty("movie", "missav"),
      items("movie", "xhamster.hd+", 51, 39),
    ]);
    expect(r?.summary).toBe("1 of 4 OK · spankbang empty, missav empty, xhamster.hd+ without name");
    expect(r?.details[3]).toEqual({
      label: "Catalog",
      value: "/catalog/movie/xhamster.hd+.json · 51 metas · 39 of 51 metas without name",
    });
  });

  it("judges each catalog on its best request and names a failure by its summary", () => {
    const r = catalogCoverage([
      empty("movie", "top"),
      { ...items("movie", "top", 10), path: "/catalog/movie/top/genre=Action.json" },
      { ...empty("series", "top"), kind: "failed", summary: "HTTP 500", metas: undefined },
    ]);
    expect(r?.summary).toBe("1 of 2 OK · series/top HTTP 500");
  });

  it("says nothing about a single catalog, and passes when all are fine", () => {
    expect(catalogCoverage([items("movie", "a", 5)])).toBeUndefined();
    expect(catalogCoverage([items("movie", "a", 5), items("series", "b", 5)])).toMatchObject({
      ok: true,
      summary: "2 of 2 OK",
    });
  });
});
