import type { Manifest, ManifestCatalog, MetaDetail, MetaPreview } from "@stremio-addon/sdk";
import { mapLimit } from "./concurrency.js";
import { config } from "./config.js";
import { streamIdForMeta, type PlayableMeta } from "./episodes.js";
import {
  attemptsOf,
  describeParseError,
  describeRequestError,
  describeStatus,
  getJson,
  softBlockNote,
  type Attempt,
  type Failure,
  type GetJsonOptions,
  type JsonResult,
  type ParseError,
} from "./http.js";
import { alsoTriedRow, answerTime, describeTestId, requestRows } from "./rows.js";
import { encodeId, errMsg, plural } from "./utils.js";
import { corsAnnotation, STREMIO_WEB_HEADERS } from "./cors.js";
import {
  catalogCoverage,
  coveragePicks,
  hasInstallableAddon,
  judgeAddonCatalog,
} from "./catalogs.js";
import {
  metaBodyDefect,
  metaDefects,
  metaFlaws,
  metasWithout,
  missingMetaFields,
} from "./metas.js";
import { candidatesFor, hasSourceFor, type TestContent } from "./idsources.js";
import { logger, type Logger } from "./logger.js";
import {
  declaredConfigRequirement,
  effectivePrefixes,
  missingManifestFields,
  normalizeResources,
  resourceAccepts,
  type NormResource,
} from "./manifest.js";
import { overrideFor, probeBaseUrl } from "./overrides.js";
import {
  classifyStream,
  placeholderMeta,
  repeatedFingerprints,
  strongestPlaceholder,
  type MetaNotice,
  type StreamClass,
} from "./streams.js";
import { checkSubtitles, subtitleTargets } from "./subtitles.js";
import { unconfiguredReason, type ContentAnswer } from "./unconfigured.js";
import {
  checkUrl,
  describeUrlChecks,
  followLink,
  isProtectedUrl,
  negativeControlId,
  urlsToCheck,
  type LinkPage,
  type UrlCheck,
} from "./urlcheck.js";
import type { DetailRow, NormalizedAddon, PerResourceResult, ProbeResult } from "./types.js";

/** Stream requests per probed type: enough to get past titles the addon happens to lack, few enough to look like one user browsing. */
const MAX_STREAM_REQUESTS_PER_TYPE = 3;
const MAX_CATALOGS_PER_TYPE = 3;
const ITEMS_PER_CATALOG = 3;
/** Catalog items whose stream ID is worked out per type, since each can cost a meta request. */
const MAX_ITEMS_PER_TYPE = 5;
/** Probed types in flight at once, so one addon sees a Stremio client rather than a burst that trips its rate limiter. */
const TYPES_IN_FLIGHT = 2;
/** Stream requests that got no answer on either route before the probe stops trying further IDs, since each costs a full timeout. */
const MAX_UNANSWERED_STREAM_REQUESTS = 2;
/** Distinctive titles for search-only catalogs: some search backends match nothing for a common word like "the". */
const SEARCH_TERMS = ["batman", "naruto", "love"];
const CINEMETA = "https://v3-cinemeta.strem.io";
/** Targets per probed type whose stream URLs all proved dead before the type stops trying further titles. */
const DEAD_TARGETS_PER_TYPE = 2;
/** The negative control only asks whether the addon answers at all, which a templating addon does at once. */
const NEGATIVE_CONTROL_TIMEOUT_MS = 10_000;
/** A deciding request slower than this still works, but keeps a user waiting long enough to say so. */
const SLOW_MS = 10_000;
/** Titles a subtitles-only addon is asked for: a movie and a series where it advertises both, and one more. */
const MAX_SUBTITLE_TITLES = 3;
const IMDB_ID = /^tt\d+$/;

interface CatalogResponse {
  metas?: Array<MetaPreview & { imdb_id?: string }>;
}
interface MetaResponse {
  meta?: MetaDetail;
}
interface StreamResponse {
  streams?: unknown[];
}

function isOkStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

/** A request that decided the verdict, and how long its answer took. */
interface Timing {
  path: string;
  ms: number;
}

/** Note a passing primary resource whose slowest deciding request kept the user waiting. */
function markSlow(res: PerResourceResult, deciding: Timing[]): void {
  const slowest = deciding.reduce<Timing | undefined>(
    (a, b) => (a && a.ms >= b.ms ? a : b),
    undefined,
  );
  if (!slowest || slowest.ms <= SLOW_MS) return;
  res.summary += ` · slow (${Math.round(slowest.ms / 1000)} s)`;
  res.details.unshift({
    label: "Slow",
    value: `${slowest.path} answered in ${(slowest.ms / 1000).toFixed(1)} s`,
  });
}

/** The options for a request that decides the verdict: worth a retry, and worth asking the other route when the answer has nothing in it. */
function deciding<T>(usable: (data: T) => boolean, retry = true): GetJsonOptions<T> {
  return { retry, usable };
}

function hasPlayableStream(data: StreamResponse | undefined, baseUrl: string): boolean {
  const streams = data?.streams;
  return (
    Array.isArray(streams) &&
    streams.some((s) => classifyStream(s, { baseUrl }).kind === "playable")
  );
}

function hasRealMeta(data: CatalogResponse | undefined): boolean {
  const metas = data?.metas;
  return (
    Array.isArray(metas) &&
    metas.some((m) => missingMetaFields(m).length === 0 && placeholderMeta(m) === undefined)
  );
}

function hasValidMeta(data: MetaResponse | undefined): boolean {
  return missingMetaFields(data?.meta).length === 0;
}

/** A test ID and where it came from, before the ID its stream request asks for is known. */
interface Candidate extends TestContent {
  origin: "curated" | "own" | "remembered" | "borrowed";
}

/** A candidate with the ID Stremio would request its streams with. */
interface StreamTarget extends Candidate {
  streamId: string;
}

/** One catalog request and what it offered to test with. */
interface CatalogAttempt {
  catalog: ManifestCatalog;
  /** The catalog's declared type. */
  type: string;
  path: string;
  /** `items`: real titles; `notices`: only notice tiles; `empty`: no usable metas; `failed`: no usable answer. */
  kind: "items" | "notices" | "empty" | "failed";
  ok: boolean;
  summary: string;
  details: DetailRow[];
  items: Candidate[];
  /** Set when every item was a notice ("TMDB key required", a donation tile), so the catalog offers nothing to test with. */
  notice?: MetaNotice;
  /** Unset when the request threw. */
  answer?: ContentAnswer;
  /** The metas a parsed 2xx answer listed, and those lacking a required field. */
  metas?: { total: number; invalid: number; missing: string[] };
}

/** A catalog the worker can query, with the requests to try in order: each later one runs only when the previous came back empty. */
interface CatalogPlan {
  catalog: ManifestCatalog;
  paths: string[];
  /** Catalogs needing no user input come first. */
  rank: number;
  /** A search-only catalog, whose answer depends on the term as much as on the addon. */
  search: boolean;
}

function extraPair(name: string, value: string): string {
  return `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
}

/**
 * How to query a catalog, or null when it requires input the worker can't give.
 * A required search tries several terms; an optional extra with options is retried with its first option, as some catalogs are empty without one.
 * `extraRequired` is the legacy way of marking extras required, which Stremio still honours.
 */
function catalogPlan(catalog: ManifestCatalog): CatalogPlan | null {
  const extras = catalog.extra ?? [];
  const legacy = (catalog as { extraRequired?: unknown }).extraRequired;
  const required = new Set([
    ...extras.filter((e) => e.isRequired).map((e) => e.name),
    ...(Array.isArray(legacy) ? legacy.filter((n): n is string => typeof n === "string") : []),
  ]);
  const fixed: string[] = [];
  for (const name of required) {
    if (name === "search") continue;
    const options = extras.find((e) => e.name === name)?.options;
    if (!options?.length) return null;
    fixed.push(extraPair(name, options[0]));
  }
  const variants = required.has("search")
    ? SEARCH_TERMS.map((term) => [...fixed, extraPair("search", term)])
    : [fixed];
  const optional = extras.find(
    (e) => !required.has(e.name) && e.name !== "search" && e.name !== "skip" && e.options?.length,
  );
  if (optional && !required.has("search")) {
    variants.push([...fixed, extraPair(optional.name, optional.options![0])]);
  }
  const base = `/catalog/${encodeId(catalog.type)}/${encodeId(catalog.id)}`;
  return {
    catalog,
    paths: variants.map((v) => `${base}${v.length > 0 ? `/${v.join("&")}` : ""}.json`),
    rank: required.size === 0 ? 0 : 1,
    search: required.has("search"),
  };
}

/** The source a catalog ID names (`latanime` in `latanime-latest`), whose catalogs tend to fail together. */
function catalogSource(catalog: ManifestCatalog): string {
  return catalog.id.toLowerCase().split(/[-_.:|/\s]/)[0];
}

/** Usable catalogs in the order to try them: those needing no input first, alternating between sources so one failing backend doesn't use up every try. */
function catalogPlans(catalogs: ManifestCatalog[]): CatalogPlan[] {
  const seen = new Map<string, number>();
  return catalogs
    .map(catalogPlan)
    .filter((p): p is CatalogPlan => p !== null)
    .map((plan, index) => {
      const key = `${plan.rank}/${catalogSource(plan.catalog)}`;
      const round = seen.get(key) ?? 0;
      seen.set(key, round + 1);
      return { plan, index, round };
    })
    .sort((a, b) => a.plan.rank - b.plan.rank || a.round - b.round || a.index - b.index)
    .map(({ plan }) => plan);
}

/** Catalog types are matched like stream types, but case-insensitively, since addons write `Anime` in one place and `anime` in another. */
function sameType(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

async function fetchCatalog(
  base: string,
  catalog: ManifestCatalog,
  path: string,
  options: GetJsonOptions<CatalogResponse>,
): Promise<CatalogAttempt> {
  const attempt = { catalog, type: catalog.type, path, items: [] as Candidate[] };
  try {
    const result = await getJson<CatalogResponse>(base + path, config.timeouts.catalog, options);
    const { status, data, parseError, attempts } = result;
    const note = softBlockNote(result);
    const answered = { ...attempt, answer: result };
    if (!isOkStatus(status)) {
      const { summary, reason } = describeStatus(result);
      return {
        ...answered,
        kind: "failed",
        ok: false,
        summary,
        details: requestRows(path, attempts, { reason, note }),
      };
    }
    if (parseError) {
      return {
        ...answered,
        kind: "failed",
        ok: false,
        summary: describeParseError(parseError).summary,
        details: requestRows(path, attempts, { parseError, note }),
      };
    }
    const metas = Array.isArray(data?.metas) ? data.metas : [];
    const valid = metas.filter((m) => missingMetaFields(m).length === 0);
    const { invalid, missing } = metaDefects(metas);
    const counted = { ...answered, metas: { total: metas.length, invalid, missing } };
    if (valid.length === 0) {
      const reason =
        metas.length === 0
          ? "returned no metas"
          : `none of ${metas.length} metas has an id, type and name`;
      return {
        ...counted,
        kind: "empty",
        ok: false,
        summary:
          metas.length === 0
            ? "empty"
            : `invalid (${metasWithout(invalid, metas.length, missing)})`,
        details: requestRows(path, attempts, { reason, note }),
      };
    }
    const real = valid.filter((m) => placeholderMeta(m) === undefined);
    if (real.length === 0) {
      const notice = strongestPlaceholder(valid.map((m) => placeholderMeta(m)!))!;
      return {
        ...counted,
        kind: "notices",
        // A catalog of donation or news tiles still answers; it only has nothing to test with.
        ok: notice.placeholder === "no-content",
        summary: "only notices",
        notice,
        details: requestRows(path, attempts, { reason: `addon says: ${notice.label}`, note }),
      };
    }
    return {
      ...counted,
      kind: "items",
      ok: true,
      summary: `${metas.length} metas`,
      details: requestRows(path, attempts, { note }),
      items: real.map((m) => ({
        type: m.type || catalog.type,
        id: m.id,
        source: "own catalog",
        origin: "own" as const,
      })),
    };
  } catch (e) {
    const { summary, reason } = describeRequestError(e);
    return {
      ...attempt,
      kind: "failed",
      ok: false,
      summary,
      details: requestRows(path, attemptsOf(e), { reason }),
    };
  }
}

/** One catalog walk's verdict: the catalog that yielded titles, or why none did. */
interface CatalogWalk {
  ok: boolean;
  content: boolean;
  label: string;
  summary: string;
  details: DetailRow[];
  /** The request that yielded titles. */
  deciding?: Timing;
}

function judgeCatalogWalk(attempts: CatalogAttempt[]): CatalogWalk {
  const found = attempts.find((a) => a.kind === "items");
  const shown = found ?? attempts[0];
  const others = attempts.filter((a) => a !== shown);
  const details = [...shown.details, ...others.map((a) => alsoTriedRow(a.path, a.summary))];
  if (found) {
    return {
      ok: true,
      content: true,
      label: found.type,
      summary: found.summary,
      details,
      deciding: { path: found.path, ms: found.answer ? answerTime(found.answer) : 0 },
    };
  }
  const summaries = [...new Set(attempts.map((a) => a.summary))].join(", ");
  return {
    ok: attempts.every((a) => a.ok),
    content: false,
    label: shown.type,
    summary: attempts.length === 1 ? shown.summary : `${summaries} (${attempts.length} tries)`,
    details,
  };
}

interface MetaFetch {
  path: string;
  /** Unset when the request threw. */
  answer?: JsonResult<MetaResponse>;
  failure?: Failure;
  attempts: Attempt[];
}

function validMeta(f: MetaFetch): Record<string, unknown> | undefined {
  const a = f.answer;
  if (!a || !isOkStatus(a.status) || a.parseError) return undefined;
  const meta: unknown = a.data?.meta;
  return meta && typeof meta === "object" && !Array.isArray(meta)
    ? (meta as Record<string, unknown>)
    : undefined;
}

/**
 * The parts of an untrusted meta answer that decide its stream ID, keeping only well-formed values.
 * Stremio opens a title under the ID its catalog listed, which is what a meta without videos plays, even when the meta names itself differently.
 */
function playableMeta(meta: Record<string, unknown>, id: string): PlayableMeta {
  const hints = meta.behaviorHints as { defaultVideoId?: unknown } | null | undefined;
  const videos = Array.isArray(meta.videos)
    ? meta.videos.filter(
        (v): v is { id: string; season?: number; episode?: number } =>
          typeof (v as { id?: unknown } | null)?.id === "string",
      )
    : undefined;
  return {
    id,
    videos,
    behaviorHints:
      typeof hints?.defaultVideoId === "string"
        ? { defaultVideoId: hints.defaultVideoId }
        : undefined,
  };
}

/** The episode Stremio would play for an IMDb series no addon of its own describes: Cinemeta's, else S1E1. */
async function cinemetaEpisode(id: string): Promise<string> {
  try {
    const { status, data } = await getJson<MetaResponse>(
      `${CINEMETA}/meta/series/${encodeId(id)}.json`,
      config.timeouts.meta,
    );
    const meta = isOkStatus(status)
      ? (data?.meta as Record<string, unknown> | undefined)
      : undefined;
    const episode = meta ? streamIdForMeta(playableMeta(meta, id)) : id;
    return episode === id ? `${id}:1:1` : episode;
  } catch {
    return `${id}:1:1`;
  }
}

/** One stream request as the addon answered it, before it is judged against the other targets. */
interface StreamFetch {
  target: StreamTarget;
  /** The ID the request asked for. */
  id: string;
  path: string;
  testId: string;
  attempts: Attempt[];
  /** Unset when the request threw. */
  status?: number;
  streams: StreamClass[];
  failure?: Failure;
  parseError?: ParseError;
  /** Unset when the request threw. */
  answer?: JsonResult<StreamResponse>;
  verification?: Verification;
}

/** An addon answering an ID no title can have with streams: it pastes the ID into a template rather than looking anything up. */
interface Templated {
  /** The nonexistent ID asked for. */
  id: string;
  /** Its answer's playable `url` streams and links, leaving out static cards the real title got too. */
  urls: number;
  links: number;
}

/** What the worker learned about a target's streams beyond the answer itself. */
interface Verification {
  /** The checked stream URLs, set when every playable stream is a URL the worker may request. */
  urls?: UrlCheck[];
  templated?: Templated;
  /** The page behind the target's first link, opened when the addon templates its links. */
  linkPage?: LinkPage;
}

/** `linkPage`: read from the page a templated link opens rather than from the stream itself. */
type Placeholder = Extract<StreamClass, { kind: "placeholder" }> & {
  repeated?: boolean;
  linkPage?: boolean;
};

/**
 * `content`: at least one real playable stream.
 * `links`: no playable stream, but real links (externalUrl, trailers).
 * `dead`: playable streams whose checked URLs can't play: all dead, or templated and none proved playable.
 * `placeholder`: notices only, or links beside a notice saying the addon is broken or unconfigured, which are its request forms and configure links.
 * `empty`: nothing usable; `failed`: no 2xx answer.
 */
type StreamOutcome = "content" | "dead" | "links" | "placeholder" | "empty" | "failed";

const OUTCOME_RANK: Record<StreamOutcome, number> = {
  content: 5,
  dead: 4,
  links: 3,
  placeholder: 2,
  empty: 1,
  failed: 0,
};

interface StreamCheckResult {
  target: StreamTarget;
  path: string;
  outcome: StreamOutcome;
  total: number;
  playable: number;
  links: number;
  notice?: Placeholder;
  summary: string;
  details: DetailRow[];
  /** Unset when the request threw. */
  answeredInMs?: number;
}

/**
 * A stream repeated for unrelated titles stands in for something other than the title.
 * Without wording to say what, a configurable addon is most likely asking to be configured.
 */
function judgedStream(c: StreamClass, repeated: Set<string>, configurable: boolean): StreamClass {
  if ((c.kind !== "playable" && c.kind !== "link") || !repeated.has(c.fingerprint)) return c;
  const placeholder: Placeholder = {
    kind: "placeholder",
    placeholder: configurable ? "needs-config" : "no-content",
    fingerprint: c.fingerprint,
    label: c.label,
    repeated: true,
  };
  return placeholder;
}

function judgeStreamFetch(
  f: StreamFetch,
  repeated: Set<string>,
  configurable: boolean,
): StreamCheckResult {
  const note = f.answer && softBlockNote(f.answer);
  const rows = (reason?: string) =>
    requestRows(f.path, f.attempts, { testId: f.testId, reason, parseError: f.parseError, note });
  const answeredInMs = f.answer && answerTime(f.answer);
  const failed = {
    target: f.target,
    path: f.path,
    outcome: "failed" as const,
    total: 0,
    playable: 0,
    links: 0,
    answeredInMs,
  };
  if (!f.answer) {
    const { summary, reason } = f.failure ?? { summary: "unreachable", reason: undefined };
    return { ...failed, summary, details: rows(reason) };
  }
  if (!isOkStatus(f.answer.status)) {
    const { summary, reason } = describeStatus(f.answer);
    return { ...failed, summary, details: rows(reason) };
  }
  if (f.parseError) {
    return { ...failed, summary: describeParseError(f.parseError).summary, details: rows() };
  }
  const streams = f.streams.map((c) => judgedStream(c, repeated, configurable));
  const total = streams.length;
  let playable = streams.filter((c) => c.kind === "playable").length;
  const links = streams.filter((c) => c.kind === "link").length;
  const v = f.verification;
  const pageNotice = links > 0 && playable === 0 ? linkPageNotice(v?.linkPage) : undefined;
  let notice = strongestPlaceholder([
    ...streams.filter((c): c is Placeholder => c.kind === "placeholder"),
    ...(pageNotice ? [pageNotice] : []),
  ]);
  const checked = playable > 0 ? urlOutcome(v) : undefined;
  let outcome: StreamOutcome =
    playable > 0
      ? "content"
      : notice && notice.placeholder !== "no-content"
        ? "placeholder"
        : links > 0
          ? "links"
          : notice
            ? "placeholder"
            : "empty";
  let summary =
    total === 0
      ? "no streams"
      : `${playable} playable${links > 0 ? `, ${plural(links, "link")}` : ""} of ${total}`;
  if (checked) {
    outcome = checked.outcome;
    summary = checked.summary;
    playable = 0;
    notice = undefined;
  }
  const reason = checked
    ? checked.reason
    : outcome === "links"
      ? "only links, no playable stream"
      : outcome === "placeholder"
        ? noticeReason(notice!)
        : outcome === "empty"
          ? total === 0
            ? "returned no streams"
            : `none of ${total} streams has a playable source`
          : undefined;
  return {
    target: f.target,
    path: f.path,
    outcome,
    total,
    playable,
    links,
    notice,
    summary,
    details: [...rows(reason), ...verificationRows(v)],
    answeredInMs,
  };
}

/**
 * What a target's checked URLs make of its playable streams, when none of them plays.
 * Web pages alone are an informational addon's links (Stremio Stinger); beside a dead URL they are as unplayable.
 */
function urlOutcome(
  v: Verification | undefined,
): { outcome: "dead" | "links"; summary: string; reason: string } | undefined {
  const urls = v?.urls;
  if (!urls?.length || urls.some((u) => u.verdict === "playable")) return undefined;
  const each = urls.map((u) => `${u.host} ${u.outcome}`).join("; ");
  const dead = urls.filter((u) => u.verdict === "dead").length;
  const pages = urls.filter((u) => u.verdict === "webpage").length;
  if (dead + pages === urls.length) {
    if (dead === 0) {
      return {
        outcome: "links",
        summary: `${pages} of ${urls.length} URLs web pages`,
        reason: `stream URLs open web pages, not media: ${each}`,
      };
    }
    return {
      outcome: "dead",
      summary: pages === 0 ? `${dead} of ${urls.length} URLs dead` : "no URL plays",
      reason: `no checked stream URL plays: ${each}`,
    };
  }
  // A template answers for any ID, so only a URL that plays shows this title is real.
  if (v?.templated?.urls) {
    return {
      outcome: "dead",
      summary: "templated, no URL plays",
      reason: `the addon answers a nonexistent ID too, and no checked stream URL plays: ${each}`,
    };
  }
  return undefined;
}

/** A linked page that says it needs configuration or is broken, read as the notice it is. */
function linkPageNotice(page: LinkPage | undefined): Placeholder | undefined {
  if (!page?.placeholder || page.placeholder === "no-content") return undefined;
  return {
    kind: "placeholder",
    placeholder: page.placeholder,
    fingerprint: "",
    label: page.label ?? page.host,
    linkPage: true,
  };
}

function verificationRows(v: Verification | undefined): DetailRow[] {
  if (!v) return [];
  const { urls, templated, linkPage } = v;
  return [
    ...(urls?.length ? [{ label: "URL check", value: describeUrlChecks(urls) }] : []),
    ...(templated
      ? [
          {
            label: "Note",
            value: `templated: the nonexistent ${templated.id} gets ${plural(templated.urls + templated.links, "stream")} too`,
          },
        ]
      : []),
    ...(linkPage
      ? [
          {
            label: "Link check",
            value: [
              linkPage.host,
              linkPage.status !== undefined ? `HTTP ${linkPage.status}` : "no answer",
              ...(linkPage.label ? [linkPage.label] : []),
            ].join(" · "),
          },
        ]
      : []),
  ];
}

function noticeReason(notice: Placeholder): string {
  if (notice.repeated) {
    return notice.label
      ? `same stream for unrelated titles: ${notice.label}`
      : "same stream for unrelated titles";
  }
  return `addon says: ${notice.label}`;
}

/**
 * Judge every answer, comparing them so a stream recurring for unrelated titles can't pass as content.
 * An addon pinned as answering the same streams for every title by design skips that comparison.
 */
function judgeStreamFetches(
  fetches: StreamFetch[],
  configurable: boolean,
  sameForEveryTitle: boolean,
): StreamCheckResult[] {
  const byTestId = new Map<string, StreamClass[]>();
  for (const f of fetches) {
    if (f.status !== undefined && isOkStatus(f.status) && !f.parseError && !byTestId.has(f.id)) {
      byTestId.set(f.id, f.streams);
    }
  }
  const repeated = sameForEveryTitle
    ? new Set<string>()
    : repeatedFingerprints([...byTestId.values()]);
  return fetches.map((f) => judgeStreamFetch(f, repeated, configurable));
}

/**
 * Whether an answer already says how the addon fares, so trying another title would add nothing: content, links, or a notice about the addon itself.
 * A notice for one of the addon's own titles may concern that title alone (a premium film, an event not yet live), so it doesn't settle anything.
 */
function settles(check: StreamCheckResult): boolean {
  if (check.outcome === "content" || check.outcome === "links") return true;
  const ownTitle = check.target.origin === "own" || check.target.origin === "remembered";
  return check.outcome === "placeholder" && check.notice?.placeholder !== "no-content" && !ownTitle;
}

type StreamVerdict =
  { kind: "content" | "links" | "down" } | { kind: "needs-config" | "error"; reason: string };

/**
 * Any target with real content passes; an addon answering only real links is a link/info addon and passes too, unless its playable streams proved dead.
 * Otherwise its notices decide: an error notice is DOWN with the notice as the reason, a plea to configure is needs-config.
 */
function streamVerdict(checks: StreamCheckResult[]): StreamVerdict {
  if (checks.some((c) => c.outcome === "content")) return { kind: "content" };
  // Streams meant to play that can't outweigh links that only open a browser.
  if (checks.some((c) => c.outcome === "dead")) return { kind: "down" };
  // A templated link's page shows what any title gets, though a popular one may be cached.
  const page = strongestPlaceholder(checks.flatMap((c) => (c.notice?.linkPage ? c.notice : [])));
  if (page?.placeholder === "needs-config" || page?.placeholder === "error") {
    return { kind: page.placeholder, reason: page.label };
  }
  if (checks.some((c) => c.outcome === "links")) return { kind: "links" };
  const notice = strongestPlaceholder(checks.flatMap((c) => c.notice ?? []));
  if (notice?.placeholder === "error") return { kind: "error", reason: notice.label };
  if (notice?.placeholder === "needs-config") return { kind: "needs-config", reason: notice.label };
  return { kind: "down" };
}

const STREAM_PROBE_TYPES = ["movie", "series"] as const;
type TargetedStreamProbeType = (typeof STREAM_PROBE_TYPES)[number];

function advertisedStreamProbeTypes(types: readonly string[]): TargetedStreamProbeType[] {
  return STREAM_PROBE_TYPES.filter((type) => types.includes(type));
}

function isTargetedStreamProbeType(type: string): type is TargetedStreamProbeType {
  return (STREAM_PROBE_TYPES as readonly string[]).includes(type);
}

/**
 * A catalog addon whose stream resource is optional or empty by design (debrid-only, a stub) answers no streams at all, without error, even for its own titles.
 * Only for IMDb titles, which the user's other addons stream: an addon with its own ID space is the only one that can stream its titles, so answering nothing means it is broken.
 * Notices don't qualify either: an addon answering "no data" for every title has a stream resource that is its point.
 */
function isAuxiliaryStream(checks: StreamCheckResult[], walks: CatalogWalk[]): boolean {
  return (
    checks.some((c) => c.target.origin === "own") &&
    checks.every(
      (c) => c.outcome === "empty" && c.total === 0 && /^tt\d+/.test(c.target.streamId),
    ) &&
    walks.some((w) => w.content) &&
    walks.every((w) => w.ok)
  );
}

type SkipReason = "no-episode" | "out-of-scope";

/** The stream checks of one probed type: an advertised movie or series type, or the addon's other stream types together. */
interface TypeProbe {
  /** Unset for the probe of the addon's other stream types. */
  type?: TargetedStreamProbeType;
  fetches: StreamFetch[];
  /** Candidates dropped before a request, and why. */
  notes: DetailRow[];
  skips: Set<SkipReason>;
  catalogAttempts: CatalogAttempt[];
  /** Types of the addon's own titles (curated or cataloged) that reached a stream request. */
  ownTypes: Set<string>;
  examined: number;
  settled: boolean;
  /** Targets whose stream URLs proved dead. */
  dead: number;
  /** Not borrowed for, because the addon's own catalogs show other types only. */
  notCataloged: boolean;
}

function typeProbe(type?: TargetedStreamProbeType): TypeProbe {
  return {
    type,
    fetches: [],
    notes: [],
    skips: new Set(),
    catalogAttempts: [],
    ownTypes: new Set(),
    examined: 0,
    settled: false,
    dead: 0,
    notCataloged: false,
  };
}

/**
 * The last own-catalog title that had content, per addon and probed type.
 * It stands in when the catalog fails this cycle, so an outage of the catalog alone doesn't send the probe to borrowed titles the addon never carried.
 */
const rememberedTargets = new Map<string, Candidate>();

export function forgetRememberedTargets(): void {
  rememberedTargets.clear();
}

type CatalogFetcher = (plan: CatalogPlan, path: string) => Promise<CatalogAttempt>;

/** What every step of one addon's probe shares: its resources, and the catalog and meta answers already fetched. */
interface ProbeContext {
  uuid: string;
  base: string;
  log: Logger;
  streamRes: NormResource;
  metaRes?: NormResource;
  configurable: boolean;
  sameStreamsForEveryTitle: boolean;
  catalog: CatalogFetcher;
  meta(type: string, id: string): Promise<MetaFetch>;
  borrowed(): Promise<TestContent[]>;
  /** Stream IDs already requested, so the same title isn't asked for twice. */
  requested: Set<string>;
  unanswered: number;
  /** Set once a stream request timed out on any route: retrying later ones would mostly double the wait on an addon that hangs. */
  streamTimedOut: boolean;
  /** Asked at most once per probe, of the first target that needs it. */
  negativeControl(f: StreamFetch): Promise<Templated | undefined>;
}

/** Fetch each key once, sharing the pending answer with every later caller. */
function once<A extends unknown[], T>(
  key: (...args: A) => string,
  fetch: (...args: A) => Promise<T>,
): (...args: A) => Promise<T> {
  const cache = new Map<string, Promise<T>>();
  return (...args) => {
    const k = key(...args);
    let pending = cache.get(k);
    if (!pending) {
      pending = fetch(...args);
      cache.set(k, pending);
    }
    return pending;
  };
}

function metaPath(type: string, id: string): string {
  return `/meta/${encodeId(type)}/${encodeId(id)}.json`;
}

async function fetchMeta(
  base: string,
  type: string,
  id: string,
  options: GetJsonOptions<MetaResponse>,
): Promise<MetaFetch> {
  const path = metaPath(type, id);
  try {
    const answer = await getJson<MetaResponse>(base + path, config.timeouts.meta, options);
    return { path, answer, attempts: answer.attempts };
  } catch (e) {
    return { path, failure: describeRequestError(e), attempts: attemptsOf(e) };
  }
}

type Resolution = { target: StreamTarget } | { skip: SkipReason; note: string };

/**
 * The ID Stremio would request streams with for a candidate, decided by the meta that describes it.
 * The addon's own meta counts only when its meta resource claims the title; an IMDb series falls back to Cinemeta's, as in Stremio.
 * The result must still be in the stream resource's scope: a meta may hand its episodes to other addons' IDs.
 */
async function streamTargetOf(ctx: ProbeContext, c: Candidate): Promise<Resolution> {
  let streamId = c.episodeId;
  if (!streamId) {
    const meta =
      ctx.metaRes && resourceAccepts(ctx.metaRes, c.type, c.id)
        ? validMeta(await ctx.meta(c.type, c.id))
        : undefined;
    if (meta) streamId = streamIdForMeta(playableMeta(meta, c.id));
    else if (c.type === "series" && IMDB_ID.test(c.id)) streamId = await cinemetaEpisode(c.id);
    else if (c.type === "series") return { skip: "no-episode", note: `${c.id}: no episode ID` };
    else streamId = c.id;
  }
  if (!resourceAccepts(ctx.streamRes, c.type, streamId)) {
    return { skip: "out-of-scope", note: `${streamId}: outside the stream resource's scope` };
  }
  return { target: { ...c, streamId } };
}

async function fetchStream(ctx: ProbeContext, target: StreamTarget): Promise<StreamFetch> {
  const id = target.streamId;
  const path = `/stream/${encodeId(target.type)}/${encodeId(id)}.json`;
  const request = { target, id, path, testId: describeTestId(id, target.source) };
  try {
    const answer = await getJson<StreamResponse>(
      ctx.base + path,
      config.timeouts.stream,
      deciding((data) => hasPlayableStream(data, ctx.base), !ctx.streamTimedOut),
    );
    const { status, data, parseError, attempts } = answer;
    const raw = Array.isArray(data?.streams) ? data!.streams! : [];
    const streams = raw.map((st) => classifyStream(st, { baseUrl: ctx.base }));
    const unparsed = isOkStatus(status) ? parseError : undefined;
    return { ...request, status, attempts, streams, parseError: unparsed, answer };
  } catch (e) {
    return {
      ...request,
      attempts: attemptsOf(e),
      streams: [],
      failure: describeRequestError(e),
    };
  }
}

const NO_REPEATS = new Set<string>();

/** Request streams for an ID shaped like the target's that no title has, and keep what the answer shares with a real one. */
async function askNegativeControl(
  ctx: Pick<ProbeContext, "base" | "streamRes" | "log">,
  f: StreamFetch,
): Promise<Templated | undefined> {
  const id = negativeControlId(f.target.streamId, effectivePrefixes(ctx.streamRes));
  const path = `/stream/${encodeId(f.target.type)}/${encodeId(id)}.json`;
  try {
    const { status, data } = await getJson<StreamResponse>(
      ctx.base + path,
      NEGATIVE_CONTROL_TIMEOUT_MS,
    );
    const raw = isOkStatus(status) && Array.isArray(data?.streams) ? data.streams : [];
    // A nag or donation card the real title got too is a static card, not a template.
    const known = new Set(f.streams.map((c) => c.fingerprint));
    const real = raw.filter((s) => {
      const c = classifyStream(s, { baseUrl: ctx.base });
      return (c.kind === "playable" || c.kind === "link") && !known.has(c.fingerprint);
    });
    const urls = real.filter((s) => typeof (s as { url?: unknown }).url === "string").length;
    const links = real.length - urls;
    ctx.log.debug({ step: "negative-control", id, status, urls, links }, "negative control");
    return real.length > 0 ? { id, urls, links } : undefined;
  } catch (e) {
    ctx.log.debug({ step: "negative-control", id, err: errMsg(e) }, "negative control failed");
    return undefined;
  }
}

/**
 * Check what a target's streams lead to: its first stream URLs, and, when that can't settle it, whether the addon templates its answers.
 * A templating addon's links are opened once, so a page saying "API key required" reads as the notice it is.
 */
async function verifyStreams(
  ctx: ProbeContext,
  f: StreamFetch,
  outcome: "content" | "links",
): Promise<Verification> {
  // Status cards are the same for every title by design, and lead to status pages rather than media.
  if (ctx.sameStreamsForEveryTitle) return {};
  const raw = f.answer?.data?.streams ?? [];
  const playable = raw.filter((_, i) => f.streams[i]?.kind === "playable");
  const toCheck = outcome === "content" ? urlsToCheck(playable, ctx.base) : [];
  const urls = await Promise.all(toCheck.map((u) => checkUrl(u)));
  const settledByUrls =
    urls.length === 0 ||
    urls.some((u) => u.verdict === "playable") ||
    !urls.some((u) => u.verdict === "unverifiable");
  const templated =
    outcome === "content" && settledByUrls ? undefined : await ctx.negativeControl(f);
  const link =
    outcome === "links" && templated?.links
      ? raw.find((s, i) => f.streams[i]?.kind === "link" && isWebLink(s))
      : undefined;
  const linkUrl = (link as { externalUrl?: string } | undefined)?.externalUrl;
  const linkPage =
    linkUrl && !isProtectedUrl(linkUrl, ctx.base) ? await followLink(linkUrl) : undefined;
  ctx.log.debug(
    {
      step: "verify",
      id: f.id,
      urls: urls.map((u) => `${u.host} ${u.verdict}`),
      templated: templated !== undefined,
      linkPage: linkPage?.placeholder,
    },
    "stream verification",
  );
  return {
    ...(urls.length > 0 ? { urls } : {}),
    ...(templated ? { templated } : {}),
    ...(linkPage ? { linkPage } : {}),
  };
}

function isWebLink(s: unknown): boolean {
  const link = (s as { externalUrl?: unknown } | null)?.externalUrl;
  return typeof link === "string" && /^https?:\/\//i.test(link);
}

/** Request streams for candidates in order until one settles how the addon fares, within the type's request budget. */
async function tryCandidates(
  ctx: ProbeContext,
  p: TypeProbe,
  candidates: AsyncIterable<Candidate>,
): Promise<void> {
  const exhausted = () =>
    p.settled ||
    p.fetches.length >= MAX_STREAM_REQUESTS_PER_TYPE ||
    ctx.unanswered >= MAX_UNANSWERED_STREAM_REQUESTS;
  if (exhausted()) return;
  for await (const c of candidates) {
    if (exhausted()) return;
    if (!ctx.streamRes.types.includes(c.type)) continue;
    if (c.origin === "own" && ++p.examined > MAX_ITEMS_PER_TYPE) return;
    const resolved = await streamTargetOf(ctx, c);
    if ("skip" in resolved) {
      p.skips.add(resolved.skip);
      p.notes.push({ label: "Skipped", value: resolved.note });
      continue;
    }
    const { target } = resolved;
    const key = `${target.type}/${target.streamId}`;
    if (ctx.requested.has(key)) continue;
    ctx.requested.add(key);
    if (c.origin !== "borrowed") p.ownTypes.add(target.type);
    const f = await fetchStream(ctx, target);
    p.fetches.push(f);
    if (f.status === undefined) ctx.unanswered++;
    if (f.attempts.some((a) => a.timedOut)) ctx.streamTimedOut = true;
    let check = judgeStreamFetch(f, NO_REPEATS, ctx.configurable);
    if (check.outcome === "content" || check.outcome === "links") {
      f.verification = await verifyStreams(ctx, f, check.outcome);
      check = judgeStreamFetch(f, NO_REPEATS, ctx.configurable);
    }
    ctx.log.debug(
      {
        step: "stream",
        outcome: check.outcome,
        type: target.type,
        id: target.streamId,
        source: target.source,
      },
      `stream check ${check.outcome}: ${target.type} ${check.summary}`,
    );
    if (settles(check)) {
      p.settled = true;
      if (check.outcome === "content" && c.origin === "own") {
        rememberedTargets.set(`${ctx.uuid}/${p.type ?? ""}`, { ...c, origin: "remembered" });
      }
    } else if (check.outcome === "dead" && ++p.dead >= DEAD_TARGETS_PER_TYPE) {
      p.settled = true;
    }
    if (exhausted()) return;
  }
}

async function* sequence<T>(...sources: Array<Iterable<T> | AsyncIterable<T>>): AsyncGenerator<T> {
  for (const source of sources) yield* source;
}

/**
 * Real titles from the first few catalogs that have any, fetching each catalog only once the previous one's titles are used up.
 * A catalog holding only a plea to configure or an error notice speaks for the whole addon, so the walk ends there; donation and news tiles don't.
 */
async function* catalogItems(
  fetch: CatalogFetcher,
  plans: CatalogPlan[],
  attempts: CatalogAttempt[],
  accepts: (type: string) => boolean = () => true,
): AsyncGenerator<Candidate> {
  for (const plan of plans.slice(0, MAX_CATALOGS_PER_TYPE)) {
    let attempt: CatalogAttempt | undefined;
    for (const path of plan.paths) {
      attempt = await fetch(plan, path);
      attempts.push(attempt);
      if (attempt.kind !== "empty") break;
    }
    if (attempt?.notice && attempt.notice.placeholder !== "no-content") return;
    yield* (attempt?.items ?? []).filter((item) => accepts(item.type)).slice(0, ITEMS_PER_CATALOG);
  }
}

/** Each catalog a user browses that the probe hasn't fetched yet, within the coverage budget, with every request made for it. */
async function coverCatalogs(
  fetch: CatalogFetcher,
  plans: CatalogPlan[],
  fetched: CatalogAttempt[],
): Promise<CatalogAttempt[]> {
  const browsable = plans.filter((p) => !p.search);
  const keys = new Set(browsable.map((p) => `${p.catalog.type}/${p.catalog.id}`));
  const covered = fetched.filter((a) => keys.has(`${a.catalog.type}/${a.catalog.id}`));
  const picks = coveragePicks(
    browsable,
    (p) => p.catalog,
    covered.map((a) => a.catalog),
  );
  const fresh = await mapLimit(picks, TYPES_IN_FLIGHT, async (plan) => {
    const made: CatalogAttempt[] = [];
    for (const path of plan.paths) {
      const attempt = await fetch(plan, path);
      made.push(attempt);
      if (attempt.kind !== "empty") break;
    }
    return made;
  });
  return [...covered, ...fresh.flat()];
}

/** The first addon catalog's answer: it passes when it lists an addon Stremio could install. */
async function checkAddonCatalog(
  base: string,
  catalog: ManifestCatalog,
  decides: boolean,
): Promise<{ result: PerResourceResult; answer?: ContentAnswer; deciding?: Timing }> {
  const path = `/addon_catalog/${encodeId(catalog.type)}/${encodeId(catalog.id)}.json`;
  try {
    const answer = await getJson<unknown>(
      base + path,
      config.timeouts.catalog,
      decides ? deciding(hasInstallableAddon) : {},
    );
    const { status, parseError, attempts } = answer;
    const unparsed = isOkStatus(status) ? parseError : undefined;
    const judged = !isOkStatus(status)
      ? { ok: false, ...describeStatus(answer) }
      : unparsed
        ? { ok: false, ...describeParseError(unparsed) }
        : judgeAddonCatalog(answer.data);
    return {
      answer,
      result: {
        resource: "addon_catalog",
        ok: judged.ok,
        summary: judged.summary,
        details: requestRows(path, attempts, {
          reason: judged.reason,
          parseError: unparsed,
          note: softBlockNote(answer),
        }),
      },
      ...(judged.ok ? { deciding: { path, ms: answerTime(answer) } } : {}),
    };
  } catch (e) {
    const { summary, reason } = describeRequestError(e);
    return {
      result: {
        resource: "addon_catalog",
        ok: false,
        summary,
        details: requestRows(path, attemptsOf(e), { reason }),
      },
    };
  }
}

/** A check's row in the stream condition: its deciding request in full, and every other ID tried for the same type in one row each. */
interface StreamRow {
  label: string;
  summary: string;
  details: DetailRow[];
  /** The request that passed the type. */
  deciding?: Timing;
}

function typeProbeRow(p: TypeProbe, checkOf: Map<StreamFetch, StreamCheckResult>): StreamRow {
  const checks = p.fetches.map((f) => checkOf.get(f)!);
  const best = checks.reduce((a, b) => (OUTCOME_RANK[b.outcome] > OUTCOME_RANK[a.outcome] ? b : a));
  const others = checks.filter((c) => c !== best);
  const passed = best.outcome === "content" || best.outcome === "links";
  return {
    label: best.target.type,
    summary: others.length > 0 && !passed ? `${best.summary} (${checks.length} IDs)` : best.summary,
    details: [
      ...best.details,
      ...others.map((c) => alsoTriedRow(describeTestId(c.path, c.target.source), c.summary)),
      ...p.notes,
    ],
    ...(passed ? { deciding: { path: best.path, ms: best.answeredInMs ?? 0 } } : {}),
  };
}

function missingTypeRow(p: TypeProbe): StreamRow {
  const reason = p.notCataloged
    ? "not in own catalogs"
    : p.skips.has("no-episode")
      ? "no episode ID"
      : p.skips.has("out-of-scope")
        ? "no ID in stream scope"
        : "no test ID source";
  const why = p.notCataloged ? `the addon's own catalogs list other types only` : reason;
  return {
    label: p.type!,
    summary: reason,
    details: [{ label: "Skipped", value: `${p.type}: ${why}` }, ...p.notes],
  };
}

function scopeText(res: NormResource): string {
  const prefixes = effectivePrefixes(res);
  return `${res.types.join(", ") || "no types"} · ${prefixes.length > 0 ? prefixes.join(", ") : "any ID"}`;
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function result(
  success: boolean,
  message: string,
  start: number,
  detail: ProbeResult["detail"],
  error?: string,
): ProbeResult {
  return { success, durationMs: Date.now() - start, message, error, detail };
}

/** Two-tier probe: liveness floor (manifest) + content depth (resources). */
export async function probe(addon: NormalizedAddon): Promise<ProbeResult> {
  const start = Date.now();
  const perResource: PerResourceResult[] = [];
  // Child logger scoped to this addon; every step below traces on it so the path to the verdict is reconstructable.
  const log = logger.child({ addon: addon.slug });
  const override = overrideFor(addon.uuid);
  const base = probeBaseUrl(addon);
  log.debug({ step: "start", baseUrl: addon.baseUrl }, "probe start");

  // Step 1: Liveness floor.
  const manifestPath = "/manifest.json";
  const manifestDown = (livenessError: string, message: string, rows: DetailRow[]): ProbeResult =>
    result(
      false,
      message,
      start,
      { live: false, livenessError, manifestDetails: rows, mode: "content", perResource },
      "manifest",
    );
  const failed = (verdict: string, reason: string, attempts: Attempt[], parseError?: ParseError) =>
    manifestDown(
      verdict,
      `manifest ${verdict}`,
      requestRows(manifestPath, attempts, { reason, parseError }),
    );
  const unreachable = (reason: string, attempts: Attempt[], parseError?: ParseError) =>
    failed(`unreachable (${reason})`, reason, attempts, parseError);
  let live: Manifest;
  let manifestDetails: DetailRow[];
  let manifestAttempts: Attempt[];
  try {
    const answer = await getJson<unknown>(base + manifestPath, config.timeouts.manifest, {
      retry: true,
      headers: STREMIO_WEB_HEADERS,
    });
    const { status, data, parseError, attempts } = answer;
    if (!isOkStatus(status)) {
      log.debug({ step: "manifest", status }, "manifest unreachable → DOWN");
      const { summary, reason } = describeStatus(answer);
      return failed(`unreachable (${summary})`, reason, attempts);
    }
    if (parseError) {
      const { reason } = describeParseError(parseError);
      log.debug({ step: "manifest", status, reason }, "manifest did not parse → DOWN");
      return unreachable(reason, attempts, parseError);
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      log.debug({ step: "manifest", status }, "manifest not a JSON object → DOWN");
      return unreachable("response is not a JSON object", attempts);
    }
    const missing = missingManifestFields(data);
    if (missing.length > 0) {
      const verdict = `not a Stremio manifest (missing ${missing.join(", ")})`;
      log.debug({ step: "manifest", status, missing }, "manifest shape invalid → DOWN");
      return manifestDown(
        verdict,
        verdict,
        requestRows(manifestPath, attempts, { reason: `response lacks ${missing.join(", ")}` }),
      );
    }
    live = data as Manifest;
    manifestAttempts = attempts;
    const cors = corsAnnotation(manifestPath, answer.allowOrigin);
    if (cors) perResource.push(cors);
    manifestDetails = requestRows(manifestPath, attempts);
    if (override?.testConfig) {
      manifestDetails.push({ label: "Note", value: "probed with a public test config" });
    }
  } catch (e) {
    log.debug({ step: "manifest", err: errMsg(e) }, "manifest fetch threw → DOWN");
    const { summary, reason } = describeRequestError(e);
    return summary === "timed out"
      ? failed(summary, reason, attemptsOf(e))
      : unreachable(reason, attemptsOf(e));
  }

  const norm = normalizeResources(live);
  const catalogs = Array.isArray(live.catalogs) ? live.catalogs : [];
  log.debug(
    { step: "manifest", resources: norm.map((r) => r.name), catalogs: catalogs.length },
    "manifest reachable (liveness floor passed)",
  );

  const livenessOnly = (reason: string): ProbeResult => {
    log.debug({ step: "verdict", mode: "liveness-only", reason }, `liveness-only UP: ${reason}`);
    return result(true, `manifest reachable · content not deep-checked (${reason})`, start, {
      live: true,
      manifestDetails,
      mode: "liveness-only",
      skipReason: reason,
      perResource,
    });
  };

  const needsConfiguration = (reason: string): ProbeResult => {
    log.debug({ step: "verdict", mode: "needs-config", reason }, `needs configuration: ${reason}`);
    return result(true, `manifest reachable · needs configuration (${reason})`, start, {
      live: true,
      manifestDetails,
      mode: "needs-config",
      configReason: reason,
      perResource,
    });
  };

  // Step 2: Discovery / early needs-config.
  if (override?.needsConfig) return needsConfiguration(override.needsConfig);
  const declared = override?.testConfig
    ? undefined
    : declaredConfigRequirement(live, addon.baseUrl);
  if (declared) return needsConfiguration(declared);

  const streamRes = norm.find((r) => r.name === "stream");
  const metaRes = norm.find((r) => r.name === "meta");
  const subtitlesRes = norm.find((r) => r.name === "subtitles");
  const addonCatalogs = Array.isArray(live.addonCatalogs)
    ? live.addonCatalogs.filter((c) => typeof c?.type === "string" && typeof c.id === "string")
    : [];
  // Stremio reads catalogs from `manifest.catalogs` alone, whether or not `resources` lists `catalog`.
  const plans = catalogPlans(catalogs);

  // Primary content resource: stream > catalog > meta > addon_catalog > subtitles.
  let primary: "stream" | "catalog" | "meta" | "addon_catalog" | "subtitles" | null = streamRes
    ? "stream"
    : catalogs.length > 0
      ? "catalog"
      : metaRes
        ? "meta"
        : addonCatalogs.length > 0
          ? "addon_catalog"
          : subtitlesRes
            ? "subtitles"
            : null;

  if (!primary) return livenessOnly("no testable resource");
  log.debug({ step: "discovery", primary, catalogs: plans.length }, `primary resource: ${primary}`);

  const curated: Candidate[] = (override?.testIds ?? []).map((t) => ({
    ...t,
    source: "curated",
    origin: "curated",
  }));
  const streamPrefixes = streamRes ? effectivePrefixes(streamRes) : [];
  // No external source can supply IDs in the addon's own ID space, so a failing catalog leaves nothing a user could play either.
  const ownCatalogsOnly =
    curated.length === 0 && streamPrefixes.length > 0 && !hasSourceFor(streamPrefixes);
  const metaOptions = primary === "meta" ? deciding(hasValidMeta) : {};
  const metaOnce = once(metaPath, (type: string, id: string) =>
    fetchMeta(base, type, id, metaOptions),
  );
  const catalogOptions = !streamRes || ownCatalogsOnly ? deciding(hasRealMeta) : {};
  const catalogOnce: CatalogFetcher = once(
    (_plan: CatalogPlan, path: string) => path,
    (plan, path) => fetchCatalog(base, plan.catalog, path, catalogOptions),
  );

  // Step 3: Source test IDs and check the primary resource with them.
  let attempts: CatalogAttempt[] = [];
  let walks: CatalogWalk[] = [];
  const tried: StreamTarget[] = [];
  let streamOutcome: StreamVerdict | undefined;
  let streamCounts: ProbeResult["detail"]["streamCounts"];
  let streamAnswers: Array<ContentAnswer | undefined> = [];
  let metaAnswer: ContentAnswer | undefined;
  let streamDeciding: Timing[] = [];
  let metaDeciding: Timing[] = [];
  let subtitleAnswers: Array<ContentAnswer | undefined> = [];
  let subtitleDeciding: Timing[] = [];

  if (streamRes) {
    const advertised = advertisedStreamProbeTypes(streamRes.types);
    const otherStreamTypes = streamRes.types.filter((t) => !isTargetedStreamProbeType(t));
    let borrowed: Promise<TestContent[]> | undefined;
    let negative: Promise<Templated | undefined> | undefined;
    const ctx: ProbeContext = {
      uuid: addon.uuid,
      base,
      log,
      streamRes,
      metaRes,
      configurable: live.behaviorHints?.configurable === true,
      sameStreamsForEveryTitle: override?.sameStreamsForEveryTitle !== undefined,
      catalog: catalogOnce,
      meta: metaOnce,
      borrowed: () =>
        (borrowed ??= candidatesFor(streamRes).catch((e: unknown) => {
          log.debug({ step: "testid", err: errMsg(e) }, "ID source lookup failed");
          return [];
        })),
      requested: new Set(),
      unanswered: 0,
      streamTimedOut: false,
      negativeControl: (f) => (negative ??= askNegativeControl(ctx, f)),
    };

    const declares = (type: string) => plans.some((plan) => sameType(plan.catalog.type, type));
    const streamTypesCataloged = streamRes.types.some(declares);
    /**
     * Titles from the catalogs typed as one of `types`, whatever type each title has.
     * When no catalog is typed as any stream type (`porn` catalogs holding `movie` titles), every catalog is searched for titles of `types` themselves.
     */
    const ownTitles = (types: readonly string[], attempts: CatalogAttempt[]) => {
      const typed = plans.filter((plan) => types.some((t) => sameType(plan.catalog.type, t)));
      if (typed.length > 0) return catalogItems(catalogOnce, typed, attempts);
      if (streamTypesCataloged) return sequence<Candidate>();
      return catalogItems(catalogOnce, plans, attempts, (type) => types.includes(type));
    };
    const remembered = (p: TypeProbe) =>
      (async function* (): AsyncGenerator<Candidate> {
        if (ownCatalogsOnly || p.ownTypes.size > 0) return;
        const c = rememberedTargets.get(`${addon.uuid}/${p.type ?? ""}`);
        if (c) yield { ...c, source: "own catalog, earlier cycle" };
      })();
    const borrowedOf = (accepts: (c: TestContent) => boolean) =>
      (async function* (): AsyncGenerator<Candidate> {
        for (const c of await ctx.borrowed()) {
          if (accepts(c)) yield { ...c, origin: "borrowed" as const };
        }
      })();

    // The addon's own titles first, one probe per advertised movie/series type.
    const targeted = advertised.map((type) => typeProbe(type));
    await mapLimit(targeted, TYPES_IN_FLIGHT, (p) =>
      tryCandidates(
        ctx,
        p,
        sequence(
          curated.filter((c) => c.type === p.type),
          ownTitles([p.type!], p.catalogAttempts),
        ),
      ),
    );

    // Then borrowed titles, and the addon's other stream types when its movie/series side has no titles of its own.
    const ownTypes = new Set(targeted.flatMap((p) => [...p.ownTypes]));
    const ownTargeted = [...ownTypes].some(isTargetedStreamProbeType);
    const others = ownTargeted ? undefined : typeProbe();
    const borrowFor = (p: TypeProbe) => {
      // Catalogs listing only series show a movie it advertises isn't what it carries (or the other way round).
      if (!declares(p.type!) && !ownTypes.has(p.type!) && ownTargeted) {
        p.notCataloged = true;
        return sequence<Candidate>();
      }
      return sequence(
        remembered(p),
        borrowedOf((c) => c.type === p.type),
      );
    };
    const pending = [
      ...targeted.filter((p) => !p.settled && p.fetches.length < MAX_STREAM_REQUESTS_PER_TYPE),
      ...(others ? [others] : []),
    ];
    await mapLimit(pending, TYPES_IN_FLIGHT, (p) =>
      tryCandidates(
        ctx,
        p,
        p.type
          ? borrowFor(p)
          : sequence(
              curated.filter((c) => otherStreamTypes.includes(c.type)),
              ownTitles(otherStreamTypes, p.catalogAttempts),
              remembered(p),
              borrowedOf((c) => !isTargetedStreamProbeType(c.type)),
            ),
      ),
    );

    const probes = [...targeted, ...(others ? [others] : [])];
    attempts = uniqueBy(
      probes.flatMap((p) => p.catalogAttempts),
      (a) => a.path,
    );
    // A catalog request shared by several probes shows once, under the first probe that made it.
    const shown = new Set<string>();
    walks = probes.flatMap((p) => {
      const own = p.catalogAttempts.filter((a) => !shown.has(a.path));
      own.forEach((a) => shown.add(a.path));
      return own.length > 0 ? [judgeCatalogWalk(own)] : [];
    });
    if (walks.length > 0) {
      const labelled = walks.length > 1 || targeted.some((p) => p.catalogAttempts.length > 0);
      perResource.push({
        resource: "catalog",
        ok: walks.every((w) => w.ok),
        summary: walks.map((w) => (labelled ? `${w.label} ${w.summary}` : w.summary)).join(" · "),
        details: walks.flatMap((w) => w.details),
      });
    }

    const fetches = probes.flatMap((p) => p.fetches);
    log.debug(
      {
        step: "testid",
        tried: fetches.map((f) => `${f.target.type}:${f.id} (${f.target.source ?? "?"})`),
      },
      fetches.length > 0 ? "stream test IDs tried" : "no stream test ID",
    );

    // Every catalog item was a notice and nothing else supplied a test ID: the notice is the addon's answer.
    const catalogNotice = strongestPlaceholder(attempts.flatMap((a) => a.notice ?? []));
    const anyItem = attempts.some((a) => a.kind === "items");
    if (catalogNotice && fetches.length === 0 && !anyItem) {
      if (catalogNotice.placeholder === "needs-config")
        return needsConfiguration(catalogNotice.label);
      if (catalogNotice.placeholder === "error") {
        log.debug(
          { step: "verdict", mode: "content", notice: catalogNotice.label },
          "content DOWN: catalog holds only an error notice",
        );
        return result(
          false,
          `manifest up · catalog: ${perResource.find((r) => r.resource === "catalog")?.summary}`,
          start,
          { live: true, manifestDetails, mode: "content", primary: "catalog", perResource },
          "catalog",
        );
      }
    }

    if (fetches.length === 0) {
      const catalogsFailed =
        attempts.length > 0 && attempts.every((a) => a.kind === "failed" || a.kind === "empty");
      if (!(ownCatalogsOnly && catalogsFailed)) {
        const skips = new Set(probes.flatMap((p) => [...p.skips]));
        return livenessOnly(
          skips.has("no-episode")
            ? "no episode ID for the addon's titles"
            : skips.has("out-of-scope")
              ? "no test ID in the stream resource's scope"
              : "no test ID source for stream prefixes",
        );
      }
      // The addon's own catalogs are its only ID source, and they are what a user browses: their failure is the addon's.
      primary = "catalog";
      perResource
        .find((r) => r.resource === "catalog")!
        .details.push({
          label: "Note",
          value: "the addon's own catalogs are its only source of stream test IDs",
        });
      log.debug({ step: "catalog" }, "own catalogs, the only ID source, all failed");
    } else {
      const checks = judgeStreamFetches(fetches, ctx.configurable, ctx.sameStreamsForEveryTitle);
      const checkOf = new Map(fetches.map((f, i) => [f, checks[i]]));
      streamAnswers = fetches.map((f) => f.answer);
      tried.push(
        ...[...checks]
          .sort((a, b) => OUTCOME_RANK[b.outcome] - OUTCOME_RANK[a.outcome])
          .map((c) => c.target),
      );
      const checkedTypes = new Set(checks.map((c) => c.target.type));
      const targetedMode = targeted.some((p) => p.fetches.length > 0);
      const rows = probes.flatMap((p): StreamRow[] => {
        if (p.fetches.length > 0) return [typeProbeRow(p, checkOf)];
        if (p.type && targetedMode && !checkedTypes.has(p.type)) return [missingTypeRow(p)];
        return [];
      });

      streamCounts = {
        total: checks.reduce((sum, check) => sum + check.total, 0),
        playable: checks.reduce((sum, check) => sum + check.playable, 0),
        links: checks.reduce((sum, check) => sum + check.links, 0),
      };
      streamOutcome = streamVerdict(checks);
      // Catalogs announcing the addon needs configuration explain why borrowed titles got nothing either.
      if (
        streamOutcome.kind === "down" &&
        catalogNotice &&
        catalogNotice.placeholder !== "no-content"
      ) {
        streamOutcome = { kind: catalogNotice.placeholder, reason: catalogNotice.label };
      }
      const streamDetails = rows.flatMap((row) => row.details);
      streamDeciding = rows.flatMap((row) => row.deciding ?? []);
      const templatedLinks = fetches.some(
        (f, i) => checks[i].outcome === "links" && f.verification?.templated?.links,
      );
      if (streamOutcome.kind === "links") {
        streamDetails.push({
          label: "Note",
          value: templatedLinks
            ? "link addon: templated links (not content-checked)"
            : "link addon: links only, not content-checked",
        });
      }
      // A catalog addon whose stream resource answers nothing for its own titles is judged on its catalogs.
      if (streamOutcome.kind === "down" && isAuxiliaryStream(checks, walks)) {
        primary = "catalog";
        streamDetails.push({
          label: "Note",
          value: "no streams for the addon's own catalog titles; judged on its catalogs",
        });
      }
      perResource.push({
        resource: "stream",
        ok: streamOutcome.kind === "content" || streamOutcome.kind === "links",
        summary:
          rows.map((row) => `${row.label} ${row.summary}`).join(" · ") +
          (streamOutcome.kind === "links" && templatedLinks ? " · templated links" : ""),
        details: streamDetails,
      });
    }
  } else if (plans.length > 0) {
    const walk: CatalogAttempt[] = [];
    for await (const item of catalogItems(catalogOnce, plans, walk)) {
      log.debug(
        { step: "testid", source: "catalog", type: item.type, id: item.id },
        "catalog item",
      );
      break;
    }
    attempts = walk;
    const w = judgeCatalogWalk(walk);
    walks = [w];
    perResource.push({
      resource: "catalog",
      ok: w.ok,
      summary: w.summary,
      details: w.details,
    });
    const catalogNotice = strongestPlaceholder(walk.flatMap((a) => a.notice ?? []));
    if (catalogNotice && !w.content && curated.length === 0) {
      if (catalogNotice.placeholder === "needs-config")
        return needsConfiguration(catalogNotice.label);
      if (catalogNotice.placeholder === "error") {
        return result(
          false,
          `manifest up · catalog: ${w.summary}`,
          start,
          { live: true, manifestDetails, mode: "content", primary: "catalog", perResource },
          "catalog",
        );
      }
    }
  } else if (primary === "subtitles") {
    const check = await checkSubtitles(
      base,
      subtitleTargets(subtitlesRes!, override?.testIds ?? [], log),
      {
        maxTitles: MAX_SUBTITLE_TITLES,
        sniff: true,
        retry: true,
        log,
      },
    );
    if (check) {
      perResource.push(check.result);
      subtitleAnswers = check.answers;
      subtitleDeciding = check.deciding ? [check.deciding] : [];
      if (check.verdict.kind === "needs-config") return needsConfiguration(check.verdict.reason);
    }
  }

  const ownItems = attempts.flatMap((a) => a.items);

  // meta resource: only for titles it claims; a borrowed IMDb ID is Cinemeta's to describe.
  if (metaRes) {
    const pool = uniqueBy(
      [
        ...tried.filter((t) => !(t.origin === "borrowed" && IMDB_ID.test(t.id))),
        ...ownItems,
        ...curated,
      ],
      (c) => `${c.type}/${c.id}`,
    );
    const test = pool.find((c) => resourceAccepts(metaRes, c.type, c.id));
    if (test) {
      const f = await metaOnce(test.type, test.id);
      const testId = describeTestId(test.id, test.source);
      if (f.answer) {
        const answer = f.answer;
        metaAnswer = answer;
        const { status, data, parseError, attempts: routes } = answer;
        const unparsed = isOkStatus(status) ? parseError : undefined;
        const defect = !isOkStatus(status)
          ? describeStatus(answer)
          : unparsed
            ? describeParseError(unparsed)
            : metaBodyDefect(data);
        const meta = validMeta(f);
        const flaws = defect || !meta ? [] : metaFlaws(meta, test.type, test.id);
        // A flawed meta Stremio can still show is a problem worth naming, never one that decides the verdict.
        const ok = !defect && (flaws.length === 0 || primary === "meta");
        const flawed = flaws.map((x) => x.summary).join(", ");
        perResource.push({
          resource: "meta",
          ok,
          summary: defect
            ? defect.summary
            : flaws.length === 0
              ? "valid"
              : ok
                ? `valid · ${flawed}`
                : flawed,
          details: [
            ...requestRows(f.path, routes, {
              testId,
              reason: defect?.reason,
              parseError: unparsed,
              note: softBlockNote(answer),
            }),
            ...flaws.map((x) => ({ label: "Reason", value: x.reason })),
          ],
        });
        metaDeciding = [{ path: f.path, ms: answerTime(answer) }];
        log.debug(
          { step: "meta", ok, status, type: test.type, id: test.id },
          `meta check ${ok ? "ok" : "fail"}`,
        );
      } else {
        const { summary, reason } = f.failure ?? { summary: "unreachable", reason: undefined };
        perResource.push({
          resource: "meta",
          ok: false,
          summary,
          details: requestRows(f.path, f.attempts, { testId, reason }),
        });
        log.debug({ step: "meta", ok: false, err: reason }, "meta fetch threw");
      }
    } else if (pool.length > 0 && primary !== "meta") {
      perResource.push({
        resource: "meta",
        ok: true,
        summary: "no test ID in scope",
        details: [
          {
            label: "Skipped",
            value: `no test ID in the meta resource's scope (${scopeText(metaRes)})`,
          },
        ],
      });
      log.debug({ step: "meta" }, "skipped meta check: no test ID in its scope");
    }
  }

  let addonCatalogAnswer: ContentAnswer | undefined;
  let addonCatalogDeciding: Timing[] = [];
  if (addonCatalogs.length > 0) {
    const checked = await checkAddonCatalog(base, addonCatalogs[0], primary === "addon_catalog");
    perResource.push(checked.result);
    addonCatalogAnswer = checked.answer;
    addonCatalogDeciding = checked.deciding ? [checked.deciding] : [];
    log.debug({ step: "addon_catalog", ok: checked.result.ok }, "addon catalog check");
  }

  // Secondary resources: shape-only, annotate, never flip DOWN.
  if (subtitlesRes && primary !== "subtitles") {
    const pool = [
      ...tried.map((t) => ({ type: t.type, id: t.streamId, source: t.source })),
      ...ownItems,
      ...curated,
    ];
    const test = pool.find((c) => resourceAccepts(subtitlesRes, c.type, c.id));
    if (test) {
      const check = await checkSubtitles(
        base,
        [{ type: test.type, id: test.id, source: test.source }],
        { maxTitles: 1, sniff: false, retry: false, log },
      );
      if (check) perResource.push(check.result);
    }
  }

  if (streamOutcome?.kind === "needs-config") return needsConfiguration(streamOutcome.reason);

  const coverage = catalogCoverage(await coverCatalogs(catalogOnce, plans, attempts));
  if (coverage) {
    const after = perResource.findIndex((r) => r.resource === "catalog") + 1;
    perResource.splice(after > 0 ? after : perResource.length, 0, coverage);
  }

  // Step 5: Verdict from the primary resource.
  const primaryResult = perResource.find((r) => r.resource === primary);
  if (primaryResult?.ok) {
    markSlow(
      primaryResult,
      primary === "stream"
        ? streamDeciding
        : primary === "catalog"
          ? walks.flatMap((w) => w.deciding ?? [])
          : primary === "meta"
            ? metaDeciding
            : primary === "subtitles"
              ? subtitleDeciding
              : addonCatalogDeciding,
    );
  }
  const okResources = perResource.filter((r) => r.ok);
  const message =
    okResources.length > 0
      ? okResources.map((r) => `${r.resource}: ${r.summary}`).join(" · ")
      : "manifest reachable";

  if (primaryResult?.ok) {
    log.debug(
      { step: "verdict", mode: "content", primary, streamCounts },
      `content UP: primary resource ${primary} passed`,
    );
    return result(true, message, start, {
      live: true,
      manifestDetails,
      mode: "content",
      primary,
      perResource,
      streamCounts,
    });
  }

  if (!primaryResult) {
    // Nothing could be asked of the primary resource, which says nothing about whether it works.
    return livenessOnly(
      primary === "catalog" ? "no testable catalog" : `no test ID for ${primary}`,
    );
  }

  const primaryAnswers =
    primary === "stream"
      ? streamAnswers
      : primary === "catalog"
        ? attempts.map((a) => a.answer)
        : primary === "meta"
          ? [metaAnswer]
          : primary === "subtitles"
            ? subtitleAnswers
            : [addonCatalogAnswer];
  const unconfigured = await unconfiguredReason(live, primaryAnswers, manifestAttempts, base);
  if (unconfigured) return needsConfiguration(unconfigured);

  // Manifest up but primary content failed.
  // The log message carries the full per-resource breakdown, not just the primary, so a DOWN is explainable from the logs alone.
  const breakdown = perResource.map((r) => `${r.resource}: ${r.summary}`).join(" · ");
  const downMsg = `manifest up · ${breakdown}`;
  log.debug(
    { step: "verdict", mode: "content", primary, streamCounts },
    `content DOWN: primary resource ${primary} failed`,
  );
  return result(
    false,
    downMsg,
    start,
    {
      live: true,
      manifestDetails,
      mode: "content",
      primary,
      perResource,
      streamCounts,
    },
    primary,
  );
}
