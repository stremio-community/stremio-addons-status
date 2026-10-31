import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared, hoisted so the vi.mock factories below can reference them.
const h = vi.hoisted(() => ({
  PROXY: { __proxy: true } as object,
  state: {
    handler: (_url: string, _viaProxy: boolean): { status: number; body: string } => ({
      status: 200,
      body: "{}",
    }),
    calls: [] as boolean[],
  },
}));

vi.mock("fetch-socks", () => ({ socksDispatcher: () => h.PROXY }));
vi.mock("undici", () => ({
  fetch: async (url: string, opts: { dispatcher?: unknown }) => {
    const viaProxy = opts?.dispatcher === h.PROXY;
    h.state.calls.push(viaProxy);
    const r = h.state.handler(url, viaProxy);
    return { status: r.status, text: async () => r.body };
  },
}));

// A proxy must be configured for the fallback path to exist.
process.env.PROXY_URL = "socks5://warp:1080";
const { getJson, attemptsOf, RequestFailedError } = await import("./http.js");

/** Attempts without their timing, which varies from run to run. */
function routesOf(attempts: Array<{ route: string; status?: number; error?: string }>) {
  return attempts.map(({ route, status, error }) => ({ route, status, error }));
}

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

  it("returns undefined data for a non-JSON body", async () => {
    h.state.handler = () => ({ status: 200, body: "<html>not json</html>" });
    const r = await getJson("http://addon/manifest.json", 1000);
    expect(r.status).toBe(200);
    expect(r.data).toBeUndefined();
  });
});
