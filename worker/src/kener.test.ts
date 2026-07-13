import { describe, expect, it } from "vitest";
import { buildGroups, buildMonitors, tagOf } from "./kener.js";
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

describe("buildGroups", () => {
  it("groups addons by primary category and instances into their own group", () => {
    const groups = buildGroups(
      buildMonitors([
        addon({ slug: "a", uuid: "u1", name: "A", categories: ["movies"] }),
        addon({ slug: "b", uuid: "u2", name: "B", categories: ["subtitles", "movies"] }),
        addon({ slug: "c", uuid: "u3", name: "C", categories: [] }),
        addon({ slug: "i", uuid: "u4", name: "I", categories: ["movies"], instanceOf: "a" }),
      ]),
    );

    expect(groups.map((g) => g.tag)).toEqual([
      "group-addons-movies",
      "group-addons-other",
      "group-addons-subtitles",
      "group-addon-instances",
    ]);
    expect(groups.map((g) => g.name)).toEqual(["Movies", "Other", "Subtitles", "Addon Instances"]);
    expect(groups[0]!.memberTags).toEqual(["a"]);
    expect(groups[3]!.memberTags).toEqual(["i"]);
  });

  it("chunks categories larger than 100 members and sorts members by display name", () => {
    const addons = Array.from({ length: 150 }, (_, i) =>
      addon({
        slug: `addon-${i}`,
        uuid: `u${i}`,
        name: `Addon ${String(i).padStart(3, "0")}`,
        categories: ["movies"],
      }),
    );
    const groups = buildGroups(buildMonitors(addons));

    expect(groups.map((g) => g.tag)).toEqual(["group-addons-movies-1", "group-addons-movies-2"]);
    expect(groups.map((g) => g.name)).toEqual(["Movies (1/2)", "Movies (2/2)"]);
    expect(groups.map((g) => g.memberTags.length)).toEqual([100, 50]);
    expect(groups[0]!.memberTags[0]).toBe("addon-0");
  });
});
