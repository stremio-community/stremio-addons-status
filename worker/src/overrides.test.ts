import { describe, expect, it } from "vitest";
import { OVERRIDES } from "./overrides.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("OVERRIDES", () => {
  it("holds only well-formed entries", () => {
    for (const [uuid, o] of Object.entries(OVERRIDES)) {
      expect(uuid).toMatch(UUID);
      expect(o.name, uuid).not.toBe("");
      expect(o.testConfig ?? "", uuid).not.toMatch(/^\/|\/$|manifest\.json/);
      for (const t of o.testIds ?? []) expect(t.id, uuid).not.toBe("");
    }
  });
});
