import { describe, expect, it } from "vitest";
import type { Manifest } from "@stremio-addon/sdk";
import { missingManifestFields, normalizeResources, resourceAccepts } from "./manifest.js";

const manifest = (m: Partial<Manifest>): Manifest =>
  ({ id: "x", name: "x", version: "1", types: [], catalogs: [], resources: [], ...m }) as Manifest;

describe("normalizeResources", () => {
  it("inherits types and idPrefixes from the manifest for short-form resources", () => {
    const [stream] = normalizeResources(
      manifest({ resources: ["stream"], types: ["movie"], idPrefixes: ["tt"] }),
    );
    expect(stream).toEqual({ name: "stream", types: ["movie"], idPrefixes: ["tt"] });
  });

  it("keeps a full resource's own scope", () => {
    const [meta] = normalizeResources(
      manifest({
        types: ["movie", "series"],
        idPrefixes: ["tt"],
        resources: [{ name: "meta", types: ["series"], idPrefixes: ["had:episode:"] }],
      }),
    );
    expect(meta).toEqual({ name: "meta", types: ["series"], idPrefixes: ["had:episode:"] });
  });
});

describe("resourceAccepts", () => {
  const meta = { name: "meta", types: ["series"], idPrefixes: ["had:episode:"] };

  it("accepts an ID in scope", () => {
    expect(resourceAccepts(meta, "series", "had:episode:tt33078239:1:4")).toBe(true);
  });

  it("rejects another type or prefix", () => {
    expect(resourceAccepts(meta, "movie", "had:episode:tt1")).toBe(false);
    expect(resourceAccepts(meta, "series", "tt34890576")).toBe(false);
  });

  it("accepts every ID when idPrefixes is missing or blank", () => {
    expect(
      resourceAccepts({ name: "stream", types: ["movie"], idPrefixes: [] }, "movie", "tt1"),
    ).toBe(true);
    expect(
      resourceAccepts({ name: "stream", types: ["movie"], idPrefixes: [""] }, "movie", "kitsu:1"),
    ).toBe(true);
  });

  it("matches a prefix declared without its trailing colon", () => {
    expect(
      resourceAccepts(
        { name: "stream", types: ["anime"], idPrefixes: ["kitsu"] },
        "anime",
        "kitsu:7442:1",
      ),
    ).toBe(true);
  });
});

describe("missingManifestFields", () => {
  it("accepts a minimal manifest without description or catalogs", () => {
    expect(
      missingManifestFields({ id: "x", version: "1.0.0", name: "X", resources: [], types: [] }),
    ).toEqual([]);
  });

  it("names every field a non-manifest JSON object lacks", () => {
    expect(missingManifestFields({ meta: {}, payload: {} })).toEqual([
      "id",
      "version",
      "name",
      "resources",
      "types",
    ]);
  });

  it("rejects a field of the wrong type", () => {
    expect(
      missingManifestFields({ id: "x", version: 1, name: "X", resources: "stream", types: [] }),
    ).toEqual(["version", "resources"]);
  });
});
