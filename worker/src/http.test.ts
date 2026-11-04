import { describe, it, expect, vi, beforeEach } from "vitest";

/** `url` is where redirects ended up; it defaults to the requested URL. */
type FakeResponse = { status: number; body: string; contentType?: string; url?: string };

// Shared, hoisted so the vi.mock factories below can reference them.
const h = vi.hoisted(() => ({
  PROXY: { __proxy: true } as object,
  state: {
    handler: (_url: string, _viaProxy: boolean): FakeResponse => ({ status: 200, body: "{}" }),
    calls: [] as boolean[],
  },
}));

vi.mock("fetch-socks", () => ({ socksDispatcher: () => h.PROXY }));
vi.mock("undici", () => ({
  fetch: async (url: string, opts: { dispatcher?: unknown }) => {
    const viaProxy = opts?.dispatcher === h.PROXY;
    h.state.calls.push(viaProxy);
    const r = h.state.handler(url, viaProxy);
    return {
      status: r.status,
      url: r.url ?? url,
      headers: new Headers(r.contentType ? { "content-type": r.contentType } : {}),
      text: async () => r.body,
    };
  },
}));

// A proxy must be configured for the fallback path to exist.
process.env.PROXY_URL = "socks5://warp:1080";
const { getJson, attemptsOf, describeParseError, RequestFailedError } = await import("./http.js");

/** Attempts without their timing, which varies from run to run. */
function routesOf(attempts: Array<{ route: string; status?: number; error?: string }>) {
  return attempts.map(({ route, status, error }) => ({ route, status, error }));
}

/** Cloudflare's challenge page, as served with HTTP 200 to a blocked egress IP. */
const CHALLENGE_PAGE = `<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title><meta http-equiv="refresh" content="390"></head><body><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script></body></html>`;

beforeEach(() => {
  h.state.handler = () => ({ status: 200, body: "{}" });
  h.state.calls = [];
});

describe("getJson WARP-first fallback", () => {
  it("returns the proxy response when it isn't blocked (no direct retry)", async () => {
    h.state.handler = () => ({ status: 200, body: JSON.stringify({ ok: 1 }) });
    const r = await getJson<{ ok: number }>("http://addon/manifest.json", 1000);
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ ok: 1 });
    expect(h.state.calls).toEqual([true]); // proxy only
    expect(routesOf(r.attempts)).toEqual([{ route: "WARP", status: 200, error: undefined }]);
  });

  it("falls back to direct when the proxy is blocked (403) and returns the direct result", async () => {
    h.state.handler = (_url, viaProxy) =>
      viaProxy ? { status: 403, body: "" } : { status: 200, body: JSON.stringify({ ok: 1 }) };
    const r = await getJson<{ ok: number }>("http://addon/manifest.json", 1000);
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ ok: 1 });
    expect(h.state.calls).toEqual([true, false]); // proxy, then direct
    expect(routesOf(r.attempts)).toEqual([
      { route: "WARP", status: 403, error: undefined },
      { route: "direct", status: 200, error: undefined },
    ]);
  });

  it("falls back to direct on a 5xx from the proxy", async () => {
    h.state.handler = (_url, viaProxy) =>
      viaProxy ? { status: 503, body: "" } : { status: 200, body: "{}" };
    const r = await getJson("http://addon/manifest.json", 1000);
    expect(r.status).toBe(200);
    expect(h.state.calls).toEqual([true, false]);
  });

  it("keeps the proxy result when direct also fails", async () => {
    h.state.handler = () => ({ status: 403, body: "" });
    const r = await getJson("http://addon/manifest.json", 1000);
    expect(r.status).toBe(403);
    expect(h.state.calls).toEqual([true, false]);
  });

  it("retries direct when the proxy transport throws", async () => {
    h.state.handler = (_url, viaProxy) => {
      if (viaProxy) throw new Error("ECONNREFUSED");
      return { status: 200, body: JSON.stringify({ ok: 1 }) };
    };
    const r = await getJson<{ ok: number }>("http://addon/manifest.json", 1000);
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ ok: 1 });
    expect(routesOf(r.attempts)).toEqual([
      { route: "WARP", status: undefined, error: "ECONNREFUSED" },
      { route: "direct", status: 200, error: undefined },
    ]);
  });

  it("reports the proxy result and both attempts when direct throws after a block", async () => {
    h.state.handler = (_url, viaProxy) => {
      if (!viaProxy) throw new Error("ECONNRESET");
      return { status: 429, body: "" };
    };
    const r = await getJson("http://addon/manifest.json", 1000);
    expect(r.status).toBe(429);
    expect(routesOf(r.attempts)).toEqual([
      { route: "WARP", status: 429, error: undefined },
      { route: "direct", status: undefined, error: "ECONNRESET" },
    ]);
  });

  it("throws every attempt when both routes fail at the transport level", async () => {
    h.state.handler = (_url, viaProxy) => {
      if (viaProxy) throw new Error("fetch failed", { cause: { code: "ECONNREFUSED" } });
      throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
    };
    const err = await getJson("http://addon/manifest.json", 1000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestFailedError);
    expect((err as Error).message).toBe("timed out after 1000ms");
    expect(routesOf(attemptsOf(err))).toEqual([
      { route: "WARP", status: undefined, error: "fetch failed (ECONNREFUSED)" },
      { route: "direct", status: undefined, error: "timed out after 1000ms" },
    ]);
  });

  it("does not retry a genuine content 404 (not a block)", async () => {
    h.state.handler = () => ({ status: 404, body: "" });
    const r = await getJson("http://addon/stream/movie/tt1.json", 1000);
    expect(r.status).toBe(404);
    expect(h.state.calls).toEqual([true]); // proxy only, no fallback
  });

  it("reports an HTML 200 page as a parse error and keeps it when there is no better answer", async () => {
    h.state.handler = () => ({
      status: 200,
      body: "<html><head><title>Not found</title></head><body>Nothing here</body></html>",
      contentType: "text/html; charset=utf-8",
    });
    const r = await getJson("http://addon/subtitles/movie/tt1.json", 1000);
    expect(r.status).toBe(200);
    expect(r.data).toBeUndefined();
    expect(r.parseError).toEqual({
      html: true,
      contentType: "text/html; charset=utf-8",
      title: "Not found",
      excerpt: "<html><head><title>Not found</title></head><body>Nothing here</body></html>",
    });
  });

  it("treats an HTML 200 over WARP as blocked-looking and returns the direct answer", async () => {
    h.state.handler = (_url, viaProxy) =>
      viaProxy
        ? { status: 200, body: CHALLENGE_PAGE, contentType: "text/html; charset=UTF-8" }
        : { status: 200, body: JSON.stringify({ streams: [] }), contentType: "application/json" };
    const r = await getJson("http://addon/stream/movie/tt1.json", 1000);
    expect(r.data).toEqual({ streams: [] });
    expect(r.parseError).toBeUndefined();
    expect(routesOf(r.attempts)).toEqual([
      { route: "WARP", status: 200, error: undefined },
      { route: "direct", status: 200, error: undefined },
    ]);
  });

  it("recognizes an HTML page by its first byte when the Content-Type is wrong", async () => {
    h.state.handler = () => ({
      status: 200,
      body: "  <!doctype html><p>hi</p>",
      contentType: "application/json",
    });
    const r = await getJson("http://addon/manifest.json", 1000);
    expect(r.parseError?.html).toBe(true);
    expect(h.state.calls).toEqual([true, false]);
  });

  it("reports malformed JSON without retrying the other route", async () => {
    const body = '{"metas":[{"id":"still:1","type":"series" "name":"Still"}]}';
    h.state.handler = () => ({ status: 200, body, contentType: "application/json; charset=utf-8" });
    const r = await getJson("http://addon/catalog/series/still.json", 1000);
    expect(r.data).toBeUndefined();
    expect(r.parseError).toEqual({
      html: false,
      contentType: "application/json; charset=utf-8",
      excerpt: body,
    });
    expect(h.state.calls).toEqual([true]);
  });

  it("drops URLs and key-like tokens from the published excerpt and cuts it short", async () => {
    const body = `oops see https://addon.test/SECRETCONFIG/manifest.json for details, key eyJkZWJyaWQiOiJhYmMxMjM0NTY3ODkwIn0= ${"xy ".repeat(100)}`;
    h.state.handler = () => ({ status: 200, body });
    const r = await getJson("http://addon/manifest.json", 1000);
    expect(r.parseError?.excerpt).not.toContain("SECRETCONFIG");
    expect(r.parseError?.excerpt).not.toContain("eyJ");
    expect(r.parseError?.excerpt.startsWith("oops see … for details, key … xy xy")).toBe(true);
    expect(r.parseError?.excerpt.length).toBeLessThanOrEqual(81);
  });

  it("records a cross-host redirect on the attempt, by hostname only", async () => {
    h.state.handler = () => ({
      status: 200,
      body: JSON.stringify({ meta: {}, payload: {} }),
      contentType: "application/json; charset=utf-8",
      url: "https://github.com/someone/plexio",
    });
    const r = await getJson("https://plexio.stream/manifest.json", 1000);
    expect(r.attempts[0].redirect).toBe("plexio.stream → github.com");
    expect(r.data).toEqual({ meta: {}, payload: {} });
  });

  it("does not record a redirect that stays on the same host", async () => {
    h.state.handler = () => ({
      status: 200,
      body: "{}",
      url: "https://addon.test/other/manifest.json",
    });
    const r = await getJson("https://addon.test/manifest.json", 1000);
    expect(r.attempts[0].redirect).toBeUndefined();
  });

  it("returns undefined data for a non-JSON body", async () => {
    h.state.handler = () => ({ status: 200, body: "<html>not json</html>" });
    const r = await getJson("http://addon/manifest.json", 1000);
    expect(r.status).toBe(200);
    expect(r.data).toBeUndefined();
  });
});

describe("describeParseError", () => {
  it("names an HTML page and publishes its title", () => {
    expect(
      describeParseError({
        html: true,
        contentType: "text/html",
        title: "Just a moment...",
        excerpt: "<!DOCTYPE html>",
      }),
    ).toEqual({
      summary: "HTML page",
      reason: "HTML page instead of JSON",
      details: [
        { label: "Content-Type", value: "text/html" },
        { label: "Page title", value: "Just a moment..." },
      ],
    });
  });

  it("names malformed JSON and shows the start of the body", () => {
    expect(
      describeParseError({ html: false, contentType: "application/json", excerpt: '{"metas":[' }),
    ).toEqual({
      summary: "not valid JSON",
      reason: "response is not valid JSON",
      details: [
        { label: "Content-Type", value: "application/json" },
        { label: "Body", value: '{"metas":[' },
      ],
    });
  });

  it("says when the body was empty or untyped", () => {
    expect(describeParseError({ html: false, excerpt: "" }).details).toEqual([
      { label: "Content-Type", value: "none" },
      { label: "Body", value: "empty" },
    ]);
  });
});
