import { describe, expect, it } from "vitest";
import { buildMonitors, shardPages, tagOf } from "./kener.js";
import type { NormalizedAddon } from "./types.js";

function addon(overrides: Partial<NormalizedAddon>): NormalizedAddon {
  return {
    uuid: "00000000-0000-0000-0000-000000000000",
    slug: "my-addon",
    name: "My Addon",
    manifestUrl: "https://example.com/manifest.json",
    baseUrl: "https://example.com",
    stars: 0,
    categories: [],
    ...overrides,
  };
}

describe("tagOf", () => {
  it("uses the slug near-verbatim", () => {
    expect(tagOf(addon({ slug: "torrentio" }))).toBe("torrentio");
    expect(tagOf(addon({ slug: "My.Weird Slug!" }))).toBe("my-weird-slug");
  });

  it("never produces leading or trailing separators", () => {
    expect(tagOf(addon({ slug: "--weird--" }))).toBe("weird");
  });

  it("falls back to the uuid when the slug is empty", () => {
    expect(tagOf(addon({ slug: "", uuid: "ABC-123" }))).toBe("abc-123");
  });
});

describe("buildMonitors", () => {
  it("keeps unique slugs untouched and maps categories", () => {
    const monitors = buildMonitors([
      addon({ slug: "one", uuid: "u1" }),
      addon({ slug: "two", uuid: "u2", instanceOf: "one" }),
    ]);
    expect(monitors.map((m) => m.tag)).toEqual(["one", "two"]);
    expect(monitors.map((m) => m.category)).toEqual(["Addons", "Addon Instances"]);
  });

  it("suffixes every collider with its uuid, independent of list order", () => {
    const a = addon({ slug: "Same.Slug", uuid: "aaa" });
    const b = addon({ slug: "same slug", uuid: "bbb" });
    const tags = (list: NormalizedAddon[]) =>
      new Map(buildMonitors(list).map((m) => [m.addon.uuid, m.tag]));

    const forward = tags([a, b]);
    const reversed = tags([b, a]);
    expect(forward).toEqual(reversed);
    expect(forward.get("aaa")).toBe("same-slug-aaa");
    expect(forward.get("bbb")).toBe("same-slug-bbb");
  });

  it("uses the display name verbatim without deduplication", () => {
    const monitors = buildMonitors([
      addon({ slug: "one", uuid: "u1", name: "Shared Name" }),
      addon({ slug: "two", uuid: "u2", name: "Shared Name" }),
    ]);
    expect(monitors.map((m) => m.name)).toEqual(["Shared Name", "Shared Name"]);
  });
});

describe("shardPages", () => {
  it("splits each category into pages of at most 100, sorted by display name", () => {
    const addons = Array.from({ length: 250 }, (_, i) =>
      addon({ slug: `addon-${i}`, uuid: `u${i}`, name: `Addon ${String(i).padStart(3, "0")}` }),
    );
    const instances = [addon({ slug: "inst", uuid: "ui", name: "Instance", instanceOf: "addon-0" })];
    const shards = shardPages(buildMonitors([...addons, ...instances]));

    expect(shards.map((s) => s.path)).toEqual(["addons-1", "addons-2", "addons-3", "addon-instances-1"]);
    expect(shards.map((s) => s.title)).toEqual(["Addons (1/3)", "Addons (2/3)", "Addons (3/3)", "Addon Instances"]);
    expect(shards.map((s) => s.tags.length)).toEqual([100, 100, 50, 1]);
    expect(shards[0]!.tags[0]).toBe("addon-0");
  });

  it("emits no shard pages for an empty category", () => {
    const shards = shardPages(buildMonitors([addon({ slug: "solo", uuid: "u1" })]));
    expect(shards.map((s) => s.path)).toEqual(["addons-1"]);
    expect(shards[0]!.title).toBe("Addons");
  });
});
