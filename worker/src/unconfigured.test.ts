import { describe, expect, it, vi } from "vitest";
import type { Manifest } from "@stremio-addon/sdk";
import type { Attempt, JsonResult, ParseError } from "./http.js";

let configurePage: JsonResult<unknown> | Error;

vi.mock("./http.js", () => ({
  getJson: async () => {
    if (configurePage instanceof Error) throw configurePage;
    return configurePage;
  },
}));

const { missingRouteStatus, unconfiguredReason } = await import("./unconfigured.js");
type ContentAnswer = import("./unconfigured.js").ContentAnswer;

const configurable = {
  id: "x",
  name: "x",
  version: "1",
  types: ["movie"],
  catalogs: [],
  resources: ["stream"],
  behaviorHints: { configurable: true },
} as Manifest;

const attempt = (route: Attempt["route"], status: number): Attempt => ({
  route,
  status,
  durationMs: 1,
});

const EXPRESS_404: ParseError = {
  html: true,
  contentType: "text/html; charset=utf-8",
  title: "Error",
  excerpt: '<!DOCTYPE html> <html lang="en"> <head> <meta charset="utf-8"> <title>Error</title>',
};

const expressCannotGet: ContentAnswer = {
  status: 404,
  data: undefined,
  parseError: EXPRESS_404,
  attempts: [attempt("WARP", 404)],
};

const manifestOverWarp = [attempt("WARP", 200)];

describe("missingRouteStatus", () => {
  it("recognises Express's Cannot GET page (Magnetio, Zamunda BG)", () => {
    expect(missingRouteStatus(expressCannotGet, manifestOverWarp)).toBe(404);
  });

  it("recognises FastAPI's not-found body (ItsOut | ElfHosted, Cauldron)", () => {
    const fastApi = { ...expressCannotGet, data: { detail: "Not Found" }, parseError: undefined };
    expect(missingRouteStatus(fastApi, manifestOverWarp)).toBe(404);
  });

  it("recognises a plain-text 404", () => {
    const text = {
      ...expressCannotGet,
      parseError: { html: false, contentType: "text/plain", excerpt: "404 Not Found" },
    };
    expect(missingRouteStatus(text, manifestOverWarp)).toBe(404);
  });

  it("recognises a JSON not-found message naming the path (Premiumize Library)", () => {
    const own = {
      ...expressCannotGet,
      data: { message: "Not Found - /stream/movie/tt0111161.json" },
      parseError: undefined,
    };
    expect(missingRouteStatus(own, manifestOverWarp)).toBe(404);
  });

  it("doesn't take a JSON 404 the addon chose to send for a missing route", () => {
    const own = {
      ...expressCannotGet,
      data: { err: "not restricted by this add-on" },
      parseError: undefined,
    };
    expect(missingRouteStatus(own, manifestOverWarp)).toBeUndefined();
  });

  it("takes a 403 on both routes while the manifest loaded over one of them (Comet | ElfHosted)", () => {
    const forbidden: ContentAnswer = {
      status: 403,
      data: undefined,
      parseError: { html: false, contentType: "text/plain", excerpt: "Forbidden" },
      attempts: [attempt("WARP", 403), attempt("direct", 403)],
    };
    expect(missingRouteStatus(forbidden, manifestOverWarp)).toBe(403);
    expect(
      missingRouteStatus(forbidden, [attempt("WARP", 403), attempt("direct", 502)]),
    ).toBeUndefined();
  });

  it("doesn't take a 403 that another route answered differently", () => {
    const mixed: ContentAnswer = {
      status: 403,
      data: undefined,
      attempts: [attempt("WARP", 502), attempt("direct", 403)],
    };
    expect(missingRouteStatus(mixed, manifestOverWarp)).toBeUndefined();
  });

  it("doesn't take an error status that says nothing about routes (Flix-Streams, MediaLib)", () => {
    expect(
      missingRouteStatus(
        { status: 400, data: { streams: [] }, attempts: [attempt("WARP", 400)] },
        manifestOverWarp,
      ),
    ).toBeUndefined();
    expect(missingRouteStatus(undefined, manifestOverWarp)).toBeUndefined();
  });
});

describe("unconfiguredReason", () => {
  const BASE = "https://addon.test";
  const CONFIGURE_PAGE: JsonResult<unknown> = {
    status: 200,
    data: undefined,
    parseError: {
      html: true,
      contentType: "text/html",
      title: "Configure",
      excerpt: "<!DOCTYPE html>",
    },
    attempts: [attempt("WARP", 200)],
  };

  it("names the status when every primary request missed a route on a configurable addon", async () => {
    configurePage = CONFIGURE_PAGE;
    expect(
      await unconfiguredReason(
        configurable,
        [expressCannotGet, expressCannotGet],
        manifestOverWarp,
        BASE,
      ),
    ).toBe("unconfigured content routes answer HTTP 404");
  });

  it("needs every request to miss a route", async () => {
    configurePage = CONFIGURE_PAGE;
    const empty: ContentAnswer = {
      status: 200,
      data: { streams: [] },
      attempts: [attempt("WARP", 200)],
    };
    expect(
      await unconfiguredReason(configurable, [expressCannotGet, empty], manifestOverWarp, BASE),
    ).toBeUndefined();
    expect(await unconfiguredReason(configurable, [], manifestOverWarp, BASE)).toBeUndefined();
  });

  it("takes missing routes on a manifest that doesn't say it is configurable, if it serves a configure page (Cauldron, Premiumize Library)", async () => {
    configurePage = CONFIGURE_PAGE;
    const plain = { ...configurable, behaviorHints: {} } as Manifest;
    const fastApi = { ...expressCannotGet, data: { detail: "Not Found" }, parseError: undefined };
    expect(await unconfiguredReason(plain, [fastApi], manifestOverWarp, BASE)).toBe(
      "unconfigured content routes answer HTTP 404",
    );
  });

  it("needs a configure page when the manifest doesn't say it is configurable (40th PROJECT's static 404s)", async () => {
    configurePage = { ...CONFIGURE_PAGE, status: 404, attempts: [attempt("WARP", 404)] };
    const plain = { ...configurable, behaviorHints: {} } as Manifest;
    expect(
      await unconfiguredReason(plain, [expressCannotGet], manifestOverWarp, BASE),
    ).toBeUndefined();
  });

  it("doesn't take a 403 on a manifest that doesn't say it is configurable", async () => {
    configurePage = CONFIGURE_PAGE;
    const plain = { ...configurable, behaviorHints: {} } as Manifest;
    const forbidden: ContentAnswer = {
      status: 403,
      data: undefined,
      parseError: EXPRESS_404,
      attempts: [attempt("WARP", 403), attempt("direct", 403)],
    };
    expect(await unconfiguredReason(plain, [forbidden], manifestOverWarp, BASE)).toBeUndefined();
  });

  it("doesn't take missing routes on a listed URL that already carries a config (Cinemeta of Audiobooks)", async () => {
    configurePage = CONFIGURE_PAGE;
    const configured = `${BASE}/%7B%22hide_explicit%22%3Atrue%7D`;
    expect(
      await unconfiguredReason(configurable, [expressCannotGet], manifestOverWarp, configured),
    ).toBeUndefined();
  });

  it("needs a configure page on the addon's own host (Easynews while its backend timed out)", async () => {
    configurePage = { ...CONFIGURE_PAGE, status: 504, attempts: [attempt("WARP", 504)] };
    expect(
      await unconfiguredReason(configurable, [expressCannotGet], manifestOverWarp, BASE),
    ).toBeUndefined();
    configurePage = new Error("fetch failed");
    expect(
      await unconfiguredReason(configurable, [expressCannotGet], manifestOverWarp, BASE),
    ).toBeUndefined();
  });

  it("doesn't take a configure link leading to another site (TOP Posters' personal wrapper URL)", async () => {
    configurePage = {
      ...CONFIGURE_PAGE,
      attempts: [{ ...attempt("WARP", 200), redirect: "api.top-posters.com → top-posters.com" }],
    };
    expect(
      await unconfiguredReason(configurable, [expressCannotGet], manifestOverWarp, BASE),
    ).toBeUndefined();
  });
});
