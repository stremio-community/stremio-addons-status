import { describe, it, expect } from "vitest";
import { buildConditions, buildEndpoints, buildExternalEndpoints } from "./gatus.js";
import type { NormalizedAddon, ProbeResult } from "./types.js";

function verdict(detail: ProbeResult["detail"]): ProbeResult {
  return { success: true, durationMs: 1, message: "", detail };
}

describe("buildConditions", () => {
  it("reports why the manifest was unreachable", () => {
    expect(
      buildConditions(
        verdict({
          live: false,
          livenessError: "HTTP 502",
          mode: "content",
          perResource: [],
        }),
      ),
    ).toEqual([{ condition: "manifest unreachable (HTTP 502)", success: false }]);
  });

  it("still reports an unreachable manifest without a reason", () => {
    expect(buildConditions(verdict({ live: false, mode: "content", perResource: [] }))).toEqual([
      { condition: "manifest unreachable", success: false },
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

function addon(manifestUrl: string): NormalizedAddon {
  return {
    uuid: "0b6c1a2e-0000-4000-8000-000000000000",
    slug: "aiostreams",
    name: "AIOStreams",
    manifestUrl,
    baseUrl: manifestUrl.replace(/\/manifest\.json$/, ""),
    stars: 0,
    categories: [],
    instanceOf: "AIOStreams",
  };
}

describe("buildEndpoints", () => {
  it("exposes only the hostname, never the configured path", () => {
    const [ep] = buildEndpoints([addon("https://aio.example.org/u/secret-api-key/manifest.json")]);
    expect(ep.hostname).toBe("aio.example.org");
  });

  it("leaves the hostname empty when the manifest URL won't parse", () => {
    const [ep] = buildEndpoints([addon("not a url")]);
    expect(ep.hostname).toBe("");
  });
});

describe("buildExternalEndpoints", () => {
  it("names the instance's hostname in its alert description", () => {
    const [entry] = buildExternalEndpoints(
      buildEndpoints([addon("https://aio.example.org/manifest.json")]),
      true,
    );
    expect(entry.alerts?.[0].description).toBe("addon down (aio.example.org)");
  });

  it("omits alerts when Discord is disabled", () => {
    const [entry] = buildExternalEndpoints(
      buildEndpoints([addon("https://aio.example.org/manifest.json")]),
      false,
    );
    expect(entry.alerts).toBeUndefined();
  });
});
