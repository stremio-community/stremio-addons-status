import { afterEach, describe, it, expect, vi } from "vitest";
import { buildConditions, buildEndpoints, buildExternalEndpoints, pushResult } from "./gatus.js";
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
    expect(Buffer.byteLength(stream.details![1].value)).toBeLessThanOrEqual(512);
  });

  it("counts the detail value limit in UTF-8 bytes without splitting a character", () => {
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
            details: [{ label: "Test ID", value: "é".repeat(300) }],
          },
        ],
      }),
      BASE,
    );
    const value = stream.details![1].value;
    expect(Buffer.byteLength(value)).toBeLessThanOrEqual(512);
    expect(value).toBe(`${"é".repeat(254)}…`);
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

  it("refuses a list that repeats a uuid, since Gatus would refuse the whole config", () => {
    const url = "https://aio.example.org/manifest.json";
    expect(() => buildEndpoints([addon(url), addon(url)])).toThrow(/repeats uuid/);
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

describe("pushResult", () => {
  const [endpoint] = buildEndpoints([addon("https://aio.example.org/manifest.json")]);
  const result = verdict({ live: true, mode: "content", perResource: [] });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function stubFetch(...responses: Array<number | Error>) {
    const fetch = vi.fn();
    for (const r of responses) {
      if (r instanceof Error) fetch.mockRejectedValueOnce(r);
      else fetch.mockResolvedValueOnce(new Response(null, { status: r }));
    }
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }

  async function push(): Promise<PromiseSettledResult<number>> {
    vi.useFakeTimers();
    const pushed = Promise.allSettled([pushResult(endpoint, result)]);
    await vi.runAllTimersAsync();
    return (await pushed)[0];
  }

  it("retries until Gatus has loaded the endpoint and is listening again", async () => {
    const fetch = stubFetch(404, 404, new TypeError("fetch failed"), 200);
    expect(await push()).toEqual({ status: "fulfilled", value: 200 });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("gives up with the last status once Gatus never loads the endpoint", async () => {
    const fetch = stubFetch(...Array<number>(7).fill(404));
    expect(await push()).toEqual({ status: "fulfilled", value: 404 });
    expect(fetch).toHaveBeenCalledTimes(7);
  });

  it("returns other errors without retrying", async () => {
    const fetch = stubFetch(401);
    expect(await push()).toEqual({ status: "fulfilled", value: 401 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("doesn't retry a timed-out push, which may have been stored", async () => {
    const fetch = stubFetch(new DOMException("timed out", "TimeoutError"));
    expect(await push()).toMatchObject({ status: "rejected", reason: { name: "TimeoutError" } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
