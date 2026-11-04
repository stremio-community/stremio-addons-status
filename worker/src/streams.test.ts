import { describe, expect, it } from "vitest";
import {
  classifyStream,
  placeholderKind,
  placeholderMeta,
  repeatedFingerprints,
  strongestPlaceholder,
  type StreamClass,
} from "./streams.js";

const BASE = "https://addon.test";
const classify = (s: unknown) => classifyStream(s, { baseUrl: BASE });

describe("classifyStream", () => {
  it("counts direct sources as playable", () => {
    expect(classify({ url: "https://cdn.test/a.mp4", title: "1080p" }).kind).toBe("playable");
    expect(classify({ infoHash: "a".repeat(40), title: "Inception.2010.1080p" }).kind).toBe(
      "playable",
    );
    expect(classify({ ytId: "dQw4w9WgXcQ", title: "Episode 1" }).kind).toBe("playable");
    expect(classify({ nzbUrl: "https://nzb.test/x.nzb" }).kind).toBe("playable");
    expect(classify({ rarUrls: [{ url: "https://cdn.test/a.rar" }] }).kind).toBe("playable");
  });

  it("counts externalUrl as a link, not as playable", () => {
    expect(
      classify({ externalUrl: "https://www.imdb.com/title/tt0111161/", title: "⭐ IMDb 9.3" }).kind,
    ).toBe("link");
  });

  it("counts YouTube trailers as links", () => {
    expect(classify({ ytId: "abc", bingeGroup: "trailer", title: "Inception" }).kind).toBe("link");
    expect(classify({ ytId: "abc", name: "🎬 [OFFICIAL TRAILER]" }).kind).toBe("link");
  });

  it("rejects streams without a source", () => {
    expect(classify({ title: "nothing here" }).kind).toBe("invalid");
    expect(classify(null).kind).toBe("invalid");
    expect(classify({ url: "" }).kind).toBe("invalid");
  });

  it("rejects hosts no client can play", () => {
    for (const url of [
      "http://localhost:5871/proxy/debrid?link=x",
      "http://127.0.0.1/a.mp4",
      "http://10.0.0.5/a.mp4",
      "http://192.168.1.2/a.mp4",
      "http://172.20.0.1/a.mp4",
      "http://169.254.1.1/a.mp4",
      "http://0.0.0.0/a.mp4",
      "http://[::1]/a.mp4",
      "https://example.com/auth-error.mp4",
      "https://www.example.org/x",
    ]) {
      expect(classify({ url, title: "1080p" }).kind, url).toBe("invalid");
    }
    expect(classify({ url: "http://172.32.0.1/a.mp4" }).kind).toBe("playable");
  });

  it("rejects an all-zero infoHash", () => {
    expect(classify({ infoHash: "0".repeat(40), title: "No results returned" }).kind).toBe(
      "invalid",
    );
  });

  it("treats a link to the addon's own configure page as a needs-config placeholder", () => {
    const c = classify({ externalUrl: `${BASE}/configure`, title: "Open" });
    expect(c).toMatchObject({ kind: "placeholder", placeholder: "needs-config" });
  });

  it.each([
    // [stream, expected placeholder kind]
    [{ externalUrl: "https://x.test", title: "ℹ Kindly configure this addon" }, "needs-config"],
    [
      { url: "https://x.test/a.mp4", title: "OBSOLETE CONFIGURATION, PLEASE RE-CONFIGURE" },
      "needs-config",
    ],
    [{ url: "https://x.test/a.mp4", name: "PenguPlay", title: "You must sign in" }, "needs-config"],
    [{ externalUrl: "https://x.test", title: "⚠️ Cookie Required" }, "needs-config"],
    [{ externalUrl: "https://x.test", title: "Setup Required" }, "needs-config"],
    [{ url: "https://x.test/a.mp4", title: "Sign in to Seedr" }, "needs-config"],
    [
      { url: "https://x.test/a.mp4", title: "🔧 Configure the addon with a valid API Key" },
      "needs-config",
    ],
    [{ url: "https://x.test/a.mp4", title: "⚠️ Invalid API Key" }, "needs-config"],
    [{ externalUrl: "https://x.test", title: "Token Required" }, "needs-config"],
    [{ externalUrl: "https://x.test", title: "Use Mediaflow proxy" }, "needs-config"],
    [{ externalUrl: "https://x.test", title: "Teljes hozzáférés aktiválása" }, "needs-config"],
    [
      { externalUrl: "https://x.test", title: "🔒 Locked\nClick to Unlock Premium Access" },
      "needs-config",
    ],
    [{ externalUrl: "https://x.test", title: "🔓 Subscribe to watch" }, "needs-config"],
    [{ externalUrl: "https://x.test", title: "Free trial" }, "needs-config"],
    [{ externalUrl: "https://x.test", title: "🔓 Unlock — from 1 USDT" }, "needs-config"],
    [{ externalUrl: "https://x.test", title: "🔒 No Debrid key — tap to unlock" }, "needs-config"],
    [
      { externalUrl: "https://x.test", title: "➕ Add New App", description: "Configure Apps" },
      "needs-config",
    ],
    [{ externalUrl: "https://x.test", title: "Private manifest required" }, "needs-config"],
    [
      {
        externalUrl: "https://x.test",
        title: "Private manifest required · shared free manifest ended on 11 October 2026",
      },
      "error",
    ],
    [{ externalUrl: "https://x.test", title: "Wymagana konfiguracja" }, "needs-config"],
    [
      {
        url: "https://x.test/a.mp4",
        title: "[LỖI CẤU HÌNH] Bạn chưa nhập API Key hoặc Secret Code",
      },
      "needs-config",
    ],
    [{ url: "https://x.test/a.mp4", title: "🎬 ADDON DEPRECATED" }, "error"],
    [{ url: "https://x.test/a.mp4", title: "…we are shutting down this service" }, "error"],
    [{ url: "https://x.test/a.mp4", title: "Please reinstall the addon" }, "error"],
    [
      {
        externalUrl: "https://x.test",
        title: "Acceso no autorizado",
        description: "Email no autorizado",
      },
      "error",
    ],
    [{ url: "https://x.test/a.mp4", title: "Acces blocat" }, "error"],
    [
      { url: "https://x.test/a.mp4", title: "[⛔️] Non-debrid searches disabled on ElfHosted" },
      "needs-config",
    ],
    [
      {
        url: "https://comet.test",
        name: "[INFO] Comet",
        description: "Direct torrent playback is disabled on this server.",
      },
      "needs-config",
    ],
    [{ externalUrl: "https://x.test", title: "⚠️ Subscription Ended" }, "needs-config"],
    [{ externalUrl: "https://x.test", title: "Your API key has expired" }, "error"],
    [{ externalUrl: "https://x.test", title: "MovieBox ❌ Request failed" }, "error"],
    [{ url: "https://x.test/a.mp4", title: "MediaFusion rate-limit exceeded" }, "error"],
    [{ externalUrl: "https://x.test", title: "Persian Satellite [SUSPENDED]" }, "error"],
    [{ externalUrl: "https://x.test", title: "⭐ Кинопоиск: нет данных" }, "no-content"],
    [{ externalUrl: "https://x.test", title: "Rating not available" }, "no-content"],
    [{ externalUrl: "https://x.test", title: "😔 Nėra šaltinių" }, "no-content"],
    [{ externalUrl: "https://x.test", title: "No Streams Found" }, "no-content"],
    [
      { externalUrl: "https://x.test", title: "v2.3 available. Tap to update your install." },
      "no-content",
    ],
    [
      { externalUrl: "https://x.test", title: "⏳ SOSTIENI il progetto", description: "donazione" },
      "no-content",
    ],
    [{ externalUrl: "https://www.google.com/search?q=x", title: "🔍 Search Google" }, "no-content"],
    [{ externalUrl: "https://buymeacoffee.com/x", title: "Support" }, "no-content"],
    [{ externalUrl: "https://x.test", title: "[INFO] Something" }, "no-content"],
  ])("detects the placeholder %j as %s", (stream, kind) => {
    const c = classify(stream);
    expect(c.kind).toBe("placeholder");
    expect(c.kind === "placeholder" && c.placeholder).toBe(kind);
  });

  it.each([
    { externalUrl: "https://x.test", title: "⚠️ Not Parent Safe", description: "Ratings: 8.1" },
    { url: "https://x.test/a.mp4", title: "Opção 1" },
    { infoHash: "b".repeat(40), title: "Inception.2010.1080p.BluRay.x264\n👤 23 💾 2.1 GB" },
    { url: "https://x.test/a.m3u8", name: "Premiumize", title: "Inception 4K" },
    { externalUrl: "https://www.imdb.com/title/tt0111161/", title: "⭐ IMDb 9.3/10 (3.1M votes)" },
    { url: "https://x.test/a.mp4", name: "Torrentio\n4k", title: "Sign.of.the.Times.1987.1080p" },
  ])("keeps the real stream %j", (stream) => {
    expect(classify(stream).kind).not.toBe("placeholder");
  });

  it("labels a placeholder by its visible text", () => {
    const c = classify({
      name: "Jackettio",
      title: "ℹ Kindly configure this addon\n\nline 2",
      externalUrl: "https://x.test",
    });
    expect(c.kind === "placeholder" && c.label).toBe(
      "Jackettio · ℹ Kindly configure this addon line 2",
    );
  });
});

describe("placeholderKind", () => {
  it("is undefined for ordinary text", () => {
    expect(placeholderKind("The Shawshank Redemption")).toBeUndefined();
    expect(placeholderKind("")).toBeUndefined();
  });
});

describe("placeholderMeta", () => {
  it.each([
    [{ id: "pictorium:notice:missing-tmdb-key", type: "movie", name: "Chiave TMDB richiesta" }],
    [{ id: "streamed:nebula-shared-free-expired", type: "tv", name: "Nebula" }],
    [{ id: "gemini-error-1730000000", type: "movie", name: "Aviso Importante" }],
    [{ id: "seedr_status_auth", type: "other", name: "Sign in to Seedr" }],
    [{ id: "upl:invalid_apikey", type: "movie", name: "⚠️ Invalid API Key" }],
    [{ id: "suspended-notice-movie", type: "movie", name: "Suspended" }],
    [{ id: "configure_new_app", type: "other", name: "➕ Add New App" }],
    [{ id: "ir:promo-unlock", type: "movie", name: "Unlock" }],
    [{ id: "scary-news-donate-qr", type: "movie", name: "Donate" }],
    [{ id: "mindgeek_renew_alert", type: "movie", name: "Renew" }],
    [{ id: "twl:1", type: "movie", name: "Wymagana konfiguracja" }],
    [{ id: "sv:1", type: "movie", name: "⚠️ Set up StreamVault first" }],
    [{ id: "top:1", type: "movie", name: "Set up TOP Streaming to unlock this row" }],
    [{ id: "flix:1", type: "movie", name: "⚠️ Please reinstall FlixAI" }],
    [{ id: "tmdb:1273221.json", type: "movie", name: "Loading..." }],
    [{ id: "tc:1", type: "movie", name: "🔒 Connect your account" }],
  ])("flags %j", (meta) => {
    expect(placeholderMeta(meta)).toBeDefined();
  });

  it.each([
    [{ id: "pictorium:notice:missing-tmdb-key", name: "Chiave TMDB richiesta" }, "needs-config"],
    [{ id: "upl:invalid_apikey", name: "⚠️ Invalid API Key" }, "needs-config"],
    [{ id: "streamed:nebula-shared-free-expired", name: "Private manifest required" }, "error"],
    [{ id: "suspended-notice-movie", name: "⚠️ SERVICE SUSPENDED" }, "error"],
    [{ id: "scary-news-donate-qr", name: "❤️ Support Scary Only — Scan to Donate" }, "no-content"],
    [{ id: "ir:promo-unlock", name: "🎁 Offers" }, "needs-config"],
    [{ id: "tv:placeholder-z-eventi", name: "Nessuno Stream disponibile oggi" }, "no-content"],
  ])("reads %j as %s, the stronger of its text and its ID", (meta, kind) => {
    expect(placeholderMeta({ type: "movie", ...meta })?.placeholder).toBe(kind);
  });

  it("labels a notice by its name", () => {
    expect(
      placeholderMeta({
        id: "pictorium:notice:missing-tmdb-key",
        type: "movie",
        name: "Chiave TMDB\nrichiesta",
      })?.label,
    ).toBe("Chiave TMDB richiesta");
  });

  it.each([
    [{ id: "tt0111161", type: "movie", name: "The Shawshank Redemption" }],
    [{ id: "kitsu:7442", type: "anime", name: "Attack on Titan" }],
    [{ id: "tubi:515934", type: "movie", name: "Tom and Jerry" }],
    [{ id: "had:episode:tt33078239:1:4", type: "series", name: "Halloween After Dark" }],
  ])("keeps %j", (meta) => {
    expect(placeholderMeta(meta)).toBeUndefined();
  });
});

describe("repeatedFingerprints", () => {
  const nag = { externalUrl: "https://zrk.app/update", title: "v2 available" };
  const a = { url: "https://cdn.test/a.mp4", title: "Opção 1" };
  const b = { url: "https://cdn.test/b.mp4", title: "Opção 1" };
  const of = (streams: unknown[]): StreamClass[] => streams.map(classify);

  it("finds a stream repeated for unrelated titles", () => {
    const repeated = repeatedFingerprints([of([a, nag]), of([b, nag])]);
    expect(repeated.size).toBe(1);
    expect(repeated.has(of([nag])[0].fingerprint)).toBe(true);
  });

  it("keeps same-titled streams whose URLs differ", () => {
    expect(repeatedFingerprints([of([a]), of([b])]).size).toBe(0);
  });

  it("needs two responses to compare", () => {
    expect(repeatedFingerprints([of([a, a])]).size).toBe(0);
  });
});

describe("strongestPlaceholder", () => {
  it("prefers an error over a plea to configure over noise, keeping the first of equals", () => {
    const of = (placeholder: "error" | "needs-config" | "no-content", label: string) => ({
      placeholder,
      label,
    });
    expect(
      strongestPlaceholder([
        of("no-content", "a"),
        of("needs-config", "b"),
        of("needs-config", "c"),
      ]),
    ).toEqual(of("needs-config", "b"));
    expect(strongestPlaceholder([of("needs-config", "b"), of("error", "d")])).toEqual(
      of("error", "d"),
    );
    expect(strongestPlaceholder([])).toBeUndefined();
  });
});
