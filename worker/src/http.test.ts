import { describe, it, expect, vi, beforeEach } from "vitest";

/** `url` is where redirects ended up; it defaults to the requested URL. */
type FakeResponse = {
  status: number;
  body: string;
  contentType?: string;
  url?: string;
  retryAfter?: string;
};

// Shared, hoisted so the vi.mock factories below can reference them.
const h = vi.hoisted(() => ({
  PROXY: { __proxy: true } as object,
  state: {
    handler: (_url: string, _viaProxy: boolean): FakeResponse => ({ status: 200, body: "{}" }),
    calls: [] as boolean[],
    sleeps: [] as number[],
  },
}));

vi.mock("./utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./utils.js")>()),
  sleep: async (ms: number) => {
    h.state.sleeps.push(ms);
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
      headers: new Headers({
        ...(r.contentType ? { "content-type": r.contentType } : {}),
        ...(r.retryAfter !== undefined ? { "retry-after": r.retryAfter } : {}),
      }),
      text: async () => r.body,
    };
  },
}));

// A proxy must be configured for the fallback path to exist.
process.env.PROXY_URL = "socks5://warp:1080";
const {
  getJson,
  attemptsOf,
  describeParseError,
  describeRequestError,
  describeStatus,
  retryAfterOf,
  softBlockNote,
  RequestFailedError,
} = await import("./http.js");

/** Attempts without their timing, which varies from run to run. */
function routesOf(attempts: Array<{ route: string; status?: number; error?: string }>) {
  return attempts.map(({ route, status, error }) => ({ route, status, error }));
}

/** Cloudflare's challenge page, as served with HTTP 200 to a blocked egress IP. */
const CHALLENGE_PAGE = `<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title><meta http-equiv="refresh" content="390"></head><body><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script></body></html>`;

beforeEach(() => {
  h.state.handler = () => ({ status: 200, body: "{}" });
  h.state.calls = [];
  h.state.sleeps = [];
});

/** Answers from a per-route queue, so a test can script what each successive try on a route gets. */
function scripted(warp: Array<FakeResponse | Error>, direct: Array<FakeResponse | Error>) {
  return (_url: string, viaProxy: boolean): FakeResponse => {
    const next = (viaProxy ? warp : direct).shift();
    if (!next) throw new Error(`unexpected ${viaProxy ? "WARP" : "direct"} request`);
    if (next instanceof Error) throw next;
    return next;
  };
}

const timeoutError = () => Object.assign(new Error("aborted"), { name: "TimeoutError" });
const json = (status: number, body: unknown, retryAfter?: string): FakeResponse => ({
  status,
  body: JSON.stringify(body),
  contentType: "application/json",
  ...(retryAfter !== undefined ? { retryAfter } : {}),
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

describe("getJson Retry-After", () => {
  it("waits out a short Retry-After on a 429 and retries the same route", async () => {
    h.state.handler = scripted([json(429, {}, "1"), json(200, { ok: 1 })], []);
    const r = await getJson("http://addon/manifest.json", 1000);
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ ok: 1 });
    expect(h.state.sleeps).toEqual([1000]);
    expect(routesOf(r.attempts)).toEqual([
      { route: "WARP", status: 429, error: undefined },
      { route: "WARP", status: 200, error: undefined },
    ]);
  });

  it("honours Retry-After once per route, then falls back to the other route", async () => {
    h.state.handler = scripted(
      [json(429, {}, "1"), json(429, {}, "1")],
      [json(429, {}, "2"), json(200, { ok: 1 })],
    );
    const r = await getJson("http://addon/manifest.json", 1000);
    expect(r.status).toBe(200);
    expect(h.state.sleeps).toEqual([1000, 2000]);
    expect(h.state.calls).toEqual([true, true, false, false]);
  });

  it("does the same for a 503 with Retry-After", async () => {
    h.state.handler = scripted([json(503, {}, "3"), json(200, { ok: 1 })], []);
    const r = await getJson("http://addon/manifest.json", 1000);
    expect(r.status).toBe(200);
    expect(h.state.sleeps).toEqual([3000]);
  });

  it("does not wait for a long Retry-After or without one", async () => {
    h.state.handler = scripted([json(429, {}, "60")], [json(429, {})]);
    const r = await getJson("http://addon/manifest.json", 1000);
    expect(r.status).toBe(429);
    expect(h.state.sleeps).toEqual([]);
    expect(h.state.calls).toEqual([true, false]);
  });

  it("parses Retry-After as seconds or as an HTTP-date", () => {
    const now = Date.parse("Wed, 04 Nov 2026 12:00:00 GMT");
    expect(retryAfterOf("2", now)).toBe(2000);
    expect(retryAfterOf("Wed, 04 Nov 2026 12:00:05 GMT", now)).toBe(5000);
    expect(retryAfterOf("Wed, 04 Nov 2026 11:59:00 GMT", now)).toBe(0);
    expect(retryAfterOf("soon", now)).toBeUndefined();
    expect(retryAfterOf(null, now)).toBeUndefined();
  });
});

describe("getJson retry option", () => {
  it("retries once after a pause when every route times out, and only the final outcome counts", async () => {
    h.state.handler = scripted([timeoutError(), json(200, { ok: 1 })], [timeoutError()]);
    const r = await getJson("http://addon/manifest.json", 1000, { retry: true });
    expect(r.status).toBe(200);
    expect(h.state.sleeps).toEqual([2000]);
    expect(routesOf(r.attempts)).toEqual([
      { route: "WARP", status: undefined, error: "timed out after 1000ms" },
      { route: "direct", status: undefined, error: "timed out after 1000ms" },
      { route: "WARP", status: 200, error: undefined },
    ]);
  });

  it("retries the route that timed out rather than the one that refused", async () => {
    h.state.handler = scripted(
      [new Error("fetch failed", { cause: { code: "ECONNREFUSED" } })],
      [timeoutError(), json(200, { ok: 1 })],
    );
    const r = await getJson("http://addon/manifest.json", 1000, { retry: true });
    expect(r.status).toBe(200);
    expect(h.state.calls).toEqual([true, false, false]);
  });

  it("retries a route that failed even when the other one answered blocked", async () => {
    h.state.handler = scripted([json(403, {})], [timeoutError(), json(200, { ok: 1 })]);
    const r = await getJson("http://addon/manifest.json", 1000, { retry: true });
    expect(r.status).toBe(200);
    expect(h.state.calls).toEqual([true, false, false]);
  });

  it("throws every attempt when the retry fails too", async () => {
    h.state.handler = scripted([timeoutError(), timeoutError()], [timeoutError()]);
    const err = await getJson("http://addon/manifest.json", 1000, { retry: true }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RequestFailedError);
    expect(attemptsOf(err)).toHaveLength(3);
    expect(attemptsOf(err).every((a) => a.timedOut)).toBe(true);
  });

  it("does not retry without the option", async () => {
    h.state.handler = scripted([timeoutError()], [timeoutError()]);
    await expect(getJson("http://addon/manifest.json", 1000)).rejects.toBeInstanceOf(
      RequestFailedError,
    );
    expect(h.state.sleeps).toEqual([]);
  });

  it("does not retry when a route gave a final answer", async () => {
    h.state.handler = scripted([timeoutError()], [json(404, {})]);
    const r = await getJson("http://addon/stream/movie/tt1.json", 1000, { retry: true });
    expect(r.status).toBe(404);
    expect(h.state.calls).toEqual([true, false]);
  });
});

describe("getJson usable option", () => {
  const PLAYABLE = { streams: [{ name: "1080p", url: "https://cdn.example/v.mp4" }] };
  const hasStreams = (d: { streams?: unknown[] }) => (d.streams?.length ?? 0) > 0;

  it("takes direct's playable answer over WARP's empty 200 and lists both attempts", async () => {
    h.state.handler = scripted([json(200, { streams: [] })], [json(200, PLAYABLE)]);
    const r = await getJson("http://addon/stream/movie/tt0111161.json", 1000, {
      usable: hasStreams,
    });
    expect(r.data).toEqual(PLAYABLE);
    expect(r.softBlockedOn).toBe("WARP");
    expect(softBlockNote(r)).toBe("soft-blocked on WARP");
    expect(routesOf(r.attempts)).toEqual([
      { route: "WARP", status: 200, error: undefined },
      { route: "direct", status: 200, error: undefined },
    ]);
  });

  it("keeps WARP's answer when direct has nothing better", async () => {
    h.state.handler = scripted([json(200, { streams: [] })], [json(500, {})]);
    const r = await getJson("http://addon/stream/movie/tt1.json", 1000, { usable: hasStreams });
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ streams: [] });
    expect(r.softBlockedOn).toBeUndefined();
    expect(softBlockNote(r)).toBeUndefined();
  });

  it("does not ask direct when WARP's answer is usable", async () => {
    h.state.handler = scripted([json(200, PLAYABLE)], []);
    const r = await getJson("http://addon/stream/movie/tt1.json", 1000, { usable: hasStreams });
    expect(r.data).toEqual(PLAYABLE);
    expect(h.state.calls).toEqual([true]);
  });

  it("does not judge a non-2xx answer", async () => {
    const usable = vi.fn(() => false);
    h.state.handler = scripted([json(404, { streams: [] })], []);
    const r = await getJson("http://addon/stream/movie/tt1.json", 1000, { usable });
    expect(r.status).toBe(404);
    expect(usable).not.toHaveBeenCalled();
  });

  it("retries a route that timed out after an empty answer from the other", async () => {
    h.state.handler = scripted([json(200, { streams: [] })], [timeoutError(), json(200, PLAYABLE)]);
    const r = await getJson("http://addon/stream/movie/tt1.json", 1000, {
      usable: hasStreams,
      retry: true,
    });
    expect(r.data).toEqual(PLAYABLE);
    expect(r.softBlockedOn).toBe("WARP");
    expect(h.state.calls).toEqual([true, false, false]);
  });
});

describe("describeRequestError", () => {
  it("says timed out when every attempt timed out", async () => {
    h.state.handler = () => {
      throw timeoutError();
    };
    const err = await getJson("http://addon/manifest.json", 15000).catch((e: unknown) => e);
    expect(describeRequestError(err)).toEqual({
      summary: "timed out",
      reason: "timed out after 15000ms",
    });
  });

  it("says unreachable when any attempt failed otherwise", async () => {
    h.state.handler = scripted(
      [timeoutError()],
      [new Error("fetch failed", { cause: { code: "ENOTFOUND" } })],
    );
    const err = await getJson("http://addon/manifest.json", 1000).catch((e: unknown) => e);
    expect(describeRequestError(err)).toEqual({
      summary: "unreachable",
      reason: "fetch failed (ENOTFOUND)",
    });
  });

  it("says unreachable for an error that didn't come from getJson", () => {
    expect(describeRequestError(new Error("boom")).summary).toBe("unreachable");
  });
});

describe("describeStatus", () => {
  it("surfaces the addon's own JSON error message", () => {
    expect(describeStatus({ status: 503, data: { error: "SOURCE_UNAVAILABLE" } })).toEqual({
      summary: "HTTP 503",
      reason: "addon responded with HTTP 503: SOURCE_UNAVAILABLE",
    });
    expect(describeStatus({ status: 500, data: { error: { message: "db down" } } }).reason).toBe(
      "addon responded with HTTP 500: db down",
    );
    expect(describeStatus({ status: 401, data: { message: "Invalid API key" } }).reason).toBe(
      "addon responded with HTTP 401: Invalid API key",
    );
  });

  it("keeps a URL out of the published message", () => {
    const { reason } = describeStatus({
      status: 502,
      data: { error: "upstream https://addon.test/SECRETCONFIG/stream failed" },
    });
    expect(reason).not.toContain("SECRETCONFIG");
  });

  it("says rate limited for a 429 that outlasted the retries", async () => {
    h.state.handler = scripted(
      [json(429, {}, "1"), json(429, {})],
      [json(429, {}, "2"), json(429, {})],
    );
    const r = await getJson("http://addon/manifest.json", 1000);
    expect(describeStatus(r)).toEqual({
      summary: "rate limited",
      reason: "addon responded with HTTP 429 (rate limited)",
    });
  });

  it("names the status alone without a message", () => {
    expect(describeStatus({ status: 404, data: undefined })).toEqual({
      summary: "HTTP 404",
      reason: "addon responded with HTTP 404",
    });
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
