import { describe, expect, it } from "vitest";
import { OVERRIDES, probeBaseUrl } from "./overrides.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("OVERRIDES", () => {
  it("holds only well-formed entries", () => {
    for (const [uuid, o] of Object.entries(OVERRIDES)) {
      expect(uuid).toMatch(UUID);
      expect(o.name, uuid).not.toBe("");
      expect(o.testConfig ?? "", uuid).not.toMatch(/^\/|\/$|manifest\.json/);
      expect(o.needsConfig ?? "x", uuid).not.toBe("");
      expect(
        o.testConfig ??
          o.needsConfig ??
          o.testIds ??
          o.sameStreamsForEveryTitle ??
          o.translatesSubtitles,
        uuid,
      ).toBeDefined();
      for (const t of o.testIds ?? []) expect(t.id, uuid).not.toBe("");
    }
  });
});

describe("probeBaseUrl", () => {
  it("appends an addon's test config to its base URL", () => {
    expect(
      probeBaseUrl({ uuid: "730c1070-9dcf-4887-8393-922ddf078191", baseUrl: "https://subs.test" }),
    ).toBe("https://subs.test/english");
  });

  it("leaves other base URLs alone", () => {
    expect(probeBaseUrl({ uuid: "u", baseUrl: "https://addon.test" })).toBe("https://addon.test");
  });
});
