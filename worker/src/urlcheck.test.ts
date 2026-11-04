import { describe, it, expect, vi, beforeEach } from "vitest";

type FakeResponse = {
  status: number;
  body?: string | Uint8Array;
  contentType?: string;
  headers?: Record<string, string>;
};
type Handler = (
  url: string,
  route: "WARP" | "direct",
  headers: Record<string, string>,
) => FakeResponse | Error;

const h = vi.hoisted(() => ({
  PROXY: { __proxy: true } as object,
  state: {
    handler: (() => ({ status: 200 })) as Handler,
    missingHosts: new Set<string>(),
    lookups: [] as string[],
    requests: [] as Array<{ url: string; route: string; headers: Record<string, string> }>,
  },
}));

vi.mock("fetch-socks", () => ({ socksDispatcher: () => h.PROXY }));
vi.mock("node:dns/promises", () => ({
  lookup: async (host: string) => {
    h.state.lookups.push(host);
    if (h.state.missingHosts.has(host)) {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    }
    return { address: "192.0.2.1", family: 4 };
  },
}));
vi.mock("undici", () => ({
  fetch: async (url: string, opts: { dispatcher?: unknown; headers?: Record<string, string> }) => {
    const route = opts?.dispatcher === h.PROXY ? "WARP" : "direct";
    const headers = opts?.headers ?? {};
    h.state.requests.push({ url, route, headers });
    const r = h.state.handler(url, route, headers);
    if (r instanceof Error) throw r;
    return {
      status: r.status,
      url,
      headers: new Headers({
        ...(r.contentType ? { "content-type": r.contentType } : {}),
        ...r.headers,
      }),
      body: new Response(r.body ?? "").body,
    };
  },
}));

process.env.PROXY_URL = "socks5://warp:1080";
const {
  checkUrl,
  describeUrlChecks,
  followLink,
  isProtectedUrl,
  judgeResponse,
  negativeControlId,
  urlsToCheck,
} = await import("./urlcheck.js");

beforeEach(() => {
  h.state.handler = () => ({ status: 206, contentType: "video/mp4", body: MP4 });
  h.state.missingHosts = new Set();
  h.state.lookups = [];
  h.state.requests = [];
});

const MP4 = new Uint8Array([0, 0, 0, 0x20, ...[..."ftypisom"].map((c) => c.charCodeAt(0))]);
const NOW = Date.parse("2026-11-04T18:00:00Z");

/** Cloudflare R2 with public access switched off, as Cartoon Aziz's bucket answers every file. */
const R2_DISABLED = `<!doctype html><html lang="en"><head><title>Forbidden</title><style>body { font-family: system-ui; }</style></head><body><div><h1>Error 403</h1><h2>This bucket cannot be viewed</h2><p>You are not authorized to view this bucket</p><p>This bucket does not exist or is not publicly accessible at this URL. Check the URL of the bucket that you’re looking for or contact the owner to enable Public access.</p></div></body></html>`;
/** archive.org for an item it took down ("dark"), as Ultrapelis's episode file answers. */
const ARCHIVE_DARK = `<!DOCTYPE html><html lang="en"><head><title>Item not available</title><link href="/about/css/ia.css?v=1" rel="stylesheet"></head><body><h1>Item not available</h1></body></html>`;
const NGINX_403 = `<html>\n<head><title>403 Forbidden</title></head>\n<body>\n<center><h1>403 Forbidden</h1></center>\n<hr><center>nginx</center>\n</body>\n</html>`;
const CLOUDFRONT_GEO = `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN"><HTML><HEAD><TITLE>ERROR: The request could not be satisfied</TITLE></HEAD><BODY><H1>403 ERROR</H1><H2>The request could not be satisfied.</H2><HR noshade size="1px">The Amazon CloudFront distribution is configured to block access from your country.</BODY></HTML>`;
const AKAMAI_DENIED = `<HTML><HEAD>\n<TITLE>Access Denied</TITLE>\n</HEAD><BODY>\n<H1>Access Denied</H1>\n \nYou don't have permission to access "http&#58;&#47;&#47;cdn&#46;test&#47;content&#45;de&#47;x&#46;mp4" on this server.<P>\nReference&#32;&#35;18&#46;61450317</BODY>\n</HTML>`;
const CLOUDFLARE_BLOCKED = `<!DOCTYPE html><html class="no-js" lang="en-US"><head><title>Attention Required! | Cloudflare</title></head><body><div id="cf-error-details"><h1 data-translate="block_headline">Sorry, you have been blocked</h1><h2 class="cf-subheadline">You are unable to access</h2></div></body></html>`;
const S3_DENIED = `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>`;

describe("judgeResponse", () => {
  const judge = (
    r: Partial<Parameters<typeof judgeResponse>[0]> & { body?: string | Uint8Array },
  ) =>
    judgeResponse(
      {
        status: 200,
        url: "https://cdn.test/a.mp4",
        ...r,
        body:
          typeof r.body === "string"
            ? new TextEncoder().encode(r.body)
            : (r.body ?? new Uint8Array()),
      },
      NOW,
    );

  it("plays media types, HLS playlists served as text/plain, DASH manifests and media under a wrong type", () => {
    expect(judge({ status: 206, contentType: "video/mp4", body: MP4 })).toEqual({
      verdict: "playable",
      outcome: "HTTP 206 video/mp4",
    });
    expect(
      judge({ contentType: "text/plain; charset=utf-8", body: "#EXTM3U\n#EXT-X-VERSION:3\n" })
        .verdict,
    ).toBe("playable");
    expect(judge({ contentType: "application/vnd.apple.mpegurl", body: "#EXTM3U" }).verdict).toBe(
      "playable",
    );
    expect(
      judge({ contentType: "application/xml", body: '<?xml version="1.0"?>\n<MPD>' }).verdict,
    ).toBe("playable");
    expect(judge({ contentType: "text/html", body: MP4 }).verdict).toBe("playable");
    expect(
      judge({ contentType: "application/octet-stream", body: new Uint8Array([1, 2, 3]) }).verdict,
    ).toBe("playable");
  });

  it("tells a web page where media is expected from a text or error body, which is dead (StreamPlay's embed player page)", () => {
    expect(
      judge({
        contentType: "text/html",
        body: "<!DOCTYPE html><html><head><title>Vidlink</title>",
      }),
    ).toEqual({ verdict: "webpage", outcome: "HTTP 200 text/html, web page" });
    expect(judge({ contentType: "text/plain", body: "Stream offline" })).toEqual({
      verdict: "dead",
      outcome: "HTTP 200 text/plain, not media",
    });
    expect(
      judge({ contentType: "text/html", body: "<html><h1>Video not found</h1></html>" }).verdict,
    ).toBe("dead");
  });

  it("leaves a 200 challenge page unverifiable", () => {
    expect(
      judge({ contentType: "text/html", body: "<html><title>Just a moment...</title>" }).verdict,
    ).toBe("unverifiable");
  });

  it("calls 404 and 410 dead (HentaiStream's resolver)", () => {
    expect(
      judge({
        status: 404,
        contentType: "text/plain;charset=UTF-8",
        body: "Could not find video URL",
      }),
    ).toEqual({
      verdict: "dead",
      outcome: "HTTP 404 text/plain",
    });
    expect(judge({ status: 410 }).verdict).toBe("dead");
  });

  it("calls a 4xx page saying the file is gone dead (R2 bucket without public access, archive.org dark item)", () => {
    expect(judge({ status: 403, contentType: "text/html", body: R2_DISABLED })).toEqual({
      verdict: "dead",
      outcome: "HTTP 403 text/html, gone",
    });
    expect(
      judge({ status: 403, contentType: "text/html; charset=utf-8", body: ARCHIVE_DARK }).verdict,
    ).toBe("dead");
  });

  it("calls a 403 on a signed link whose expiry has passed dead (SID VOD's Seedr link)", () => {
    const expiredLink = "https://nw18.seedr.test/ff_get/1/2/file.mkv?st=abc&e=1783442577";
    expect(
      judge({ status: 403, contentType: "text/html", body: NGINX_403, url: expiredLink }),
    ).toEqual({
      verdict: "dead",
      outcome: "HTTP 403 text/html, link expired",
    });
    const valid = "https://nw18.seedr.test/ff_get/1/2/file.mkv?st=abc&e=1893456000";
    expect(judge({ status: 403, body: NGINX_403, url: valid }).verdict).toBe("unverifiable");
  });

  it("leaves geo blocks, WAF pages and bare refusals unverifiable (Israeli TV, MediathekView, Georgia TV, Tvvio, Shadzop)", () => {
    expect(judge({ status: 403, contentType: "text/html", body: CLOUDFRONT_GEO })).toEqual({
      verdict: "unverifiable",
      outcome: "HTTP 403 text/html, blocked",
    });
    expect(judge({ status: 403, contentType: "text/html", body: AKAMAI_DENIED }).verdict).toBe(
      "unverifiable",
    );
    expect(judge({ status: 403, denyReason: "backend_denied" }).verdict).toBe("unverifiable");
    // SIC's Opto titles: Kaltura's 404 for a geo-restricted entry.
    expect(
      judge({
        status: 404,
        contentType: "text/html; charset=UTF-8",
        denyReason: "exiting on error 3 - entry restricted due to access-control",
      }).verdict,
    ).toBe("unverifiable");
    expect(judge({ status: 403, contentType: "text/html", body: CLOUDFLARE_BLOCKED }).verdict).toBe(
      "unverifiable",
    );
    expect(judge({ status: 403, contentType: "application/xml", body: S3_DENIED }).verdict).toBe(
      "unverifiable",
    );
    expect(
      judge({
        status: 403,
        contentType: "application/json",
        body: '{"error":"Stream server returned 403"}',
      }).verdict,
    ).toBe("unverifiable");
  });

  it("leaves rate limits and server errors unverifiable, whatever they say (Flix-Streams' resolver)", () => {
    expect(judge({ status: 429, body: "not found" }).verdict).toBe("unverifiable");
    expect(judge({ status: 502, body: "Bad Gateway" }).verdict).toBe("unverifiable");
    expect(judge({ status: 500, body: '{"error":"dlstreams_stream_unavailable"}' }).verdict).toBe(
      "unverifiable",
    );
  });
});

describe("checkUrl", () => {
  const plain = (url: string, headers: Record<string, string> = {}) =>
    checkUrl({ url, headers }, NOW);

  it("plays on the first route that serves media, sending a ranged GET", async () => {
    expect(await plain("https://cdn.test/a.mp4")).toEqual({
      host: "cdn.test",
      verdict: "playable",
      outcome: "HTTP 206 video/mp4",
    });
    expect(h.state.requests).toHaveLength(1);
    expect(h.state.requests[0]).toMatchObject({
      route: "WARP",
      headers: { Range: "bytes=0-1023" },
    });
  });

  it("sends the stream's proxy headers, which MovieBox CDNs need to answer anything but 429", async () => {
    h.state.handler = (_url, _route, headers) =>
      headers.Referer === "https://moviebox.test/"
        ? { status: 206, contentType: "video/mp4", body: MP4 }
        : { status: 429 };
    const r = await plain("https://hakunaymatata.test/a.mp4", {
      Referer: "https://moviebox.test/",
      "User-Agent": "okhttp/4.12.0",
    });
    expect(r.verdict).toBe("playable");
    expect(h.state.requests[0].headers["User-Agent"]).toBe("okhttp/4.12.0");
  });

  it("calls a host missing from DNS dead once WARP can't reach it either, without a direct request (FTV Channels)", async () => {
    h.state.missingHosts.add("fash1.erosnow.test");
    h.state.handler = () =>
      Object.assign(new TypeError("fetch failed"), {
        cause: new Error("Socks5 proxy rejected connection - HostUnreachable"),
      });
    expect(await plain("https://fash1.erosnow.test/live.m3u8")).toEqual({
      host: "fash1.erosnow.test",
      verdict: "dead",
      outcome: "NXDOMAIN",
    });
    expect(h.state.requests.map((r) => r.route)).toEqual(["WARP"]);
  });

  it("believes WARP over a local resolver that hides a host", async () => {
    h.state.missingHosts.add("blocked-by-isp.test");
    expect((await plain("https://blocked-by-isp.test/a.mp4")).verdict).toBe("playable");
  });

  it("is dead only when both routes say so", async () => {
    h.state.handler = (_url, route) =>
      route === "WARP" ? { status: 404 } : { status: 206, contentType: "video/mp4", body: MP4 };
    expect((await plain("https://cdn.test/a.mp4")).verdict).toBe("playable");

    h.state.handler = () => ({ status: 404 });
    expect((await plain("https://cdn.test/a.mp4")).verdict).toBe("dead");

    h.state.handler = (_url, route) =>
      route === "WARP" ? { status: 403, body: CLOUDFRONT_GEO } : { status: 404 };
    expect((await plain("https://cdn.test/a.mp4")).verdict).toBe("unverifiable");
  });

  it("reads access control from Flussonic's and Kaltura's headers", async () => {
    h.state.handler = () => ({
      status: 404,
      contentType: "text/html; charset=UTF-8",
      headers: { "x-kaltura-app": "exiting on error 3 - entry restricted due to access-control" },
    });
    expect((await plain("https://cdnapisec.kaltura.test/p/1/playManifest/a.m3u8")).verdict).toBe(
      "unverifiable",
    );
    h.state.handler = () => ({ status: 403, headers: { "x-deny-reason": "backend_denied" } });
    expect((await plain("http://dvr.bozz.test/gin-x/index.m3u8")).verdict).toBe("unverifiable");
  });

  it("calls a refused connection dead and a timeout unverifiable", async () => {
    h.state.handler = () =>
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED 192.0.2.1:443"), {
          code: "ECONNREFUSED",
        }),
      });
    expect(await plain("https://cdn.test/a.mp4")).toMatchObject({
      verdict: "dead",
      outcome: "connection refused",
    });

    h.state.handler = () => Object.assign(new Error("aborted"), { name: "TimeoutError" });
    expect(await plain("https://cdn.test/a.mp4")).toMatchObject({
      verdict: "unverifiable",
      outcome: "timed out",
    });
    // A timeout can't make the URL dead, so the other route isn't asked.
    expect(h.state.requests.at(-1)?.route).toBe("WARP");
    expect(h.state.requests.filter((r) => r.url === "https://cdn.test/a.mp4")).toHaveLength(3);
  });
});

describe("describeUrlChecks", () => {
  it("counts verdicts and lists each host with its outcome", () => {
    expect(
      describeUrlChecks([
        { host: "vidlink.test", verdict: "dead", outcome: "HTTP 200 text/html, not media" },
        { host: "vidsrc.test", verdict: "dead", outcome: "NXDOMAIN" },
      ]),
    ).toBe("2 dead of 2 · vidlink.test: HTTP 200 text/html, not media; vidsrc.test: NXDOMAIN");
  });
});

describe("isProtectedUrl", () => {
  const CONFIGURED = "https://addon.test/eyJjb25maWciOnRydWV9";
  const PLAIN = "https://addon.test";

  it("never lets the worker request a debrid service or a debrid-looking path", () => {
    expect(isProtectedUrl("https://download.real-debrid.com/d/X/file.mkv", PLAIN)).toBe(true);
    expect(isProtectedUrl("https://api.torbox.app/v1/x", PLAIN)).toBe(true);
    expect(isProtectedUrl("https://comet.test/playback/realdebrid/key/hash", PLAIN)).toBe(true);
    expect(isProtectedUrl("https://other.test/rd/hash/0", PLAIN)).toBe(true);
  });

  it("skips a configured addon's own resolve and playback routes, which add torrents to its user's account", () => {
    expect(isProtectedUrl("https://addon.test/resolve/abc/0", CONFIGURED)).toBe(true);
    expect(isProtectedUrl("https://addon.test/cfg/playback/abc", CONFIGURED)).toBe(true);
    expect(isProtectedUrl("https://addon.test/play/abc", CONFIGURED)).toBe(true);
  });

  it("checks an unconfigured addon's own proxy and any plain CDN URL (HentaiStream, Israeli TV)", () => {
    expect(isProtectedUrl("https://addon.test/video-proxy?jwplayer=x", PLAIN)).toBe(false);
    expect(isProtectedUrl("https://addon.test/resolve/abc", PLAIN)).toBe(false);
    expect(isProtectedUrl("https://cdn.test/live/playlist.m3u8", CONFIGURED)).toBe(false);
  });
});

describe("urlsToCheck", () => {
  it("takes the first two URLs with their proxy headers", () => {
    const streams = [1, 2, 3].map((n) => ({
      url: `https://cdn.test/${n}.m3u8`,
      behaviorHints: { proxyHeaders: { request: { Referer: "https://site.test/", Bad: 1 } } },
    }));
    expect(urlsToCheck(streams, "https://addon.test")).toEqual([
      { url: "https://cdn.test/1.m3u8", headers: { Referer: "https://site.test/" } },
      { url: "https://cdn.test/2.m3u8", headers: { Referer: "https://site.test/" } },
    ]);
  });

  it("checks nothing when a playable stream isn't a URL the worker may request", () => {
    const url = { url: "https://cdn.test/1.mp4" };
    expect(urlsToCheck([url, { infoHash: "a".repeat(40) }], "https://addon.test")).toEqual([]);
    expect(
      urlsToCheck([url, { url: "https://x.real-debrid.com/d/1" }], "https://addon.test"),
    ).toEqual([]);
  });
});

describe("followLink", () => {
  const page = (title: string, h1: string, body = "") =>
    `<!DOCTYPE html><html><head><title>${title}</title></head><body><nav>Sign in</nav><h1>${h1}</h1>${body}</body></html>`;

  it("reads a per-title page asking for an API key as needing configuration (Content Deep Dive Companion)", async () => {
    h.state.handler = () => ({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: page(
        "API Key Required - Content Deep Dive",
        "API Key Required",
        "<p>You need to add your own TMDb API key to view deep dives</p>",
      ),
    });
    expect(await followLink("https://deepdive.test/deep_dive/tt1375666")).toEqual({
      host: "deepdive.test",
      status: 200,
      label: "API Key Required - Content Deep Dive",
      placeholder: "needs-config",
    });
    expect(h.state.requests[0].headers.Range).toBeUndefined();
  });

  it("ignores navigation in the page body (MoviesInDetail, IMDb.su)", async () => {
    h.state.handler = () => ({
      status: 200,
      contentType: "text/html",
      body: page(
        "Movies in Detail – One place for trailers, images, soundtracks &amp; reviews",
        "All your movie and TV show links in one place",
      ),
    });
    expect(await followLink("https://moviesindetail.test/?q=tt9999999999")).toEqual({
      host: "moviesindetail.test",
      status: 200,
      label: "Movies in Detail – One place for trailers, images, soundtracks & reviews",
      placeholder: undefined,
    });
  });

  it("tries the other route when one fails, and reports no answer when both do", async () => {
    h.state.handler = () => new TypeError("fetch failed");
    expect(await followLink("https://site.test/x")).toEqual({ host: "site.test" });
    expect(h.state.requests.map((r) => r.route)).toEqual(["WARP", "direct"]);
  });
});

describe("negativeControlId", () => {
  it("shapes an ID no title has like the target's", () => {
    expect(negativeControlId("tt0111161", ["tt"])).toBe("tt9999999999");
    expect(negativeControlId("tt0903747:1:1", ["tt"])).toBe("tt9999999999:1:1");
    expect(negativeControlId("rotv-Antena1.ro", ["rotv-"])).toBe("rotv-__status_probe__");
    expect(negativeControlId("kitsu:1:1", [])).toBe("kitsu:__status_probe__");
    expect(negativeControlId("ftv_paris", [])).toBe("__status_probe__");
  });
});
