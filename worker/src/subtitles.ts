import { constants, gunzipSync } from "node:zlib";
import { config } from "./config.js";
import {
  attemptsOf,
  describeParseError,
  describeRequestError,
  describeStatus,
  getJson,
  getSample,
  softBlockNote,
  type Attempt,
  type Failure,
  type JsonResult,
} from "./http.js";
import { candidatesFor } from "./idsources.js";
import type { Logger } from "./logger.js";
import { resourceAccepts, type NormResource } from "./manifest.js";
import { alsoTriedRow, answerTime, describeTestId, requestRows } from "./rows.js";
import {
  isUnreachableHost,
  placeholderKind,
  placeholderMeta,
  strongestPlaceholder,
  type PlaceholderKind,
} from "./streams.js";
import type { DetailRow, PerResourceResult } from "./types.js";
import type { ContentAnswer } from "./unconfigured.js";
import { isProtectedUrl } from "./urlcheck.js";
import { encodeId } from "./utils.js";

/** A GTSubs answer runs to 9 MB of notices; no real listing comes near this. */
const MAX_LISTING_BYTES = 2_000_000;
/** Enough of a file to see its format, its first cues and its script. */
const MAX_SAMPLE_BYTES = 64 * 1024;
/** Listing requests that got no answer on either route before the check stops trying further titles, since each costs a full timeout. */
const MAX_UNANSWERED = 2;
/** A file this varied can't be a notice, so its wording isn't read: real dialogue says "access denied" or "log in" too. */
const MAX_NOTICE_CUES = 5;
/** Letters a sample needs before its script says anything about its language. */
const MIN_SCRIPT_LETTERS = 100;
/** Below this share of the expected script, a file labelled with a language is in another one. */
const MIN_SCRIPT_SHARE = 0.01;
/** Above this share of undecodable characters the file isn't UTF-8, so its script can't be read. */
const MAX_UNDECODABLE_SHARE = 0.005;
const CINEMETA = "https://v3-cinemeta.strem.io";
const KITSU = "https://anime-kitsu.strem.fun";

/** A title to request subtitles for. */
export interface SubtitleTarget {
  type: string;
  /** The video ID Stremio requests subtitles with: an episode for series. */
  id: string;
  source?: string;
  /** Named for this addon in its override, so the addon is expected to have subtitles for it. */
  curated?: boolean;
}

export interface SubtitlesOptions {
  /** Titles to try at most, stopping at the first with real subtitles. */
  maxTitles: number;
  /** Fetch the start of the first listed file of a passing answer and check it is a subtitle in its language. */
  sniff: boolean;
  /** Retry deciding requests once on a transport failure. */
  retry: boolean;
  /** The addon translates or generates its subtitles on request, so only a file it says is ready may be fetched. */
  onDemand: boolean;
  log: Logger;
}

/**
 * `content`: real subtitles for a title.
 * `empty`: answered, but nothing for any title tried, which a niche provider can rightly do.
 * `needs-config`: its answers ask to be configured.
 * `down`: it can't answer, answers only notices or bad files, or has nothing for the titles its override says it carries.
 */
export type SubtitlesVerdict =
  { kind: "content" | "empty" | "down" } | { kind: "needs-config"; reason: string };

export interface SubtitlesCheck {
  result: PerResourceResult;
  verdict: SubtitlesVerdict;
  /** Every listing answer, so a missing route can be told from a broken one. */
  answers: Array<ContentAnswer | undefined>;
  /** The request that passed, and how long its answer took. */
  deciding?: { path: string; ms: number };
}

interface Notice {
  placeholder: PlaceholderKind;
  label: string;
}

interface Entry {
  url: string;
  lang: string;
  /** Its ID, label, language and URL path, which say whether fetching it would generate it. */
  wording: string;
}

/** What a listing's entries amount to: real subtitles, notices standing in for them, and entries Stremio can't use. */
export interface Entries {
  real: Entry[];
  notices: Notice[];
  unusable: number;
}

function text(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
}

/**
 * A language as Stremio groups subtitles by it: a code, possibly followed by a region or a note (`pt-BR`, `eng #1 original`), or a name (`English+Spanish`).
 * Not a status (`!SubMaker Error`) or a key (`info:en`).
 */
function isLanguage(lang: string): boolean {
  return /^\p{L}/u.test(lang) && !/[:!?=@<>{}[\]\\|]/.test(lang);
}

function isFetchableUrl(url: string): boolean {
  const u = URL.parse(url);
  if (u?.protocol === "data:") return true;
  return (u?.protocol === "http:" || u?.protocol === "https:") && !isUnreachableHost(u.hostname);
}

function pathOf(url: string): string {
  const u = URL.parse(url);
  if (!u || u.protocol === "data:") return "";
  try {
    return decodeURIComponent(u.pathname + u.search);
  } catch {
    return u.pathname + u.search;
  }
}

function fileNameOf(url: string): string {
  const u = URL.parse(url);
  if (!u || u.protocol === "data:") return "";
  const last = u.pathname.split("/").filter(Boolean).at(-1) ?? "";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/**
 * Sort a listing's entries into real subtitles, notices and unusable ones.
 * A notice says so in its label, language, file name or ID (`api-disabled.vtt`, `config_error_session_token`).
 * Several entries all pointing at one file stand in for something other than subtitles, whatever they say.
 */
export function judgeEntries(subtitles: readonly unknown[]): Entries {
  const real: Entry[] = [];
  const notices: Notice[] = [];
  let unusable = 0;
  for (const s of subtitles) {
    const o = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
    const [id, lang, url] = [text(o.id), text(o.lang), text(o.url)];
    const label = text(o.label) || text(o.title) || text(o.name);
    const file = fileNameOf(url);
    const notice = placeholderMeta({ id, name: [label, lang, file].filter(Boolean).join(" · ") });
    if (notice) {
      const shown = label || (isLanguage(lang) ? "" : lang) || file || id;
      notices.push({ placeholder: notice.placeholder, label: shown });
    } else if (isFetchableUrl(url) && isLanguage(lang)) {
      real.push({ url, lang, wording: [id, label, lang, pathOf(url)].join(" ") });
    } else {
      unusable++;
    }
  }
  if (real.length >= 3 && new Set(real.map((e) => e.url)).size === 1) {
    const file = fileNameOf(real[0].url);
    const label = `same file for every subtitle${file ? ` (${file})` : ""}`;
    notices.push(...real.map(() => ({ placeholder: "no-content" as const, label })));
    real.length = 0;
  }
  return { real, notices, unusable };
}

interface SubtitlesResponse {
  subtitles?: unknown;
}

function entriesOf(data: SubtitlesResponse | undefined): Entries | undefined {
  return Array.isArray(data?.subtitles) ? judgeEntries(data.subtitles) : undefined;
}

/** Ranked so the better of a title's two requests is the one shown. */
type ListingOutcome = "failed" | "unusable" | "empty" | "notices" | "listed";
const LISTING_RANK: Record<ListingOutcome, number> = {
  failed: 0,
  unusable: 1,
  empty: 2,
  notices: 3,
  listed: 4,
};

/** Between two failures, the one the addon answered says more than one that never got an answer. */
function listingRank(l: Listing): number {
  return LISTING_RANK[l.outcome] * 2 + (l.answer ? 1 : 0);
}

interface Listing {
  path: string;
  outcome: ListingOutcome;
  summary: string;
  details: DetailRow[];
  real: Entry[];
  notice?: Notice;
  answer?: JsonResult<SubtitlesResponse>;
  attempts: Attempt[];
}

function noticeReason(n: Notice): string {
  return n.label.startsWith("same file") ? n.label : `addon says: ${n.label}`;
}

function judgeListing(
  path: string,
  testId: string,
  answer: JsonResult<SubtitlesResponse> | undefined,
  failure: Failure | undefined,
  attempts: Attempt[],
): Listing {
  const base = { path, real: [] as Entry[], answer, attempts };
  const rows = (reason?: string) =>
    requestRows(path, attempts, {
      testId,
      reason,
      parseError: answer?.parseError,
      note: answer && softBlockNote(answer),
    });
  if (!answer) {
    const { summary, reason } = failure ?? { summary: "unreachable", reason: undefined };
    return { ...base, outcome: "failed", summary, details: rows(reason) };
  }
  if (answer.status < 200 || answer.status >= 300) {
    const { summary, reason } = describeStatus(answer);
    return { ...base, outcome: "failed", summary, details: rows(reason) };
  }
  if (answer.parseError) {
    const { summary } = describeParseError(answer.parseError);
    return { ...base, outcome: "failed", summary, details: rows() };
  }
  const entries = entriesOf(answer.data);
  if (!entries) {
    return {
      ...base,
      outcome: "failed",
      summary: "invalid",
      details: rows("response has no subtitles array"),
    };
  }
  const total = entries.real.length + entries.notices.length + entries.unusable;
  if (entries.real.length > 0) {
    return {
      ...base,
      outcome: "listed",
      summary: `${total} found`,
      details: rows(),
      real: entries.real,
    };
  }
  const notice = strongestPlaceholder(entries.notices);
  if (notice) {
    return {
      ...base,
      outcome: "notices",
      summary: "notices only",
      details: rows(noticeReason(notice)),
      notice,
    };
  }
  if (total === 0) {
    return {
      ...base,
      outcome: "empty",
      summary: "0 found",
      details: rows("returned no subtitles"),
    };
  }
  return {
    ...base,
    outcome: "unusable",
    summary: `${total} unusable`,
    details: rows(`none of ${total} subtitles has a usable url and language`),
  };
}

/** The script a language is written in, for the languages whose script tells them apart from Latin-script text. */
const SCRIPTS: ReadonlyArray<readonly [RegExp, string, RegExp]> = [
  [/^(he|heb|iw)$/, "Hebrew", /\p{Script=Hebrew}/gu],
  [/^(ar|ara|fa|fas|per|ur|urd|ps|pus)$/, "Arabic", /\p{Script=Arabic}/gu],
  [/^(ru|rus|uk|ukr|bg|bul|be|bel|mk|mkd|mac)$/, "Cyrillic", /\p{Script=Cyrillic}/gu],
  [/^(el|ell|gre)$/, "Greek", /\p{Script=Greek}/gu],
  [/^(zh|zho|chi)$/, "Chinese", /\p{Script=Han}/gu],
  [/^(ja|jpn)$/, "Japanese", /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu],
  [/^(ko|kor)$/, "Korean", /\p{Script=Hangul}/gu],
  [/^(th|tha)$/, "Thai", /\p{Script=Thai}/gu],
  [/^(hi|hin)$/, "Devanagari", /\p{Script=Devanagari}/gu],
];

function scriptOf(lang: string): { name: string; chars: RegExp } | undefined {
  const code = /^[a-z]{2,3}(?![a-z])/i.exec(lang)?.[0].toLowerCase() ?? "";
  const found = SCRIPTS.find(([langs]) => langs.test(code));
  return found && { name: found[1], chars: found[2] };
}

type Format = "SRT" | "VTT" | "ASS" | "MicroDVD";

function formatOf(t: string): Format | undefined {
  if (/^WEBVTT\b/.test(t)) return "VTT";
  if (/^\[Script Info\]/im.test(t) || /^Dialogue:/m.test(t)) return "ASS";
  if (/\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}/.test(t)) return "SRT";
  if (/^\{\d+\}\{\d+\}/m.test(t)) return "MicroDVD";
  return undefined;
}

/** The text of each cue, tags and styling stripped. */
function cueTexts(t: string, format: Format): string[] {
  const clean = (s: string) =>
    s
      .replace(/\{[^}]*\}|<[^>]*>/g, "")
      .replace(/\\[Nn]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  if (format === "ASS") {
    return [...t.matchAll(/^Dialogue:(?:[^,]*,){9}(.*)$/gm)]
      .map((m) => clean(m[1]))
      .filter(Boolean);
  }
  if (format === "MicroDVD") {
    return [...t.matchAll(/^\{\d+\}\{\d+\}(.*)$/gm)]
      .map((m) => clean(m[1].replace(/\|/g, " ")))
      .filter(Boolean);
  }
  return t
    .split(/\r?\n\s*\r?\n/)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const timing = lines.findIndex((l) => l.includes("-->"));
      return timing < 0 ? "" : clean(lines.slice(timing + 1).join(" "));
    })
    .filter(Boolean);
}

/** The sample as text, and whether it decoded cleanly enough to read its script. */
function decodeSample(bytes: Uint8Array): { text: string; readable: boolean } | { binary: string } {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      return decodeSample(gunzipSync(bytes, { finishFlush: constants.Z_SYNC_FLUSH }));
    } catch {
      return { binary: "compressed file" };
    }
  }
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return { binary: "zip archive" };
  }
  const bom16 =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : undefined;
  if (!bom16 && bytes.subarray(0, 512).includes(0)) return { binary: "binary file" };
  const text = new TextDecoder(bom16 ?? "utf-8").decode(bytes).replace(/^\uFEFF/, "");
  const undecodable = (text.match(/\uFFFD/g) ?? []).length;
  return { text, readable: undecodable <= text.length * MAX_UNDECODABLE_SHARE };
}

/**
 * `ok`: a subtitle file; `notice`: a file whose few cues ask to configure or say the addon is off; `bad`: not a subtitle in its language.
 * `unchecked`: the sample says nothing either way (no 2xx answer, an HTML page that may be a challenge, a compressed file), so it doesn't decide.
 */
export type FileVerdict =
  | { kind: "ok"; format: Format }
  | { kind: "notice"; notice: Notice }
  | { kind: "bad"; summary: string; reason: string }
  | { kind: "unchecked"; reason: string };

/** Judge the start of a subtitle file the addon listed under `lang`. */
export function judgeFile(
  sample: { status: number; bytes: Uint8Array; contentType?: string },
  lang: string,
): FileVerdict {
  if (sample.status < 200 || sample.status >= 300) {
    return { kind: "unchecked", reason: `file answered HTTP ${sample.status}` };
  }
  if (sample.bytes.length === 0) {
    return { kind: "bad", summary: "empty file", reason: "the listed subtitle file is empty" };
  }
  const decoded = decodeSample(sample.bytes);
  if ("binary" in decoded) return { kind: "unchecked", reason: `file is a ${decoded.binary}` };
  const format = formatOf(decoded.text.trimStart());
  if (!format) {
    const kind = placeholderKind(decoded.text.slice(0, 500));
    if (kind)
      return { kind: "notice", notice: { placeholder: kind, label: excerpt(decoded.text) } };
    if (
      /\btext\/html\b/i.test(sample.contentType ?? "") ||
      decoded.text.trimStart().startsWith("<")
    ) {
      return { kind: "unchecked", reason: "file is an HTML page" };
    }
    return {
      kind: "bad",
      summary: "not a subtitle file",
      reason: "the listed file is not SRT, VTT or ASS",
    };
  }
  const cues = cueTexts(decoded.text, format);
  if (new Set(cues).size <= MAX_NOTICE_CUES) {
    const kinds = cues.flatMap((c) => {
      const placeholder = placeholderKind(c);
      return placeholder ? [{ placeholder, label: excerpt(c) }] : [];
    });
    const notice = strongestPlaceholder(kinds);
    if (notice) return { kind: "notice", notice };
  }
  const script = scriptOf(lang);
  if (script && decoded.readable) {
    const body = cues.join(" ");
    const letters = (body.match(/\p{L}/gu) ?? []).length;
    const inScript = (body.match(script.chars) ?? []).length;
    if (letters >= MIN_SCRIPT_LETTERS && inScript < letters * MIN_SCRIPT_SHARE) {
      return {
        kind: "bad",
        summary: `file not ${script.name}`,
        reason: `the file listed as ${lang} holds no ${script.name} text`,
      };
    }
  }
  return { kind: "ok", format };
}

function excerpt(t: string): string {
  const one = t
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, "…")
    .replace(/\s+/g, " ")
    .trim();
  return one.length > 120 ? `${one.slice(0, 119)}…` : one;
}

function decodeDataUrl(url: string): { bytes: Uint8Array; contentType?: string } | undefined {
  const comma = url.indexOf(",");
  if (comma < 0) return undefined;
  const meta = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  try {
    const bytes = /;base64$/i.test(meta)
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf8");
    return { bytes, contentType: meta.split(";")[0] || undefined };
  } catch {
    return undefined;
  }
}

/** A file translated or generated on request: fetching one can start paid work on the operator's account or, through a configured URL, the lister's own key. */
const GENERATED =
  /translat|\b(ai|llm)\b|deepl|gemini|\bgpt|openai|chatgpt|claude|groq|deepseek|machine|on[- _]?demand|generat/i;
const READY = /\b(ready|cached)\b/i;
/** Addon names and IDs that say they translate, and descriptions that name a translation service. */
const TRANSLATING_NAME = /translat|\bai\b|deepl|gemini|\bgpt|openai/i;
const TRANSLATING_DESCRIPTION =
  /\b(ai|machine|auto)[- ]?(translat|generat)|\btranslat\w* (with|using|via|by|through) (ai|deepl|gemini|google|openai|chatgpt|gpt|claude|llm)|\b(deepl|gemini|openai|chatgpt|gpt-?\d\w*|claude|llm|groq|deepseek|google translate)\b/i;

/** Whether the addon's manifest says it translates or generates subtitles, whose files a probe must not request. */
export function translatesSubtitles(manifest: {
  id?: unknown;
  name?: unknown;
  description?: unknown;
}): boolean {
  return (
    TRANSLATING_NAME.test(`${text(manifest.id)} ${text(manifest.name)}`) ||
    TRANSLATING_DESCRIPTION.test(text(manifest.description))
  );
}

/**
 * Whether a listed file may be fetched: an inline one always, a protected one never, and one generated on request only when it says it is ready.
 * Skipping a file leaves the listing to decide, so it never makes the addon DOWN.
 */
function mayFetch(e: Entry, base: string, onDemand: boolean): boolean {
  if (e.url.startsWith("data:")) return true;
  if (isProtectedUrl(e.url, base)) return false;
  return READY.test(e.wording) || (!onDemand && !GENERATED.test(e.wording));
}

/** Statuses that may be about the worker's egress rather than the file. */
const REFUSALS = new Set([401, 403, 429]);

/**
 * One sampled file and the row describing it, which names only its host: the URL can carry the addon's config.
 * A file the addon serves itself that fails on every route is its failure, unlike one on a third-party host that may only refuse the worker.
 */
async function sampleFile(
  entry: Entry,
  addonHost: string | undefined,
): Promise<{ verdict: FileVerdict; row: DetailRow }> {
  if (entry.url.startsWith("data:")) {
    const decoded = decodeDataUrl(entry.url);
    const verdict = decoded
      ? judgeFile({ status: 200, ...decoded }, entry.lang)
      : {
          kind: "bad" as const,
          summary: "not a subtitle file",
          reason: "the listed data: URL doesn't decode",
        };
    return { verdict, row: { label: "File", value: `inline data: URL · ${fileOutcome(verdict)}` } };
  }
  const host = URL.parse(entry.url)?.hostname ?? "?";
  const own = host === addonHost;
  try {
    const sample = await getSample(entry.url, config.timeouts.meta, MAX_SAMPLE_BYTES);
    const failed = sample.status < 200 || sample.status >= 300;
    const verdict: FileVerdict =
      own && failed && !REFUSALS.has(sample.status)
        ? {
            kind: "bad",
            summary: `file HTTP ${sample.status}`,
            reason: `the addon's own subtitle file answered HTTP ${sample.status}`,
          }
        : judgeFile(sample, entry.lang);
    const last = sample.attempts.at(-1);
    const via = last ? `${last.route} · HTTP ${sample.status} · ` : "";
    return { verdict, row: { label: "File", value: `${host} · ${via}${fileOutcome(verdict)}` } };
  } catch (e) {
    const { summary, reason } = describeRequestError(e);
    const attempts = attemptsOf(e);
    const verdict: FileVerdict = own
      ? {
          kind: "bad",
          summary: `file ${summary}`,
          reason: `the addon's own subtitle file: ${reason}`,
        }
      : { kind: "unchecked", reason: `file unreachable: ${reason}` };
    return {
      verdict,
      row: { label: "File", value: `${host} · ${attempts.at(-1)?.error ?? "unreachable"}` },
    };
  }
}

function fileOutcome(v: FileVerdict): string {
  switch (v.kind) {
    case "ok":
      return v.format;
    case "notice":
      return "notice";
    case "bad":
      return v.summary;
    case "unchecked":
      return "not checked";
  }
}

const releaseNames = new Map<string, Promise<string | undefined>>();

/** A title's name and year as a release name puts them (`The.Dark.Knight.2008`), looked up once per title. */
function releaseNameOf(type: string, id: string): Promise<string | undefined> {
  const base = id.startsWith("kitsu:") ? id.split(":").slice(0, 2).join(":") : id.split(":")[0];
  const key = `${type}/${base}`;
  let pending = releaseNames.get(key);
  if (!pending) {
    pending = lookUpReleaseName(type, base);
    releaseNames.set(key, pending);
    void pending.then((name) => name === undefined && releaseNames.delete(key));
  }
  return pending;
}

async function lookUpReleaseName(type: string, id: string): Promise<string | undefined> {
  const source = /^tt\d+$/.test(id) ? CINEMETA : id.startsWith("kitsu:") ? KITSU : undefined;
  if (!source || (type !== "movie" && type !== "series")) return undefined;
  try {
    const { status, data } = await getJson<{
      meta?: { name?: unknown; year?: unknown; releaseInfo?: unknown };
    }>(`${source}/meta/${type}/${encodeId(id)}.json`, config.timeouts.meta);
    const meta = status >= 200 && status < 300 ? data?.meta : undefined;
    const name = typeof meta?.name === "string" ? dotted(meta.name) : "";
    if (!name) return undefined;
    const year = /\d{4}/.exec(`${meta?.year ?? ""} ${meta?.releaseInfo ?? ""}`)?.[0];
    return year && type === "movie" ? `${name}.${year}` : name;
  } catch {
    return undefined;
  }
}

function dotted(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, ".")
    .replace(/^\.|\.$/g, "");
}

/**
 * The file name Stremio would send for a typical release of the title, as some addons only route requests carrying one (Napisy24) or only match on it (Persian Subtitles).
 * Episode IDs (`tt0903747:1:1`, `kitsu:1376:1`) become `S01E01`.
 */
export function releaseFileName(name: string, id: string): string {
  const parts = id.split(":");
  const numbers = parts.slice(id.startsWith("kitsu:") ? 2 : 1).map(Number);
  const [season, episode] = numbers.length === 1 ? [1, numbers[0]] : numbers;
  const pad = (n: number) => String(n).padStart(2, "0");
  const ep =
    episode !== undefined && Number.isInteger(season) && Number.isInteger(episode)
      ? `.S${pad(season)}E${pad(episode)}`
      : "";
  return `${name}${ep}.1080p.WEB-DL.mkv`;
}

/**
 * The titles to try, in order: those the addon's override names, then every fitting ID source's.
 * Curated IDs are requested as they are, so a series one names its episode.
 */
export async function* subtitleTargets(
  res: NormResource,
  curated: ReadonlyArray<{ type: string; id: string }>,
  log: Logger,
): AsyncGenerator<SubtitleTarget> {
  const seen = new Set<string>();
  const fresh = (t: SubtitleTarget) => {
    const key = `${t.type}/${t.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  for (const c of curated) {
    const t = { ...c, source: "curated", curated: true };
    if (resourceAccepts(res, c.type, c.id) && fresh(t)) yield t;
  }
  const borrowed = await candidatesFor(res).catch((e: unknown) => {
    log.debug({ step: "testid", err: String(e) }, "ID source lookup failed");
    return [];
  });
  for (const c of borrowed) {
    const t = { type: c.type, id: c.episodeId ?? c.id, source: c.source };
    if (fresh(t)) yield t;
  }
}

function listingPath(t: SubtitleTarget, fileName?: string): string {
  const extra = fileName ? `/filename=${encodeURIComponent(fileName)}` : "";
  return `/subtitles/${encodeId(t.type)}/${encodeId(t.id)}${extra}.json`;
}

type TitleOutcome = "failed" | "unusable" | "empty" | "bad-file" | "notices" | "passed";
const TITLE_RANK: Record<TitleOutcome, number> = {
  failed: 0,
  unusable: 1,
  empty: 2,
  "bad-file": 3,
  notices: 4,
  passed: 5,
};

interface TitleCheck {
  target: SubtitleTarget;
  outcome: TitleOutcome;
  path: string;
  summary: string;
  details: DetailRow[];
  notice?: Notice;
  answers: Array<JsonResult<SubtitlesResponse> | undefined>;
  answeredInMs?: number;
  unanswered: boolean;
  timedOut: boolean;
  /** Listed, but its file is generated on request, so it wasn't fetched. */
  unfetched?: boolean;
}

async function fetchListing(
  base: string,
  t: SubtitleTarget,
  path: string,
  retry: boolean,
): Promise<Listing> {
  const testId = describeTestId(t.id, t.source);
  try {
    const answer = await getJson<SubtitlesResponse>(base + path, config.timeouts.meta, {
      retry,
      maxBytes: MAX_LISTING_BYTES,
      usable: (data) => (entriesOf(data)?.real.length ?? 0) > 0,
    });
    return judgeListing(path, testId, answer, undefined, answer.attempts);
  } catch (e) {
    return judgeListing(path, testId, undefined, describeRequestError(e), attemptsOf(e));
  }
}

/**
 * Request one title as Stremio does, with a file name, and without one when that gets no subtitles: some addons answer only the bare form (Subtitle Search Engine).
 * With `sniff`, the first listed file must then be a subtitle in its language.
 */
async function checkTitle(
  base: string,
  t: SubtitleTarget,
  { sniff, retry, onDemand }: Pick<SubtitlesOptions, "sniff" | "retry" | "onDemand">,
): Promise<TitleCheck> {
  const name = (await releaseNameOf(t.type, t.id)) ?? dotted(t.id);
  const listings = [
    await fetchListing(base, t, listingPath(t, releaseFileName(name, t.id)), retry),
  ];
  if (listings[0].outcome !== "listed")
    listings.push(await fetchListing(base, t, listingPath(t), retry));
  const best = listings.reduce((a, b) => (listingRank(b) > listingRank(a) ? b : a));
  const others = listings.filter((l) => l !== best).map((l) => alsoTriedRow(l.path, l.summary));
  const attempts = listings.flatMap((l) => l.attempts);
  const check: TitleCheck = {
    target: t,
    outcome: best.outcome === "listed" ? "passed" : best.outcome,
    path: best.path,
    summary: best.summary,
    details: [...best.details, ...others],
    notice: best.notice,
    answers: listings.map((l) => l.answer),
    answeredInMs: best.answer && answerTime(best.answer),
    unanswered: listings.every((l) => !l.answer),
    timedOut: attempts.some((a) => a.timedOut),
  };
  if (best.outcome !== "listed" || !sniff) return check;
  const entry = best.real.find((e) => mayFetch(e, base, onDemand));
  if (!entry) {
    check.details.push({ label: "Note", value: "file not checked: generated on request" });
    return { ...check, unfetched: true };
  }
  const { verdict, row } = await sampleFile(entry, URL.parse(base)?.hostname);
  check.details.push(row);
  if (verdict.kind === "notice") {
    return {
      ...check,
      outcome: "notices",
      summary: "notice file",
      notice: verdict.notice,
      details: [...check.details, { label: "Reason", value: noticeReason(verdict.notice) }],
    };
  }
  if (verdict.kind === "bad") {
    return {
      ...check,
      outcome: "bad-file",
      summary: verdict.summary,
      details: [...check.details, { label: "Reason", value: verdict.reason }],
    };
  }
  if (verdict.kind === "unchecked") check.details.push({ label: "Note", value: verdict.reason });
  return check;
}

/**
 * Check a subtitles resource on up to `maxTitles` titles, in order, stopping at the first with real subtitles or a notice about the addon itself.
 * An empty answer is right for a title a niche provider lacks, so it fails the check only for a title the addon's override says it carries.
 * Returns undefined when there is no title to ask for.
 */
export async function checkSubtitles(
  base: string,
  targets: Iterable<SubtitleTarget> | AsyncIterable<SubtitleTarget>,
  options: SubtitlesOptions,
): Promise<SubtitlesCheck | undefined> {
  const titles: TitleCheck[] = [];
  let retry = options.retry;
  for await (const t of targets) {
    if (titles.length >= options.maxTitles) break;
    const check = await checkTitle(base, t, { ...options, retry });
    titles.push(check);
    if (check.timedOut) retry = false;
    options.log.debug(
      { step: "subtitles", outcome: check.outcome, type: t.type, id: t.id, source: t.source },
      `subtitles check ${check.outcome}: ${t.type} ${check.summary}`,
    );
    const aboutAddon = check.outcome === "notices" && check.notice?.placeholder !== "no-content";
    // A title whose file wasn't fetched leaves room for another whose file says it is ready.
    if ((check.outcome === "passed" && !check.unfetched) || aboutAddon) break;
    if (titles.filter((c) => c.unanswered).length >= MAX_UNANSWERED) break;
  }
  if (titles.length === 0) return undefined;

  const verdict = subtitlesVerdict(titles);
  const best = titles.reduce((a, b) => (TITLE_RANK[b.outcome] > TITLE_RANK[a.outcome] ? b : a));
  const others = titles.filter((c) => c !== best);
  const passed = best.outcome === "passed";
  const details = [
    ...best.details,
    ...others.map((c) => alsoTriedRow(describeTestId(c.path, c.target.source), c.summary)),
  ];
  if (verdict.kind === "empty") {
    details.push({
      label: "Note",
      value: "no subtitles for any title tried; a niche provider may lack them",
    });
  }
  if (verdict.kind === "down" && titles.some((c) => c.target.curated && c.outcome === "empty")) {
    details.push({
      label: "Note",
      value: "no subtitles for the titles its override says it carries",
    });
  }
  return {
    result: {
      resource: "subtitles",
      ok: verdict.kind !== "down",
      summary: `${best.target.type} ${best.summary}${others.length > 0 && !passed ? ` (${titles.length} titles)` : ""}`,
      details,
    },
    verdict,
    answers: titles.flatMap((c) => c.answers),
    ...(passed ? { deciding: { path: best.path, ms: best.answeredInMs ?? 0 } } : {}),
  };
}

/** A ready file of an addon that generates its subtitles outweighs listings whose files weren't fetched: it is the only output of the addon that was checked. */
function subtitlesVerdict(titles: TitleCheck[]): SubtitlesVerdict {
  const passed = titles.filter((c) => c.outcome === "passed");
  if (passed.some((c) => !c.unfetched)) return { kind: "content" };
  if (passed.length > 0) {
    return titles.some((c) => c.outcome === "bad-file") ? { kind: "down" } : { kind: "content" };
  }
  const notice = strongestPlaceholder(titles.flatMap((c) => c.notice ?? []));
  if (notice?.placeholder === "error") return { kind: "down" };
  if (notice?.placeholder === "needs-config") return { kind: "needs-config", reason: notice.label };
  if (titles.some((c) => c.outcome === "bad-file")) return { kind: "down" };
  const empty = titles.filter((c) => c.outcome === "empty");
  if (empty.length === 0) return { kind: "down" };
  const curated = titles.filter((c) => c.target.curated);
  if (curated.length > 0 && curated.every((c) => c.outcome === "empty" || c.outcome === "failed")) {
    return { kind: "down" };
  }
  return { kind: "empty" };
}
