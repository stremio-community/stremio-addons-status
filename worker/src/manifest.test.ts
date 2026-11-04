import { describe, expect, it } from "vitest";
import type { Manifest } from "@stremio-addon/sdk";
import {
  declaredConfigRequirement,
  invitesConfiguration,
  missingManifestFields,
  normalizeResources,
  resourceAccepts,
} from "./manifest.js";

const manifest = (m: Partial<Manifest>): Manifest =>
  ({ id: "x", name: "x", version: "1", types: [], catalogs: [], resources: [], ...m }) as Manifest;

describe("normalizeResources", () => {
  it("inherits types and idPrefixes from the manifest for short-form resources", () => {
    const [stream] = normalizeResources(
      manifest({ resources: ["stream"], types: ["movie"], idPrefixes: ["tt"] }),
    );
    expect(stream).toEqual({ name: "stream", types: ["movie"], idPrefixes: ["tt"] });
  });

  it("keeps a full resource's own scope", () => {
    const [meta] = normalizeResources(
      manifest({
        types: ["movie", "series"],
        idPrefixes: ["tt"],
        resources: [{ name: "meta", types: ["series"], idPrefixes: ["had:episode:"] }],
      }),
    );
    expect(meta).toEqual({ name: "meta", types: ["series"], idPrefixes: ["had:episode:"] });
  });
});

describe("resourceAccepts", () => {
  const meta = { name: "meta", types: ["series"], idPrefixes: ["had:episode:"] };

  it("accepts an ID in scope", () => {
    expect(resourceAccepts(meta, "series", "had:episode:tt33078239:1:4")).toBe(true);
  });

  it("rejects another type or prefix", () => {
    expect(resourceAccepts(meta, "movie", "had:episode:tt1")).toBe(false);
    expect(resourceAccepts(meta, "series", "tt34890576")).toBe(false);
  });

  it("accepts every ID when idPrefixes is missing or blank", () => {
    expect(
      resourceAccepts({ name: "stream", types: ["movie"], idPrefixes: [] }, "movie", "tt1"),
    ).toBe(true);
    expect(
      resourceAccepts({ name: "stream", types: ["movie"], idPrefixes: [""] }, "movie", "kitsu:1"),
    ).toBe(true);
  });

  it("matches a prefix declared without its trailing colon", () => {
    expect(
      resourceAccepts(
        { name: "stream", types: ["anime"], idPrefixes: ["kitsu"] },
        "anime",
        "kitsu:7442:1",
      ),
    ).toBe(true);
  });
});

describe("missingManifestFields", () => {
  it("accepts a minimal manifest without description or catalogs", () => {
    expect(
      missingManifestFields({ id: "x", version: "1.0.0", name: "X", resources: [], types: [] }),
    ).toEqual([]);
  });

  it("names every field a non-manifest JSON object lacks", () => {
    expect(missingManifestFields({ meta: {}, payload: {} })).toEqual([
      "id",
      "version",
      "name",
      "resources",
      "types",
    ]);
  });

  it("rejects a field of the wrong type", () => {
    expect(
      missingManifestFields({ id: "x", version: 1, name: "X", resources: "stream", types: [] }),
    ).toEqual(["version", "resources"]);
  });
});

describe("declaredConfigRequirement", () => {
  it("reads the behaviorHints flag", () => {
    expect(
      declaredConfigRequirement(manifest({ behaviorHints: { configurationRequired: true } })),
    ).toBe("manifest sets configurationRequired");
  });

  it("reads a root-level flag (ItsOut | ElfHosted)", () => {
    const m = manifest({ behaviorHints: { configurable: true } });
    expect(
      declaredConfigRequirement({
        ...m,
        configurable: true,
        configurationRequired: true,
      } as Manifest),
    ).toBe("manifest sets configurationRequired");
  });

  it("names SDK config entries that are required and have no default (Eh! Iptv)", () => {
    const m = {
      ...manifest({ behaviorHints: { configurable: true } }),
      config: [
        { key: "token", type: "text", title: "Access token", required: true },
        { key: "lang", type: "text", required: true, default: "en" },
        { key: "debug", type: "checkbox" },
      ],
    } as Manifest;
    expect(declaredConfigRequirement(m)).toBe("manifest requires setting token");
  });

  it("reads a config object keyed by setting (letterboxed)", () => {
    const m = {
      ...manifest({ behaviorHints: { configurable: true, configurationRequired: false } }),
      config: {
        email: { required: false, title: "Email", type: "string" },
        password: { required: false, title: "Password", type: "string" },
        username: { required: true, title: "Username", type: "string" },
      },
    } as unknown as Manifest;
    expect(declaredConfigRequirement(m)).toBe("manifest requires setting username");
  });

  it("is undefined for an addon that only offers configuration (Statusio)", () => {
    const m = {
      ...manifest({ behaviorHints: { configurable: true, configurationRequired: false } }),
      config: [
        { key: "visibility_mode", type: "select", default: "expiring" },
        { key: "rd_token", type: "password" },
      ],
    } as Manifest;
    expect(declaredConfigRequirement(m)).toBeUndefined();
  });
});

describe("invitesConfiguration", () => {
  it("holds for a configurable manifest, in behaviorHints or at the root", () => {
    expect(invitesConfiguration(manifest({ behaviorHints: { configurable: true } }))).toBe(true);
    expect(invitesConfiguration({ ...manifest({}), configurable: true } as Manifest)).toBe(true);
  });

  it("holds for a required setting and not for a plain manifest", () => {
    const m = { ...manifest({}), config: [{ key: "token", type: "text", required: true }] };
    expect(invitesConfiguration(m as Manifest)).toBe(true);
    expect(invitesConfiguration(manifest({}))).toBe(false);
  });
});
