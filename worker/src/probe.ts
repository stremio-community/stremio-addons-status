import type { Manifest, ManifestCatalog, MetaDetail, MetaPreview } from "@stremio-addon/sdk";
import { mapLimit } from "./concurrency.js";
import { config } from "./config.js";
import { streamIdForMeta, type PlayableMeta } from "./episodes.js";
import {
  attemptsOf,
  describeParseError,
  getJson,
  type Attempt,
  type JsonResult,
  type ParseError,
} from "./http.js";
import { encodeId, errMsg } from "./utils.js";
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
import { unconfiguredReason, type ContentAnswer } from "./unconfigured.js";
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

const META_REQUIRED_FIELDS = ["id", "type", "name"] as const;

function missingMetaFields(m: unknown): string[] {
  const o = m as Record<string, unknown> | undefined;
  return META_REQUIRED_FIELDS.filter((f) => typeof o?.[f] !== "string");
}

function isOkStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function describeTestId(id: string, source: string | undefined): string {
  return source ? `${id} (${source})` : id;
}

function attemptRows(a: Attempt): DetailRow[] {
  const outcome = a.status !== undefined ? `HTTP ${a.status}` : (a.error ?? "failed");
  return [
    { label: "Attempt", value: `${a.route} · ${outcome} · ${a.durationMs}ms` },
    ...(a.redirect ? [{ label: "Redirect", value: a.redirect }] : []),
  ];
}

/**
 * Rows describing one request: what was asked for, over which routes, and why it failed (only when it did).
 * A `parseError` supplies the reason unless one is given, and adds what the body looked like.
 */
function requestRows(
  path: string,
  attempts: Attempt[],
  {
    testId,
    reason,
    parseError,
  }: { testId?: string; reason?: string; parseError?: ParseError } = {},
): DetailRow[] {
  const parsed = parseError ? describeParseError(parseError) : undefined;
  const why = reason ?? parsed?.reason;
  return [
    { label: "Request", value: path },
    ...(testId ? [{ label: "Test ID", value: testId }] : []),
    ...attempts.flatMap(attemptRows),
    ...(why ? [{ label: "Reason", value: why }] : []),
    ...(parsed?.details ?? []),
  ];
}

/** A request summarized in one row, for the requests a check made besides the one its full rows describe. */
function alsoTriedRow(request: string, summary: string): DetailRow {
  return { label: "Also tried", value: `${request} · ${summary}` };
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
}

/** A catalog the worker can query, with the requests to try in order: each later one runs only when the previous came back empty. */
interface CatalogPlan {
  catalog: ManifestCatalog;
  paths: string[];
  /** Catalogs needing no user input come first. */
  rank: number;
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
): Promise<CatalogAttempt> {
  const attempt = { type: catalog.type, path, items: [] as Candidate[] };
  try {
    const answer = await getJson<CatalogResponse>(base + path, config.timeouts.catalog);
    const { status, data, parseError, attempts } = answer;
    if (!isOkStatus(status)) {
      return {
        ...attempt,
        answer,
        kind: "failed",
        ok: false,
        summary: `HTTP ${status}`,
        details: requestRows(path, attempts, { reason: `addon responded with HTTP ${status}` }),
      };
    }
    if (parseError) {
      return {
        ...attempt,
        answer,
        kind: "failed",
        ok: false,
        summary: describeParseError(parseError).summary,
        details: requestRows(path, attempts, { parseError }),
      };
    }
    const metas = Array.isArray(data?.metas) ? data.metas : [];
    const valid = metas.filter((m) => missingMetaFields(m).length === 0);
    if (valid.length === 0) {
      const reason =
        metas.length === 0
          ? "returned no metas"
          : `none of ${metas.length} metas has an id, type and name`;
      return {
        ...attempt,
        answer,
        kind: "empty",
        ok: false,
        summary: "empty",
        details: requestRows(path, attempts, { reason }),
      };
    }
    const real = valid.filter((m) => placeholderMeta(m) === undefined);
    if (real.length === 0) {
      const notice = strongestPlaceholder(valid.map((m) => placeholderMeta(m)!))!;
      return {
        ...attempt,
        answer,
        kind: "notices",
        // A catalog of donation or news tiles still answers; it only has nothing to test with.
        ok: notice.placeholder === "no-content",
        summary: "only notices",
        notice,
        details: requestRows(path, attempts, { reason: `addon says: ${notice.label}` }),
      };
    }
    return {
      ...attempt,
      answer,
      kind: "items",
      ok: true,
      summary: `${metas.length} metas`,
      details: requestRows(path, attempts),
      items: real.map((m) => ({
        type: m.type || catalog.type,
        id: m.id,
        source: "own catalog",
        origin: "own" as const,
      })),
    };
  } catch (e) {
    return {
      ...attempt,
      kind: "failed",
      ok: false,
      summary: "unreachable",
      details: requestRows(path, attemptsOf(e), { reason: errMsg(e) }),
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
}

function judgeCatalogWalk(attempts: CatalogAttempt[], type?: string): CatalogWalk {
  const found = attempts.find((a) => a.kind === "items");
  const shown = found ?? attempts[0];
  const others = attempts.filter((a) => a !== shown);
  const details = [...shown.details, ...others.map((a) => alsoTriedRow(a.path, a.summary))];
  if (found) {
    return { ok: true, content: true, label: type ?? found.type, summary: found.summary, details };
  }
  const summaries = [...new Set(attempts.map((a) => a.summary))].join(", ");
  return {
    ok: attempts.every((a) => a.ok),
    content: false,
    label: type ?? shown.type,
    summary: attempts.length === 1 ? shown.summary : `${summaries} (${attempts.length} tries)`,
    details,
  };
}

interface MetaFetch {
  path: string;
  /** Unset when the request threw. */
  answer?: JsonResult<MetaResponse>;
  error?: string;
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

/** The parts of an untrusted meta answer that decide its stream ID, keeping only well-formed values. */
function playableMeta(meta: Record<string, unknown>, id: string): PlayableMeta {
  const hints = meta.behaviorHints as { defaultVideoId?: unknown } | null | undefined;
  const videos = Array.isArray(meta.videos)
    ? meta.videos.filter(
        (v): v is { id: string; season?: number; episode?: number } =>
          typeof (v as { id?: unknown } | null)?.id === "string",
      )
    : undefined;
  return {
    id: typeof meta.id === "string" && meta.id !== "" ? meta.id : id,
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
  error?: string;
  parseError?: ParseError;
  /** Unset when the request threw. */
  answer?: ContentAnswer;
}

type Placeholder = Extract<StreamClass, { kind: "placeholder" }> & { repeated?: boolean };

/**
 * `content`: at least one real playable stream.
 * `links`: no playable stream, but real links (externalUrl, trailers).
 * `placeholder`: notices only, or links beside a notice saying the addon is broken or unconfigured, which are its request forms and configure links.
 * `empty`: nothing usable; `failed`: no 2xx answer.
 */
type StreamOutcome = "content" | "links" | "placeholder" | "empty" | "failed";

const OUTCOME_RANK: Record<StreamOutcome, number> = {
  content: 4,
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

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function judgeStreamFetch(
  f: StreamFetch,
  repeated: Set<string>,
  configurable: boolean,
): StreamCheckResult {
  const rows = (reason?: string) =>
    requestRows(f.path, f.attempts, { testId: f.testId, reason, parseError: f.parseError });
  const failed = {
    target: f.target,
    path: f.path,
    outcome: "failed" as const,
    total: 0,
    playable: 0,
    links: 0,
  };
  if (f.status === undefined) {
    return { ...failed, summary: "unreachable", details: rows(f.error) };
  }
  if (!isOkStatus(f.status)) {
    return {
      ...failed,
      summary: `HTTP ${f.status}`,
      details: rows(`addon responded with HTTP ${f.status}`),
    };
  }
  if (f.parseError) {
    return { ...failed, summary: describeParseError(f.parseError).summary, details: rows() };
  }
  const streams = f.streams.map((c) => judgedStream(c, repeated, configurable));
  const total = streams.length;
  const playable = streams.filter((c) => c.kind === "playable").length;
  const links = streams.filter((c) => c.kind === "link").length;
  const notice = strongestPlaceholder(
    streams.filter((c): c is Placeholder => c.kind === "placeholder"),
  );
  const outcome: StreamOutcome =
    playable > 0
      ? "content"
      : notice && notice.placeholder !== "no-content"
        ? "placeholder"
        : links > 0
          ? "links"
          : notice
            ? "placeholder"
            : "empty";
  const reason =
    outcome === "links"
      ? "only links, no playable stream"
      : outcome === "placeholder"
        ? noticeReason(notice!)
        : outcome === "empty"
          ? total === 0
            ? "returned no streams"
            : `none of ${total} streams has a playable source`
          : undefined;
  const summary =
    total === 0
      ? "no streams"
      : `${playable} playable${links > 0 ? `, ${plural(links, "link")}` : ""} of ${total}`;
  return {
    target: f.target,
    path: f.path,
    outcome,
    total,
    playable,
    links,
    notice,
    summary,
    details: rows(reason),
  };
}

function noticeReason(notice: Placeholder): string {
  if (notice.repeated) {
    return notice.label
      ? `same stream for unrelated titles: ${notice.label}`
      : "same stream for unrelated titles";
  }
  return `addon says: ${notice.label}`;
}

/** Judge every answer, comparing them so a stream recurring for unrelated titles can't pass as content. */
function judgeStreamFetches(fetches: StreamFetch[], configurable: boolean): StreamCheckResult[] {
  const byTestId = new Map<string, StreamClass[]>();
  for (const f of fetches) {
    if (f.status !== undefined && isOkStatus(f.status) && !f.parseError && !byTestId.has(f.id)) {
      byTestId.set(f.id, f.streams);
    }
  }
  const repeated = repeatedFingerprints([...byTestId.values()]);
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
 * Any target with real content passes; an addon answering only real links is a link/info addon and passes too.
 * Otherwise its notices decide: an error notice is DOWN with the notice as the reason, a plea to configure is needs-config.
 */
function streamVerdict(checks: StreamCheckResult[]): StreamVerdict {
  if (checks.some((c) => c.outcome === "content")) return { kind: "content" };
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
  catalog: CatalogFetcher;
  meta(type: string, id: string): Promise<MetaFetch>;
  borrowed(): Promise<TestContent[]>;
  /** Stream IDs already requested, so the same title isn't asked for twice. */
  requested: Set<string>;
  unanswered: number;
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

async function fetchMeta(base: string, type: string, id: string): Promise<MetaFetch> {
  const path = metaPath(type, id);
  try {
    const answer = await getJson<MetaResponse>(base + path, config.timeouts.meta);
    return { path, answer, attempts: answer.attempts };
  } catch (e) {
    return { path, error: errMsg(e), attempts: attemptsOf(e) };
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
    const answer = await getJson<StreamResponse>(ctx.base + path, config.timeouts.stream);
    const { status, data, parseError, attempts } = answer;
    const raw = Array.isArray(data?.streams) ? data!.streams! : [];
    const streams = raw.map((st) => classifyStream(st, { baseUrl: ctx.base }));
    const unparsed = isOkStatus(status) ? parseError : undefined;
    return { ...request, status, attempts, streams, parseError: unparsed, answer };
  } catch (e) {
    return { ...request, attempts: attemptsOf(e), streams: [], error: errMsg(e) };
  }
}

const NO_REPEATS = new Set<string>();

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
    const check = judgeStreamFetch(f, NO_REPEATS, ctx.configurable);
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
): AsyncGenerator<Candidate> {
  for (const plan of plans.slice(0, MAX_CATALOGS_PER_TYPE)) {
    let attempt: CatalogAttempt | undefined;
    for (const path of plan.paths) {
      attempt = await fetch(plan, path);
      attempts.push(attempt);
      if (attempt.kind !== "empty") break;
    }
    if (attempt?.notice && attempt.notice.placeholder !== "no-content") return;
    yield* attempt?.items.slice(0, ITEMS_PER_CATALOG) ?? [];
  }
}

/** A check's row in the stream condition: its deciding request in full, and every other ID tried for the same type in one row each. */
interface StreamRow {
  label: string;
  summary: string;
  details: DetailRow[];
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
  const unreachable = (reason: string, attempts: Attempt[], parseError?: ParseError) =>
    manifestDown(
      `unreachable (${reason})`,
      `manifest unreachable (${reason})`,
      requestRows(manifestPath, attempts, { reason, parseError }),
    );
  let live: Manifest;
  let manifestDetails: DetailRow[];
  let manifestAttempts: Attempt[];
  try {
    const { status, data, parseError, attempts } = await getJson<unknown>(
      base + manifestPath,
      config.timeouts.manifest,
    );
    if (!isOkStatus(status)) {
      log.debug({ step: "manifest", status }, "manifest unreachable → DOWN");
      return unreachable(`HTTP ${status}`, attempts);
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
    manifestDetails = requestRows(manifestPath, attempts);
    if (override?.testConfig) {
      manifestDetails.push({ label: "Note", value: "probed with a public test config" });
    }
  } catch (e) {
    log.debug({ step: "manifest", err: errMsg(e) }, "manifest fetch threw → DOWN");
    return unreachable(errMsg(e), attemptsOf(e));
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
  // Stremio reads catalogs from `manifest.catalogs` alone, whether or not `resources` lists `catalog`.
  const plans = catalogPlans(catalogs);

  // Primary content resource: stream > catalog > meta.
  let primary: "stream" | "catalog" | "meta" | null = streamRes
    ? "stream"
    : catalogs.length > 0
      ? "catalog"
      : metaRes
        ? "meta"
        : null;

  if (!primary) return livenessOnly("no testable resource");
  log.debug({ step: "discovery", primary, catalogs: plans.length }, `primary resource: ${primary}`);

  const curated: Candidate[] = (override?.testIds ?? []).map((t) => ({
    ...t,
    source: "curated",
    origin: "curated",
  }));
  const metaOnce = once(metaPath, (type: string, id: string) => fetchMeta(base, type, id));
  const catalogOnce: CatalogFetcher = once(
    (_plan: CatalogPlan, path: string) => path,
    (plan, path) => fetchCatalog(base, plan.catalog, path),
  );

  // Step 3: Source test IDs and check the primary resource with them.
  let attempts: CatalogAttempt[] = [];
  let walks: CatalogWalk[] = [];
  const tried: StreamTarget[] = [];
  let streamOutcome: StreamVerdict | undefined;
  let streamCounts: ProbeResult["detail"]["streamCounts"];
  let streamAnswers: Array<ContentAnswer | undefined> = [];
  let metaAnswer: ContentAnswer | undefined;

  if (streamRes) {
    const advertised = advertisedStreamProbeTypes(streamRes.types);
    const otherStreamTypes = streamRes.types.filter((t) => !isTargetedStreamProbeType(t));
    const prefixes = effectivePrefixes(streamRes);
    // No external source can supply IDs in the addon's own ID space, so a failing catalog leaves nothing a user could play either.
    const ownCatalogsOnly = curated.length === 0 && prefixes.length > 0 && !hasSourceFor(prefixes);
    let borrowed: Promise<TestContent[]> | undefined;
    const ctx: ProbeContext = {
      uuid: addon.uuid,
      base,
      log,
      streamRes,
      metaRes,
      configurable: live.behaviorHints?.configurable === true,
      catalog: catalogOnce,
      meta: metaOnce,
      borrowed: () =>
        (borrowed ??= candidatesFor(streamRes).catch((e: unknown) => {
          log.debug({ step: "testid", err: errMsg(e) }, "ID source lookup failed");
          return [];
        })),
      requested: new Set(),
      unanswered: 0,
    };

    const declares = (type: string) => plans.some((plan) => sameType(plan.catalog.type, type));
    const streamTypesCataloged = streamRes.types.some(declares);
    // Catalogs typed outside every stream type (`porn` holding `movie` titles) may still hold titles of a stream type.
    const plansFor = (types: readonly string[]) => {
      const typed = plans.filter((plan) => types.some((t) => sameType(plan.catalog.type, t)));
      return typed.length > 0 || streamTypesCataloged ? typed : plans;
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
          catalogItems(catalogOnce, plansFor([p.type!]), p.catalogAttempts),
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
              catalogItems(
                catalogOnce,
                otherStreamTypes.some(declares)
                  ? plansFor(otherStreamTypes)
                  : streamTypesCataloged
                    ? []
                    : plans,
                p.catalogAttempts,
              ),
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
    const walked = probes.filter((p) => p.catalogAttempts.length > 0);
    walks = walked.map((p) => judgeCatalogWalk(p.catalogAttempts, p.type));
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
      const checks = judgeStreamFetches(fetches, ctx.configurable);
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
      if (streamOutcome.kind === "links") {
        streamDetails.push({ label: "Note", value: "link addon: links only, not content-checked" });
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
        summary: rows.map((row) => `${row.label} ${row.summary}`).join(" · "),
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
        const missing = missingMetaFields(data?.meta);
        const reason = !isOkStatus(status)
          ? `addon responded with HTTP ${status}`
          : unparsed
            ? describeParseError(unparsed).reason
            : !data?.meta
              ? "response has no meta object"
              : missing.length > 0
                ? `meta missing ${missing.join(", ")}`
                : undefined;
        const ok = reason === undefined;
        perResource.push({
          resource: "meta",
          ok,
          summary: ok
            ? "valid"
            : !isOkStatus(status)
              ? `HTTP ${status}`
              : unparsed
                ? describeParseError(unparsed).summary
                : "invalid",
          details: requestRows(f.path, routes, { testId, reason, parseError: unparsed }),
        });
        log.debug(
          { step: "meta", ok, status, type: test.type, id: test.id },
          `meta check ${ok ? "ok" : "fail"}`,
        );
      } else {
        perResource.push({
          resource: "meta",
          ok: false,
          summary: "unreachable",
          details: requestRows(f.path, f.attempts, { testId, reason: f.error }),
        });
        log.debug({ step: "meta", ok: false, err: f.error }, "meta fetch threw");
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

  // Secondary resources: shape-only, annotate, never flip DOWN.
  if (subtitlesRes) {
    const pool = [
      ...tried.map((t) => ({ type: t.type, id: t.streamId, source: t.source })),
      ...ownItems,
      ...curated,
    ];
    const test = pool.find((c) => resourceAccepts(subtitlesRes, c.type, c.id));
    if (test) {
      const path = `/subtitles/${encodeId(test.type)}/${encodeId(test.id)}.json`;
      try {
        const {
          data,
          parseError,
          attempts: routes,
        } = await getJson<{ subtitles?: unknown[] }>(base + path, config.timeouts.meta);
        const ok = Array.isArray(data?.subtitles);
        perResource.push({
          resource: "subtitles",
          ok,
          summary: ok
            ? `${data!.subtitles!.length} found`
            : parseError
              ? describeParseError(parseError).summary
              : "invalid",
          details: requestRows(path, routes, {
            testId: describeTestId(test.id, test.source),
            reason: ok || parseError ? undefined : "response has no subtitles array",
            parseError,
          }),
        });
        log.debug({ step: "subtitles", ok }, "subtitles check (annotation only)");
      } catch {
        /* secondary: ignore */
      }
    }
  }

  if (streamOutcome?.kind === "needs-config") return needsConfiguration(streamOutcome.reason);

  // Step 5: Verdict from the primary resource.
  const primaryResult = perResource.find((r) => r.resource === primary);
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
        : [metaAnswer];
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
