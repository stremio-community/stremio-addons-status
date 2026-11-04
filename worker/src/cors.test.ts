import { describe, expect, it } from "vitest";
import { allowsStremioWeb, corsAnnotation } from "./cors.js";

describe("allowsStremioWeb", () => {
  it("accepts a wildcard or Stremio Web's exact origin", () => {
    expect(allowsStremioWeb("*")).toBe(true);
    expect(allowsStremioWeb(" https://web.stremio.com ")).toBe(true);
  });

  it("rejects a missing header, another origin or a list", () => {
    expect(allowsStremioWeb(undefined)).toBe(false);
    expect(allowsStremioWeb("https://app.strem.io")).toBe(false);
    expect(allowsStremioWeb("https://web.stremio.com/")).toBe(false);
    expect(allowsStremioWeb("https://web.stremio.com, https://app.strem.io")).toBe(false);
  });
});

describe("corsAnnotation", () => {
  it("annotates a manifest answered without Access-Control-Allow-Origin (Cast List)", () => {
    const a = corsAnnotation("/manifest.json", undefined);
    expect(a).toMatchObject({
      resource: "cors",
      ok: false,
      summary: "missing, fails in Stremio Web",
    });
    expect(a!.details).toContainEqual({ label: "Access-Control-Allow-Origin", value: "none" });
  });

  it("names an origin other than Stremio Web's", () => {
    const a = corsAnnotation("/manifest.json", "https://example.com");
    expect(a?.summary).toBe("other origin, fails in Stremio Web");
    expect(a!.details).toContainEqual({
      label: "Access-Control-Allow-Origin",
      value: "https://example.com",
    });
  });

  it("says nothing when Stremio Web may read the answer", () => {
    expect(corsAnnotation("/manifest.json", "*")).toBeUndefined();
  });
});
