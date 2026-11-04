import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Attempt, GetJsonOptions, JsonResult, Sample } from "./http.js";
import type { TestContent } from "./idsources.js";
import type { NormResource } from "./manifest.js";

type Answer = Omit<JsonResult<unknown>, "attempts"> | Error;
type FileAnswer = Omit<Sample, "attempts"> | Error;

const h = vi.hoisted(() => ({
  listings: new Map<string, Answer>(),
  files: new Map<string, FileAnswer>(),
  requested: [] as string[],
  sampled: [] as string[],
  options: new Map<string, GetJsonOptions<unknown>>(),
  candidates: [] as TestContent[],
}));

function attempt(status?: number): Attempt[] {
  return [{ route: "direct", durationMs: 5, ...(status !== undefined ? { status } : {}) }];
}

vi.mock("./http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./http.js")>();
  return {
    ...actual,
    getJson: async (url: string, _timeout: number, options: GetJsonOptions<unknown> = {}) => {
      h.requested.push(url);
      h.options.set(url, options);
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      const a = h.listings.get(path) ?? h.listings.get(url);
      if (!a) {
        throw new actual.RequestFailedError("fetch failed", [
          { route: "direct", error: "fetch failed", durationMs: 1 },
        ]);
      }
      if (a instanceof Error) throw a;
      return { ...a, attempts: attempt(a.status) };
    },
    getSample: async (url: string) => {
      h.sampled.push(url);
      const a = h.files.get(url);
      if (!a || a instanceof Error) {
        throw new actual.RequestFailedError("fetch failed (ENOTFOUND)", [
          { route: "direct", error: "fetch failed (ENOTFOUND)", durationMs: 1 },
        ]);
      }
      return { ...a, attempts: attempt(a.status) };
    },
  };
});

vi.mock("./idsources.js", () => ({
  candidatesFor: async (_res: NormResource) => h.candidates,
}));

const {
  checkSubtitles,
  judgeEntries,
  judgeFile,
  releaseFileName,
  subtitleTargets,
  translatesSubtitles,
} = await import("./subtitles.js");
const { logger } = await import("./logger.js");

const BASE = "https://addon.test";
const log = logger.child({});
const options = { maxTitles: 3, sniff: true, retry: true, onDemand: false, log };

const json = (data: unknown, status = 200): Answer => ({ status, data });
const subs = (subtitles: unknown[]): Answer => json({ subtitles });
const HTML_404: Answer = {
  status: 404,
  data: undefined,
  parseError: {
    html: true,
    contentType: "text/html",
    title: "404 Not Found",
    excerpt: "<!doctype html>",
  },
};
const enc = (s: string) => new TextEncoder().encode(s);
const file = (body: string | Uint8Array, contentType = "application/x-subrip"): FileAnswer => ({
  status: 200,
  bytes: typeof body === "string" ? enc(body) : body,
  contentType,
});

/** An SRT with a distinct line per cue, as real dialogue has. */
function srt(lines: string[]): string {
  return lines
    .map(
      (l, i) =>
        `${i + 1}\n00:00:${String(i).padStart(2, "0")},000 --> 00:00:${String(i).padStart(2, "0")},900\n${l}\n`,
    )
    .join("\n");
}

const ENGLISH = srt([
  "I'm going to need you to stay calm.",
  "Access denied, it says.",
  "Then log in again, Cobb.",
  "We don't have much time.",
  "What is the most resilient parasite?",
  "An idea. Resilient, highly contagious.",
  "Once an idea has taken hold of the brain,",
  "it's almost impossible to eradicate.",
]);

/** The start of idk subs' "AI Hebrew Translation (ready)" file for Inception: the Japanese source, untranslated. */
const IDK_SUBS_INCEPTION = srt([
  "おい、ちょっと来い",
  "怪しい奴がいるぞ",
  "まだもうろうとしていますが / あなた様の名前を…",
  "お見せしろ",
  "所持品はこれと…",
  "これです",
  "私を殺しに来たのか？",
  "これを知ってるぞ",
  "大分前に見たことがある、ずっと昔だ",
  "おぼろげにしか覚えてないが / 夢の中で男が持っていた",
  "途方もない考えを持った男だった",
  "私たちが探しているのは情報です",
  "あなたの頭の中にある秘密です",
  "夢の中では何でも盗めるのです",
]);

const HEBREW = srt([
  "אני צריך שתישאר רגוע.",
  "אין לנו הרבה זמן.",
  "מה הטפיל העמיד ביותר?",
  "רעיון. עמיד, מדבק מאוד.",
  "ברגע שרעיון השתלט על המוח,",
  "כמעט בלתי אפשרי למחוק אותו.",
  "רעיון שמוגדר במלואו ומובן,",
  "נשאר שם, איפשהו בתוך הראש.",
  "אתה מחכה לרכבת,",
  "רכבת שתיקח אותך רחוק.",
]);

/** Demo Titlovi.com's `/files/api-disabled.vtt`, served for every language of every title. */
const TITLOVI_DISABLED = `WEBVTT

00:00:00.240 --> 00:00:20.240
Postani zmaj supporter

00:00:29.240 --> 00:00:34.560
Posjeti https://stremio.titlovi.com

00:00:35.240 --> 00:00:40.560
Postani zmaj supporter

00:00:49.240 --> 00:00:53.560
Pristup addonu onemogućen

00:00:55.240 --> 00:01:00.560
Posjeti https://stremio.titlovi.com
`;

/** Sublatino's file for every title until an API key is configured. */
const SUBLATINO_NO_KEY = `1
00:00:00,000 --> 23:59:59,000
Sublatino - Error
Configura tu API key en el addon: Settings -> Add-ons -> Sublatino -> Configure.

`;

beforeEach(() => {
  h.listings.clear();
  h.files.clear();
  h.requested.length = 0;
  h.sampled.length = 0;
  h.options.clear();
  h.candidates = [];
});

describe("judgeEntries", () => {
  it("keeps real subtitles, including a language code followed by a note (SubSync)", () => {
    const e = judgeEntries([
      { id: "3728010", lang: "eng", url: "https://subs5.strem.io/en/download/file/1952382875" },
      { id: "subsync-1", lang: "eng #1 original", url: "https://subsync.test/s/1.srt" },
      { id: "x", lang: "pt-BR", url: "https://x.test/2.srt" },
    ]);
    expect(e.real).toHaveLength(3);
    expect(e.notices).toEqual([]);
  });

  it("reads Demo Titlovi.com's seven languages pointing at api-disabled.vtt as an error notice", () => {
    const url = "https://stremio.titlovi.com/files/api-disabled.vtt";
    const e = judgeEntries(
      ["bos", "srp", "eng", "hrv", "mac", "slv", "srp"].map((lang, i) => ({
        id: String(i),
        lang,
        url,
      })),
    );
    expect(e.real).toEqual([]);
    expect(e.notices[0]).toEqual({ placeholder: "error", label: "api-disabled.vtt" });
  });

  it("reads several languages sharing one file as a placeholder, whatever they say", () => {
    const url = "https://x.test/files/a.vtt";
    const e = judgeEntries(["bos", "srp", "eng"].map((lang, i) => ({ id: String(i), lang, url })));
    expect(e.real).toEqual([]);
    expect(e.notices[0]).toEqual({
      placeholder: "no-content",
      label: "same file for every subtitle (a.vtt)",
    });
  });

  it.each([
    [
      "SubMaker",
      {
        id: "config_error_session_token",
        lang: "!SubMaker Error",
        url: "https://submaker.test/error/session-token-not-found.srt",
      },
      "needs-config",
      "!SubMaker Error",
    ],
    [
      "MultiSub",
      {
        id: "multisub-invalid-key",
        lang: "eng",
        label: "⚠️ Invalid API key",
        url: "https://multisub.test/x.srt",
      },
      "needs-config",
      "⚠️ Invalid API key",
    ],
    [
      "Wyzie",
      {
        id: "wyzie-notice-nokey",
        lang: "eng",
        label: "no API key set",
        url: "https://w.test/n.srt",
      },
      "needs-config",
      "no API key set",
    ],
    [
      "Auto Subtitle Translate (DeepL)",
      { id: "Apikey error", lang: "tur", url: "https://deepl.test/apikeyerror.srt" },
      "needs-config",
      "apikeyerror.srt",
    ],
    [
      "AnySubs",
      {
        id: "tokenless-install",
        lang: "eng",
        label: "Reinstall from anysubs.store/fix",
        url: "https://anysubs.test/fix.srt",
      },
      "error",
      "Reinstall from anysubs.store/fix",
    ],
  ])("reads %s's entry as a %s notice", (_name, entry, placeholder, label) => {
    const e = judgeEntries([entry]);
    expect(e.real).toEqual([]);
    expect(e.notices).toEqual([{ placeholder, label }]);
  });

  it("keeps a language Strelingo names rather than codes", () => {
    const e = judgeEntries([
      { id: "merged-3728010-3722571-direct", lang: "English+Spanish", url: "https://s.test/m.srt" },
    ]);
    expect(e.real).toHaveLength(1);
  });

  it("counts a file on a host no client can reach as unusable (yifysubtitles)", () => {
    const e = judgeEntries([{ id: "1", lang: "eng", url: "http://127.0.0.1:3000/sub/1.srt" }]);
    expect(e).toEqual({ real: [], notices: [], unusable: 1 });
  });

  it("counts entries Stremio can't use: no url, or a language that isn't a code (GTSubs' info:<lang>)", () => {
    const e = judgeEntries([
      { id: "info:en", lang: "info:en", url: "https://gtsubs.test/info.srt" },
      { id: "1", lang: "eng" },
      "nonsense",
    ]);
    expect(e).toEqual({ real: [], notices: [], unusable: 3 });
  });
});

describe("judgeFile", () => {
  const ok = (body: string | Uint8Array, lang = "eng", contentType?: string) =>
    judgeFile(
      { status: 200, bytes: typeof body === "string" ? enc(body) : body, contentType },
      lang,
    );

  it.each([
    ["SRT", ENGLISH],
    ["VTT", "WEBVTT\n\n1\n00:00:00.000 --> 00:00:10.000 line:5% position:95% align:end\n18:39\n"],
    [
      "ASS",
      "[Script Info]\nTitle: x\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\i1}Hello{\\i0}\\Nthere\n",
    ],
    ["MicroDVD", "{1}{25}Hello|there\n{30}{50}Again\n"],
  ])("accepts a %s file", (format, body) => {
    expect(ok(body)).toEqual({ kind: "ok", format });
  });

  it("reads Demo Titlovi.com's api-disabled.vtt as an error notice", () => {
    expect(ok(TITLOVI_DISABLED, "bos")).toEqual({
      kind: "notice",
      notice: { placeholder: "error", label: "Pristup addonu onemogućen" },
    });
  });

  it("reads Sublatino's API key file as a plea to configure", () => {
    expect(ok(SUBLATINO_NO_KEY, "spa")).toMatchObject({
      kind: "notice",
      notice: { placeholder: "needs-config" },
    });
  });

  it("doesn't read the wording of real dialogue, which says 'access denied' or 'log in' too", () => {
    expect(ok(ENGLISH)).toEqual({ kind: "ok", format: "SRT" });
  });

  it("rejects idk subs' Hebrew-labelled file holding the Japanese source", () => {
    expect(ok(IDK_SUBS_INCEPTION, "heb")).toEqual({
      kind: "bad",
      summary: "file not Hebrew",
      reason: "the file listed as heb holds no Hebrew text",
    });
  });

  it("accepts a file in its language's script", () => {
    expect(ok(HEBREW, "heb")).toEqual({ kind: "ok", format: "SRT" });
    expect(ok(IDK_SUBS_INCEPTION, "jpn")).toEqual({ kind: "ok", format: "SRT" });
  });

  it("doesn't judge the script of a file in a legacy encoding", () => {
    // Hebrew letters in windows-1255 are single bytes 0xE0-0xFA, which aren't valid UTF-8.
    const windows1255 = new Uint8Array(
      [...HEBREW].flatMap((c) =>
        /\p{Script=Hebrew}/u.test(c) ? [0xe0 + (c.codePointAt(0)! - 0x5d0)] : [...enc(c)],
      ),
    );
    expect(ok(windows1255, "heb")).toEqual({ kind: "ok", format: "SRT" });
  });

  it("reads a UTF-16 file with a byte order mark", () => {
    const body = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(HEBREW, "utf16le")]);
    expect(ok(body, "heb")).toEqual({ kind: "ok", format: "SRT" });
  });

  it("reads a gzipped file", () => {
    expect(ok(gzipSync(Buffer.from(ENGLISH)))).toEqual({ kind: "ok", format: "SRT" });
  });

  it("rejects an empty file and text that isn't a subtitle", () => {
    expect(ok("")).toMatchObject({ kind: "bad", summary: "empty file" });
    expect(ok('{"error":"Not found"}')).toMatchObject({
      kind: "bad",
      summary: "not a subtitle file",
    });
  });

  it("leaves undecided what may not be the file at all", () => {
    expect(ok("<!DOCTYPE html><title>Just a moment...</title>", "eng", "text/html")).toEqual({
      kind: "unchecked",
      reason: "file is an HTML page",
    });
    expect(judgeFile({ status: 404, bytes: enc("Not found") }, "eng")).toEqual({
      kind: "unchecked",
      reason: "file answered HTTP 404",
    });
    expect(ok(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toEqual({
      kind: "unchecked",
      reason: "file is a zip archive",
    });
  });
});

describe("releaseFileName", () => {
  it.each([
    ["Inception.2010", "tt1375666", "Inception.2010.1080p.WEB-DL.mkv"],
    ["Breaking.Bad", "tt0903747:1:1", "Breaking.Bad.S01E01.1080p.WEB-DL.mkv"],
    ["Death.Note", "kitsu:1376:1", "Death.Note.S01E01.1080p.WEB-DL.mkv"],
    ["Spirited.Away", "kitsu:176", "Spirited.Away.1080p.WEB-DL.mkv"],
    ["RO.1", "RO_1", "RO.1.1080p.WEB-DL.mkv"],
  ])("names %s (%s) %s", (name, id, expected) => {
    expect(releaseFileName(name, id)).toBe(expected);
  });
});

const INCEPTION = { type: "movie", id: "tt1375666", source: "well-known" };
const DARK_KNIGHT = { type: "movie", id: "tt0468569", source: "well-known" };
const BREAKING_BAD = { type: "series", id: "tt0903747:1:1", source: "well-known" };
const INCEPTION_EXTRA = "/subtitles/movie/tt1375666/filename=Inception.2010.1080p.WEB-DL.mkv.json";
const INCEPTION_BARE = "/subtitles/movie/tt1375666.json";

function cinemeta() {
  h.listings.set(
    "https://v3-cinemeta.strem.io/meta/movie/tt1375666.json",
    json({ meta: { name: "Inception", year: "2010" } }),
  );
  h.listings.set(
    "https://v3-cinemeta.strem.io/meta/movie/tt0468569.json",
    json({ meta: { name: "The Dark Knight", releaseInfo: "2008" } }),
  );
  h.listings.set(
    "https://v3-cinemeta.strem.io/meta/series/tt0903747.json",
    json({ meta: { name: "Breaking Bad", releaseInfo: "2008–2013" } }),
  );
}

const polish = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `40448_${i}`,
    lang: "pol",
    url: `https://napisy24.test/download/${i}.srt`,
  }));

describe("checkSubtitles", () => {
  beforeEach(cinemeta);

  it("sends a file name as Stremio does, which Napisy24 needs to route the request", async () => {
    h.listings.set(INCEPTION_EXTRA, subs(polish(10)));
    h.listings.set(INCEPTION_BARE, HTML_404);
    h.files.set("https://napisy24.test/download/0.srt", file(ENGLISH));
    const c = await checkSubtitles(BASE, [INCEPTION], options);
    expect(c?.verdict).toEqual({ kind: "content" });
    expect(c?.result).toMatchObject({ ok: true, summary: "movie 10 found" });
    expect(h.requested.filter((u) => u.startsWith(BASE))).toEqual([BASE + INCEPTION_EXTRA]);
    expect(c?.result.details).toContainEqual({
      label: "File",
      value: "napisy24.test · direct · HTTP 200 · SRT",
    });
    expect(c?.deciding?.path).toBe(INCEPTION_EXTRA);
    expect(h.options.get(BASE + INCEPTION_EXTRA)).toMatchObject({
      retry: true,
      maxBytes: 2_000_000,
    });
  });

  it("asks for the bare form when the file name gets nothing (Subtitle Search Engine)", async () => {
    h.listings.set(INCEPTION_EXTRA, subs([]));
    h.listings.set(INCEPTION_BARE, subs(polish(50)));
    h.files.set("https://napisy24.test/download/0.srt", file(ENGLISH));
    const c = await checkSubtitles(BASE, [INCEPTION], options);
    expect(c?.verdict).toEqual({ kind: "content" });
    expect(c?.result.summary).toBe("movie 50 found");
    expect(c?.result.details).toContainEqual({
      label: "Also tried",
      value: `${INCEPTION_EXTRA} · 0 found`,
    });
  });

  it("passes on its listing when its file can't be fetched, noting why", async () => {
    h.listings.set(INCEPTION_EXTRA, subs(polish(2)));
    const c = await checkSubtitles(BASE, [INCEPTION], options);
    expect(c?.verdict).toEqual({ kind: "content" });
    expect(c?.result.details).toContainEqual({
      label: "Note",
      value: "file unreachable: fetch failed (ENOTFOUND)",
    });
  });

  it("fails a title whose file the addon itself can't serve (Ktuvit.me's 504s)", async () => {
    const entry = { id: "[KTUVIT]Inception", lang: "heb", url: `${BASE}/srt/DAA938490D2F8` };
    h.listings.set(INCEPTION_EXTRA, subs([entry]));
    h.files.set(entry.url, { status: 504, bytes: enc("Gateway Timeout") });
    const c = await checkSubtitles(BASE, [INCEPTION], options);
    expect(c?.verdict).toEqual({ kind: "down" });
    expect(c?.result.summary).toBe("movie file HTTP 504");
    expect(c?.result.details).toContainEqual({
      label: "Reason",
      value: "the addon's own subtitle file answered HTTP 504",
    });
  });

  it("fails a title whose own file can't be reached at all", async () => {
    h.listings.set(INCEPTION_EXTRA, subs([{ id: "1", lang: "heb", url: `${BASE}/file/1.srt` }]));
    const c = await checkSubtitles(BASE, [INCEPTION], options);
    expect(c?.verdict).toEqual({ kind: "down" });
    expect(c?.result.summary).toBe("movie file unreachable");
  });

  it.each([
    [
      "bgSubs' machine-translated files",
      {
        id: "os-3728010",
        lang: "bg",
        name: "3728010 (Translated OS)",
        url: "https://bgsubs.test/download/abc?translate=1",
      },
    ],
    [
      "idk subs' AI entry not yet translated",
      {
        id: "heb-ai-0",
        lang: "heb",
        label: "AI Hebrew Translation",
        url: "https://idk.test/ai/subtitle/x.srt",
      },
    ],
    ["a DeepL track", { id: "deepl-tr", lang: "tur", url: "https://s.test/deepl/1.srt" }],
    [
      "a Gemini track",
      { id: "1", lang: "vie", label: "Gemini Flash", url: "https://s.test/1.srt" },
    ],
  ])("lists %s without fetching them, which could start a paid translation", async (_n, entry) => {
    h.listings.set(INCEPTION_EXTRA, subs([entry]));
    const c = await checkSubtitles(BASE, [INCEPTION], options);
    expect(h.sampled).toEqual([]);
    expect(c?.verdict).toEqual({ kind: "content" });
    expect(c?.result.details).toContainEqual({
      label: "Note",
      value: "file not checked: generated on request",
    });
  });

  it("fetches a generated file that says it is ready, and the first plain file before a generated one", async () => {
    const ready = {
      id: "heb-ai-0",
      lang: "heb",
      label: "AI Hebrew Translation (ready)",
      url: "https://idk.test/ai/subtitle/ready.srt",
    };
    h.listings.set(INCEPTION_EXTRA, subs([ready]));
    h.files.set(ready.url, file(HEBREW));
    await checkSubtitles(BASE, [INCEPTION], options);
    expect(h.sampled).toEqual([ready.url]);

    h.sampled.length = 0;
    const plain = { id: "os-1", lang: "eng", url: "https://subs.test/1.srt" };
    h.listings.set(
      INCEPTION_EXTRA,
      subs([
        { ...ready, label: "AI Hebrew Translation", url: "https://idk.test/ai/subtitle/x.srt" },
        plain,
      ]),
    );
    h.files.set(plain.url, file(ENGLISH));
    await checkSubtitles(BASE, [INCEPTION], options);
    expect(h.sampled).toEqual([plain.url]);
  });

  it("fetches only ready files from an addon that translates on request", async () => {
    const plain = { id: "os-1", lang: "eng", url: "https://subs.test/1.srt" };
    h.listings.set(INCEPTION_EXTRA, subs([plain]));
    const c = await checkSubtitles(BASE, [INCEPTION], { ...options, onDemand: true });
    expect(h.sampled).toEqual([]);
    expect(c?.verdict).toEqual({ kind: "content" });
  });

  it("never fetches a debrid or resolve URL", async () => {
    const entry = { id: "1", lang: "eng", url: "https://real-debrid.com/d/abc.srt" };
    h.listings.set(INCEPTION_EXTRA, subs([entry]));
    await checkSubtitles(BASE, [INCEPTION], options);
    expect(h.sampled).toEqual([]);
  });

  it("reads an inline data: file without fetching it", async () => {
    const url = `data:application/x-subrip;charset=UTF-8,${encodeURIComponent(ENGLISH)}`;
    h.listings.set(INCEPTION_EXTRA, subs([{ id: "1", lang: "eng", url }]));
    const c = await checkSubtitles(BASE, [INCEPTION], options);
    expect(c?.verdict).toEqual({ kind: "content" });
    expect(h.sampled).toEqual([]);
    expect(c?.result.details).toContainEqual({ label: "File", value: "inline data: URL · SRT" });
  });

  it("stays up, annotated, when a provider answers nothing for every title (TR Altyazı, unpinned)", async () => {
    h.listings.set(INCEPTION_EXTRA, subs([]));
    h.listings.set(INCEPTION_BARE, subs([]));
    h.listings.set(
      "/subtitles/movie/tt0468569/filename=The.Dark.Knight.2008.1080p.WEB-DL.mkv.json",
      subs([]),
    );
    h.listings.set("/subtitles/movie/tt0468569.json", subs([]));
    h.listings.set(
      "/subtitles/series/tt0903747:1:1/filename=Breaking.Bad.S01E01.1080p.WEB-DL.mkv.json",
      subs([]),
    );
    h.listings.set("/subtitles/series/tt0903747:1:1.json", subs([]));
    const c = await checkSubtitles(BASE, [INCEPTION, BREAKING_BAD, DARK_KNIGHT], options);
    expect(c?.verdict).toEqual({ kind: "empty" });
    expect(c?.result).toMatchObject({ ok: true, summary: "movie 0 found (3 titles)" });
  });

  it("goes down when it answers nothing for the titles its override says it carries", async () => {
    h.listings.set(INCEPTION_EXTRA, subs([]));
    h.listings.set(INCEPTION_BARE, subs([]));
    const c = await checkSubtitles(BASE, [{ ...INCEPTION, curated: true }], options);
    expect(c?.verdict).toEqual({ kind: "down" });
    expect(c?.result.ok).toBe(false);
    expect(c?.result.details).toContainEqual({
      label: "Note",
      value: "no subtitles for the titles its override says it carries",
    });
  });

  it("goes down on Demo Titlovi.com's disabled-access files, asking no further title", async () => {
    const url = "https://stremio.titlovi.com/files/api-disabled.vtt";
    h.listings.set(
      INCEPTION_EXTRA,
      subs(["bos", "srp", "eng"].map((lang, i) => ({ id: String(i), lang, url }))),
    );
    const c = await checkSubtitles(BASE, [INCEPTION, DARK_KNIGHT], options);
    expect(c?.verdict).toEqual({ kind: "down" });
    expect(c?.result.summary).toBe("movie notices only");
    expect(c?.result.details).toContainEqual({
      label: "Reason",
      value: "addon says: api-disabled.vtt",
    });
    expect(h.requested.filter((u) => u.includes("tt0468569") && u.startsWith(BASE))).toEqual([]);
  });

  it("reads a notice inside the file as the addon's answer (Sublatino)", async () => {
    h.listings.set(
      INCEPTION_EXTRA,
      subs([{ id: "sublatino-tt1375666", lang: "spa", url: "https://sub.test/0.srt" }]),
    );
    h.files.set("https://sub.test/0.srt", file(SUBLATINO_NO_KEY));
    const c = await checkSubtitles(BASE, [INCEPTION, DARK_KNIGHT], options);
    expect(c?.verdict).toMatchObject({ kind: "needs-config" });
    expect(c?.result.summary).toBe("movie notice file");
  });

  it("goes down when every title's file is in the wrong language (idk subs)", async () => {
    const entry = {
      id: "heb-ai-0",
      lang: "heb",
      label: "AI Hebrew Translation (ready)",
      url: "https://idk.test/s.srt",
    };
    h.listings.set(INCEPTION_EXTRA, subs([entry]));
    h.listings.set(
      "/subtitles/movie/tt0468569/filename=The.Dark.Knight.2008.1080p.WEB-DL.mkv.json",
      subs([entry]),
    );
    h.files.set("https://idk.test/s.srt", file(IDK_SUBS_INCEPTION));
    const c = await checkSubtitles(BASE, [INCEPTION, DARK_KNIGHT], options);
    expect(c?.verdict).toEqual({ kind: "down" });
    expect(c?.result.summary).toBe("movie file not Hebrew (2 titles)");
    expect(c?.result.details).toContainEqual({
      label: "Reason",
      value: "the file listed as heb holds no Hebrew text",
    });
  });

  it("goes down when no request is answered with a 2xx (opensubtitles PRO's 502s)", async () => {
    const bad = json(undefined, 502);
    h.listings.set(INCEPTION_EXTRA, bad);
    h.listings.set(INCEPTION_BARE, bad);
    const c = await checkSubtitles(BASE, [INCEPTION], options);
    expect(c?.verdict).toEqual({ kind: "down" });
    expect(c?.result.summary).toBe("movie HTTP 502");
  });

  it("is undefined without a title to ask for", async () => {
    expect(await checkSubtitles(BASE, [], options)).toBeUndefined();
  });
});

describe("translatesSubtitles", () => {
  it.each([
    [
      {
        id: "community.hebrew-ai-subs",
        name: "idk subs",
        description: "AI-translated Hebrew subtitles",
      },
    ],
    [
      {
        id: "org.autotranslate.sonsuzanime",
        name: "Auto Subtitle Translate by SonsuzAnime (DeepL)",
      },
    ],
    [{ id: "com.nhamstudio.vietsub", name: "NhảmSubtitle AI" }],
    [
      {
        name: "Sublatino - dAV1ron",
        description: "Traducción automática al instante con DeepL, Gemini u OpenAI",
      },
    ],
    [{ name: "SubSync", description: "can translate with Claude (your own API key)" }],
    [{ name: "GTSubs", description: "Auto-translate subtitles using Google Translate" }],
  ])("reads %j as translating", (manifest) => {
    expect(translatesSubtitles(manifest)).toBe(true);
  });

  it.each([
    [{ id: "org.bgsubs", name: "bgSubs", description: "Bulgarian subtitles - Български субтитри" }],
    [
      {
        name: "Strelingo",
        description: "Provides dual subtitles (main + translation) from OpenSubtitles",
      },
    ],
    [
      {
        name: "Hebrew Subtitle Bridge",
        description: "then other languages with optional translation",
      },
    ],
    [{ name: "OpenSubtitles v3" }],
  ])("reads %j as serving existing files", (manifest) => {
    expect(translatesSubtitles(manifest)).toBe(false);
  });
});

describe("subtitleTargets", () => {
  const res: NormResource = { name: "subtitles", types: ["series"], idPrefixes: [] };

  it("puts the override's IDs first, as they are, then every fitting source's episode", async () => {
    h.candidates = [
      { type: "series", id: "tt0903747", episodeId: "tt0903747:1:1", source: "well-known" },
    ];
    const targets = [];
    for await (const t of subtitleTargets(
      res,
      [
        { type: "series", id: "RO_1" },
        { type: "movie", id: "tt1" },
      ],
      log,
    )) {
      targets.push(t);
    }
    expect(targets).toEqual([
      { type: "series", id: "RO_1", source: "curated", curated: true },
      { type: "series", id: "tt0903747:1:1", source: "well-known" },
    ]);
  });
});
