import { describe, it, expect } from "vitest";
import { buildConditions } from "./gatus.js";
import type { ProbeResult } from "./types.js";

function verdict(detail: ProbeResult["detail"]): ProbeResult {
  return { success: true, durationMs: 1, message: "", detail };
}

describe("buildConditions", () => {
  it("reports the manifest as failed when the addon is unreachable", () => {
    expect(buildConditions(verdict({ live: false, mode: "content", perResource: [] }))).toEqual([
      { condition: "manifest reachable", success: false },
    ]);
  });

  it("explains why the content tier was skipped in liveness-only mode", () => {
    expect(
      buildConditions(
        verdict({
          live: true,
          mode: "liveness-only",
          skipReason: "configurationRequired",
          perResource: [],
        }),
      ),
    ).toEqual([
      { condition: "manifest reachable", success: true },
      { condition: "content not deep-checked (configurationRequired)", success: true },
    ]);
  });

  it("marks every resource other than the primary as informational", () => {
    expect(
      buildConditions(
        verdict({
          live: true,
          mode: "content",
          primary: "stream",
          perResource: [
            { resource: "catalog", ok: true, detail: "100 metas" },
            { resource: "stream", ok: false, detail: "0 valid / 12 total" },
            { resource: "subtitles", ok: true, detail: "3 subs" },
          ],
        }),
      ),
    ).toEqual([
      { condition: "manifest reachable", success: true },
      { condition: "catalog: 100 metas (informational)", success: true },
      { condition: "stream: 0 valid / 12 total", success: false },
      { condition: "subtitles: 3 subs (informational)", success: true },
    ]);
  });
});
