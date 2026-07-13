import { describe, expect, it } from "vitest";
import { buildMonitors, clientSecretOf } from "./kuvasz.js";
import type { NormalizedAddon } from "./types.js";

function addon(overrides: Partial<NormalizedAddon>): NormalizedAddon {
  return {
    uuid: "uuid-x",
    slug: "slug-x",
    name: "Addon X",
    manifestUrl: "https://example.com/manifest.json",
    baseUrl: "https://example.com",
    stars: 0,
    categories: [],
    ...overrides,
  };
}

describe("buildMonitors", () => {
  it("keeps unique names as-is", () => {
    const [m] = buildMonitors([addon({ name: "Torrentio", slug: "torrentio" })]);
    expect(m.name).toBe("Torrentio");
    expect(m.clientSecret).toBe(clientSecretOf("torrentio"));
  });

  it("suffixes every sharer of a colliding name, independent of list order", () => {
    const a = addon({ name: "Comet", slug: "comet-a", uuid: "u1" });
    const b = addon({ name: "Comet", slug: "comet-b", uuid: "u2" });
    const names1 = buildMonitors([a, b]).map((m) => m.name);
    const names2 = buildMonitors([b, a]).map((m) => m.name);
    expect(names1.sort()).toEqual(["Comet (comet-a)", "Comet (comet-b)"]);
    expect(names1.sort()).toEqual(names2.sort());
  });

  it("falls back to the uuid when a raw name equals another addon's suffixed name", () => {
    const a = addon({ name: "Comet", slug: "comet-a", uuid: "u1" });
    const b = addon({ name: "Comet", slug: "comet-b", uuid: "u2" });
    const imposter = addon({ name: "Comet (comet-a)", slug: "imposter", uuid: "u3" });
    const names = buildMonitors([a, b, imposter]).map((m) => m.name);
    expect(names).toContain("Comet (u1)");
    expect(names).toContain("Comet (comet-a) (u3)");
    expect(new Set(names).size).toBe(3);
  });

  it("derives the client secret from the slug only, so renames never re-key", () => {
    const before = buildMonitors([addon({ name: "Old Name", slug: "stable" })])[0];
    const after = buildMonitors([addon({ name: "New Name", slug: "stable" })])[0];
    expect(before.clientSecret).toBe(after.clientSecret);
  });
});
