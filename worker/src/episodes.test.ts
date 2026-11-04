import { describe, expect, it } from "vitest";
import { streamIdForMeta } from "./episodes.js";

describe("streamIdForMeta", () => {
  it("uses the meta ID when there are no videos", () => {
    expect(streamIdForMeta({ id: "tmdb:307478", type: "series" })).toBe("tmdb:307478");
    expect(streamIdForMeta({ id: "tmdb:307478", type: "series", videos: [] })).toBe("tmdb:307478");
  });

  it("uses defaultVideoId when the meta names one", () => {
    expect(
      streamIdForMeta({
        id: "shuffle:office",
        type: "series",
        behaviorHints: { defaultVideoId: "tt0386676:2:7" },
        videos: [{ id: "tt0386676:1:1", season: 1, episode: 1 }],
      }),
    ).toBe("tt0386676:2:7");
  });

  it("prefers the first regular episode over season-0 specials", () => {
    expect(
      streamIdForMeta({
        id: "onepace",
        type: "series",
        videos: [
          { id: "SP_1", season: 0, episode: 1 },
          { id: "EH_21", season: 2, episode: 1 },
          { id: "RO_1", season: 1, episode: 1 },
        ],
      }),
    ).toBe("RO_1");
  });

  it("falls back to the first video when none has a season", () => {
    expect(
      streamIdForMeta({
        id: "h1",
        type: "Heroes",
        videos: [{ id: "tt41416782:1:1" }, { id: "x" }],
      }),
    ).toBe("tt41416782:1:1");
  });

  it("uses the meta ID when its only video is the meta itself", () => {
    expect(streamIdForMeta({ id: "m1", type: "movie", videos: [{ id: "m1" }] })).toBe("m1");
  });
});
