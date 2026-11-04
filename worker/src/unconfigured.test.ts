import { describe, expect, it } from "vitest";
import type { Manifest } from "@stremio-addon/sdk";
import type { Attempt, ParseError } from "./http.js";
import { missingRouteStatus, unconfiguredReason, type ContentAnswer } from "./unconfigured.js";

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
  it("names the status when every primary request missed a route on a configurable addon", () => {
    expect(
      unconfiguredReason(configurable, [expressCannotGet, expressCannotGet], manifestOverWarp),
    ).toBe("unconfigured content routes answer HTTP 404");
  });

  it("needs every request to miss a route", () => {
    const empty: ContentAnswer = {
      status: 200,
      data: { streams: [] },
      attempts: [attempt("WARP", 200)],
    };
    expect(
      unconfiguredReason(configurable, [expressCannotGet, empty], manifestOverWarp),
    ).toBeUndefined();
    expect(unconfiguredReason(configurable, [], manifestOverWarp)).toBeUndefined();
  });

  it("needs a manifest that offers configuration (40th PROJECT's static 404s)", () => {
    const plain = { ...configurable, behaviorHints: {} } as Manifest;
    expect(unconfiguredReason(plain, [expressCannotGet], manifestOverWarp)).toBeUndefined();
  });
});
