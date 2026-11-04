import type { NormalizedAddon } from "./types.js";

/**
 * Curated per-addon probe settings, keyed by the addon's uuid.
 * Everything here is public: never put a secret, a user's config or a configured base URL in it.
 */
export interface AddonOverride {
  /** For humans reading this file; the probe ignores it. */
  name: string;
  /**
   * A secret-free config path segment anyone can generate on the addon's configure page, inserted before `/manifest.json` when probing.
   * It lets the probe content-check a `configurationRequired` addon; it is never pushed to Gatus.
   */
  testConfig?: string;
  /**
   * Pin the addon as needs-configuration (liveness-only) when its unconfigured answers can't be told from broken ones, such as a silent `{"streams":[]}`.
   * The pin wins over any content verdict; its value is the reason shown on the status page.
   */
  needsConfig?: string;
  /**
   * Fixed test IDs for an addon whose scope no ID source covers; the first of each type its stream resource advertises is probed before any other source.
   * A subtitles-only addon is asked for them as they are, so a series ID names its episode, and answering no subtitles for every one of them is DOWN: name only titles its niche must carry.
   */
  testIds?: Array<{ type: string; id: string }>;
  /** The addon answers the same streams for every title by design (a status board), so a stream repeated across titles isn't a placeholder; the value says why. */
  sameStreamsForEveryTitle?: string;
}

export const OVERRIDES: Readonly<Record<string, AddonOverride>> = {
  "51779ee8-ad7c-4dd1-ba5f-1c38d7b3aae0": {
    name: "Kast Alldebrid",
    needsConfig: "streams need the user's own AllDebrid key",
  },
  "575ac53b-8df3-45f0-af83-941a349e4202": {
    name: "Aradeb",
    needsConfig: "streams need an addon access key and a debrid key",
  },
  "90148804-2804-45fa-83b4-c47055bc8caf": {
    name: "Overseerr Requests",
    needsConfig: "needs the user's TMDB key and Overseerr instance",
  },
  "f01aac54-bd8a-4bbd-a475-3b3c059fa3e5": {
    name: "Statusio",
    needsConfig: "shows debrid account status only for configured tokens",
  },
  "93116a0f-f255-4f25-b4c5-19ae0990d35b": {
    name: "Freedom Media | Live TV",
    needsConfig: "streams need a subscription key",
  },
  "89aebd22-4b94-469b-bb87-3672de725bec": {
    name: "Flix-Streams",
    needsConfig: "streams need an account or supporter token",
  },
  "7183ea01-50fd-45a7-93eb-27f7217e0117": {
    name: "Binge Brakes",
    needsConfig: "answers only for the series its user restricts",
  },
  "0b353caa-05b1-40f2-aa72-a6d86b116ddf": {
    name: "Custom Watch Order",
    needsConfig: "the catalog lists only a user's own watch orders",
  },
  "17f12bc3-545c-42e1-95a3-be183febecb7": {
    name: "DCBI Addon",
    needsConfig: "streams need a config from the configure page",
  },
  "4772b642-1209-4b94-925b-88f01a3aa6d2": {
    name: "AIOCatalogs",
    needsConfig: "has no catalogs until the user adds some",
  },
  "5a74174e-9b3b-4580-b201-404d7c9efd72": {
    name: "stremio-serializd",
    needsConfig: "catalogs need a Serializd username",
  },
  "68b1752b-973d-4be9-9685-fa8b8db253c8": {
    name: "MediaLib",
    needsConfig: "catalogs need the user's MediaLib ID",
  },
  "b29db3ec-6b91-492d-84bd-c1da1c14a6e3": {
    name: "MediaFusion | ElfHosted",
    needsConfig: "this instance streams only through a configured debrid or Usenet provider",
  },
  "aa29281b-b458-4d05-ab56-6bd416c8fb87": {
    name: "Shared Debrid Notifier",
    needsConfig: "the listed URL is the route template for a user's own token, gist and session",
  },
  "64368278-71cf-498f-ab7d-62455bd6090d": {
    name: "Stremio Status",
    sameStreamsForEveryTitle: "it shows the same addon status cards on every title",
  },
  "47c623dd-5a03-425e-aff9-41505675a7b9": {
    name: "M_Rulz Scraper (Telugu)",
    needsConfig: "routes exist only under a personal token",
  },
  "74cfec2c-fc0c-4d24-89cd-b60985a9d99c": {
    name: "40th PROJECT",
    testIds: [
      { type: "series", id: "tt0088509" },
      { type: "series", id: "tt0121220" },
    ],
  },
  "8e0cc578-49c1-4f20-9770-439143a716b8": {
    name: "SelectaVision",
    testIds: [
      { type: "series", id: "tt0121220" },
      { type: "series", id: "tt0088509" },
    ],
  },
  "040fae05-26db-4171-8156-e20e0eeb217c": {
    name: "Strelingo - Dual Language Subtitles",
    testConfig: encodeURIComponent(JSON.stringify({ mainLang: "eng", transLang: "spa" })),
  },
  "318f5c9c-4836-40ae-9918-54dc9e341893": {
    name: "Anime Catalogs",
    testConfig: encodeURIComponent(
      JSON.stringify({
        search: "on",
        "myanimelist_top-airing": "on",
        "anilist_trending-now": "on",
      }),
    ),
  },
  "30360210-4bec-4dc0-b9db-819fa04e4186": {
    name: "opensubtitles PRO",
    testConfig: Buffer.from(
      JSON.stringify({
        langs: ["english"],
        source: "all",
        aiTranslated: true,
        autoAdjustment: false,
      }),
    ).toString("base64"),
  },
  "730c1070-9dcf-4887-8393-922ddf078191": {
    name: "yifysubtitles subtitles by dexter21767",
    testConfig: "english",
    testIds: [
      { type: "movie", id: "tt1375666" },
      { type: "movie", id: "tt0468569" },
    ],
  },
  "72f03433-11a9-4d1f-aad9-9993f467c191": {
    name: "TR Altyazı",
    testIds: [
      { type: "movie", id: "tt0468569" },
      { type: "series", id: "tt0903747:1:1" },
    ],
  },
  "34d690d9-0cac-40dd-b840-30bdee7a2242": {
    name: "Ktuvit.me Subtitles",
    testIds: [
      { type: "movie", id: "tt1375666" },
      { type: "series", id: "tt0903747:1:1" },
    ],
  },
  "666b6525-9280-4d27-ac87-55b7e30dce64": {
    name: "One Pace PT-BR Subs",
    testIds: [{ type: "series", id: "RO_1" }],
  },
};

export function overrideFor(uuid: string): AddonOverride | undefined {
  return OVERRIDES[uuid];
}

/** The base URL the probe requests, which carries the addon's test config when it has one. */
export function probeBaseUrl(addon: Pick<NormalizedAddon, "uuid" | "baseUrl">): string {
  const testConfig = overrideFor(addon.uuid)?.testConfig;
  return testConfig ? `${addon.baseUrl}/${testConfig}` : addon.baseUrl;
}
