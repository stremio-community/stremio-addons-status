import { describe, it, expect } from "vitest";
import { buildConditions, buildEndpoints, buildExternalEndpoints } from "./gatus.js";
import type { NormalizedAddon, ProbeResult } from "./types.js";

function verdict(detail: Omit<ProbeResult["detail"], "manifestDetails">): ProbeResult {
  return { success: true, durationMs: 1, message: "", detail: { manifestDetails: [], ...detail } };
}

const BASE = "https://aio.example.org/u/secret-api-key";

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
        BASE,
      ),
    ).toEqual([{ condition: "manifest: unreachable (HTTP 502)", success: false }]);
  });

  it("still reports an unreachable manifest without a reason", () => {
    expect(
      buildConditions(verdict({ live: false, mode: "content", perResource: [] }), BASE),
    ).toEqual([{ condition: "manifest: unreachable", success: false }]);
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
        BASE,
      ),
    ).toEqual([
      { condition: "manifest: reachable", success: true },
      { condition: "content: not deep-checked (configurationRequired)", success: true },
    ]);
  });

  it("marks every resource other than the primary as informational, in its text and its role", () => {
    const conditions = buildConditions(
      verdict({
        live: true,
        mode: "content",
        primary: "stream",
        perResource: [
          { resource: "catalog", ok: true, summary: "100 metas", details: [] },
          { resource: "stream", ok: false, summary: "0 of 12 valid", details: [] },
          { resource: "subtitles", ok: true, summary: "3 found", details: [] },
        ],
      }),
      BASE,
    );
    expect(conditions.map(({ condition, success }) => ({ condition, success }))).toEqual([
      { condition: "manifest: reachable", success: true },
      { condition: "catalog: 100 metas (informational)", success: true },
      { condition: "stream: 0 of 12 valid", success: false },
      { condition: "subtitles: 3 found (informational)", success: true },
    ]);
    expect(conditions.slice(1).map((c) => c.details?.[0])).toEqual([
      { label: "Role", value: "informational" },
      { label: "Role", value: "decides verdict" },
      { label: "Role", value: "informational" },
    ]);
  });

  it("carries the manifest's and each resource's detail rows after the role", () => {
    const [manifest, stream] = buildConditions(
      verdict({
        live: true,
        manifestDetails: [{ label: "Request", value: "/manifest.json" }],
        mode: "content",
        primary: "stream",
        perResource: [
          {
            resource: "stream",
            ok: false,
            summary: "movie 0 of 0 valid",
            details: [
              { label: "Request", value: "/stream/movie/tt1.json" },
              { label: "Attempt", value: "WARP · HTTP 403 · 210ms" },
              { label: "Attempt", value: "direct · HTTP 200 · 480ms" },
            ],
          },
        ],
      }),
      BASE,
    );
    expect(manifest.details).toEqual([{ label: "Request", value: "/manifest.json" }]);
    expect(stream.details).toEqual([
      { label: "Role", value: "decides verdict" },
      { label: "Request", value: "/stream/movie/tt1.json" },
      { label: "Attempt", value: "WARP · HTTP 403 · 210ms" },
      { label: "Attempt", value: "direct · HTTP 200 · 480ms" },
    ]);
  });

  it("strips the configured base URL from condition text and detail values", () => {
    const [manifest] = buildConditions(
      verdict({
        live: false,
        livenessError: `Failed to parse URL from ${BASE}/manifest.json`,
        manifestDetails: [
          { label: "Reason", value: `Failed to parse URL from ${BASE}/manifest.json` },
        ],
        mode: "content",
        perResource: [],
      }),
      BASE,
    );
    expect(manifest.condition).toBe(
      "manifest: unreachable (Failed to parse URL from /manifest.json)",
    );
    expect(manifest.details).toEqual([
      { label: "Reason", value: "Failed to parse URL from /manifest.json" },
    ]);
  });

  it("trims details to what Gatus accepts instead of losing the push", () => {
    const [, stream] = buildConditions(
      verdict({
        live: true,
        mode: "content",
        primary: "stream",
        perResource: [
          {
            resource: "stream",
            ok: false,
            summary: "unreachable",
            details: Array.from({ length: 30 }, () => ({
              label: "Reason",
              value: "x".repeat(600),
            })),
          },
        ],
      }),
      BASE,
    );
    expect(stream.details).toHaveLength(20);
    expect(stream.details?.[1].value).toHaveLength(512);
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
  it("uses the instance's hostname as its alert description", () => {
    const [entry] = buildExternalEndpoints(
      buildEndpoints([addon("https://aio.example.org/manifest.json")]),
      true,
    );
    expect(entry.alerts?.[0].description).toBe("aio.example.org");
  });

  it("omits the alert description when there is no hostname", () => {
    const [entry] = buildExternalEndpoints(buildEndpoints([addon("not a url")]), true);
    expect(entry.alerts?.[0]).not.toHaveProperty("description");
  });

  it("omits alerts when Discord is disabled", () => {
    const [entry] = buildExternalEndpoints(
      buildEndpoints([addon("https://aio.example.org/manifest.json")]),
      false,
    );
    expect(entry.alerts).toBeUndefined();
  });
});
