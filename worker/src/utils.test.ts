import { describe, expect, it } from "vitest";
import { nextSlotAfter } from "./utils.js";

const FIVE_MINUTES = 5 * 60_000;

describe("nextSlotAfter", () => {
  it("lands on the next whole multiple of the interval", () => {
    expect(nextSlotAfter(Date.parse("2026-11-01T03:01:51Z"), FIVE_MINUTES)).toBe(
      Date.parse("2026-11-01T03:05:00Z"),
    );
  });

  it("moves on to the following mark from a time exactly on one", () => {
    expect(nextSlotAfter(Date.parse("2026-11-01T03:05:00Z"), FIVE_MINUTES)).toBe(
      Date.parse("2026-11-01T03:10:00Z"),
    );
  });
});
