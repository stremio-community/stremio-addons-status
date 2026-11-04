import type { Manifest, ManifestCatalog, MetaDetail, MetaPreview } from "@stremio-addon/sdk";
import { config } from "./config.js";
import { attemptsOf, describeParseError, getJson, type Attempt, type ParseError } from "./http.js";
import { encodeId, errMsg } from "./utils.js";
import { hasSourceFor, resolveForPrefixes, type TestContent } from "./idsources.js";
import { logger } from "./logger.js";
import {
  declaredConfigRequirement,
  missingManifestFields,
  normalizeResources,
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
import type {
  DetailRow,
  NormalizedAddon,
  PerResourceResult,
  ProbeResult,
  ProbeMode,
} from "./types.js";

const EPISODIC_TYPES = new Set(["series", "anime", "tv", "channel"]);

/** Pick a servable catalog and the extra path segment needed to query it. */
function pickCatalog(
  catalogs: ManifestCatalog[],
  preferredType?: string,
): { catalog: ManifestCatalog; extraPath: string } | null {
  // Prefer catalogs needing no user input; fall back to ones we can satisfy.
  const pool = preferredType ? catalogs.filter((c) => c.type === preferredType) : catalogs;
  const scored = pool.map((c) => {
    const required = (c.extra ?? []).filter((e) => e.isRequired);
    if (required.length === 0) return { catalog: c, extraPath: "", rank: 0 };
    // Try to satisfy each required extra.
    const parts: string[] = [];
    for (const req of required) {
      if (req.name === "search") parts.push("search=the");
      else if (req.options?.length) parts.push(`${req.name}=${encodeURIComponent(req.options[0])}`);
      else return null; // unknown required input.
    }
    return { catalog: c, extraPath: "/" + parts.join("&"), rank: 1 };
  });
  const usable = scored.filter((s): s is NonNullable<typeof s> => s !== null);
  if (usable.length === 0) return null;
  usable.sort((a, b) => a.rank - b.rank);
  return { catalog: usable[0].catalog, extraPath: usable[0].extraPath };
}

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

async function firstEpisodeId(
  baseUrl: string,
  type: string,
  id: string,
): Promise<string | undefined> {
  try {
    const { status, data } = await getJson<MetaResponse>(
      `${baseUrl}/meta/${type}/${encodeId(id)}.json`,
      config.timeouts.meta,
    );
    if (!isOkStatus(status)) return undefined;
    return data?.meta?.videos?.[0]?.id;
  } catch {
    return undefined;
  }
}

function fallbackEpisodeId(type: string, id: string): string | undefined {
  return type === "series" && /^tt\d+$/.test(id) ? `${id}:1:1` : undefined;
}

interface CatalogProbeResult {
  content?: TestContent;
  ok: boolean;
  summary: string;
  details: DetailRow[];
  /** Set when every item was a notice ("TMDB key required", a donation tile), so the catalog offers nothing to test with. */
  notice?: MetaNotice;
  /** Unset when the request threw. */
  answer?: ContentAnswer;
}

async function fetchCatalogCandidate(
  baseUrl: string,
  catalogs: ManifestCatalog[],
  preferredType?: string,
): Promise<CatalogProbeResult | null> {
  const picked = pickCatalog(catalogs, preferredType);
  if (!picked) return null;

  const path = `/catalog/${picked.catalog.type}/${encodeId(picked.catalog.id)}${picked.extraPath}.json`;
  try {
    const answer = await getJson<CatalogResponse>(baseUrl + path, config.timeouts.catalog);
    const { status, data, parseError, attempts } = answer;
    if (!isOkStatus(status)) {
      return {
        answer,
        ok: false,
        summary: `HTTP ${status}`,
        details: requestRows(path, attempts, { reason: `addon responded with HTTP ${status}` }),
      };
    }
    if (parseError) {
      return {
        answer,
        ok: false,
        summary: describeParseError(parseError).summary,
        details: requestRows(path, attempts, { parseError }),
      };
    }
    const metas = data?.metas ?? [];
    const valid = metas.filter((m) => missingMetaFields(m).length === 0);
    if (valid.length === 0) {
      const reason =
        metas.length === 0
          ? "returned no metas"
          : `none of ${metas.length} metas has an id, type and name`;
      return {
        answer,
        ok: false,
        summary: "empty",
        details: requestRows(path, attempts, { reason }),
      };
    }
    const firstReal = valid.find((m) => placeholderMeta(m) === undefined);
    if (!firstReal) {
      const notice = strongestPlaceholder(valid.map((m) => placeholderMeta(m)!))!;
      return {
        // A catalog of donation or news tiles still answers; it only has nothing to test with.
        ok: notice.placeholder === "no-content",
        summary: "only notices",
        notice,
        details: requestRows(path, attempts, { reason: `addon says: ${notice.label}` }),
      };
    }
    return {
      ok: true,
      summary: `${metas.length} metas`,
      details: requestRows(path, attempts),
      content: {
        type: firstReal.type || picked.catalog.type,
        id: firstReal.id,
        source: "own catalog",
      },
    };
  } catch (e) {
    return {
      ok: false,
      summary: "unreachable",
      details: requestRows(path, attemptsOf(e), { reason: errMsg(e) }),
    };
  }
}

function pickCandidate(candidates: TestContent[], types: string[]): TestContent | null {
  if (candidates.length === 0) return null;
  const match = candidates.find((c) => types.length === 0 || types.includes(c.type));
  return match ?? candidates[0];
}

const STREAM_PROBE_TYPES = ["movie", "series"] as const;
type TargetedStreamProbeType = (typeof STREAM_PROBE_TYPES)[number];

interface StreamProbeTarget extends TestContent {
  probeType: string;
}

/** One stream request as the addon answered it, before it is judged against the other targets. */
interface StreamFetch {
  target: StreamProbeTarget;
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

interface StreamCheckResult {
  target: StreamProbeTarget;
  outcome: StreamOutcome;
  total: number;
  playable: number;
  links: number;
  notice?: Placeholder;
  summary: string;
  details: DetailRow[];
}

/** A row of the stream condition: a check that ran, or a target that couldn't be sourced. */
type StreamRow = Pick<StreamCheckResult, "target" | "summary" | "details">;

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
  const failed = { target: f.target, outcome: "failed" as const, total: 0, playable: 0, links: 0 };
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

/** Judge every target's answer, comparing them so a stream recurring for unrelated titles can't pass as content. */
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

function advertisedStreamProbeTypes(types: readonly string[]): TargetedStreamProbeType[] {
  return STREAM_PROBE_TYPES.filter((type) => types.includes(type));
}

function isTargetedStreamProbeType(type: string): type is TargetedStreamProbeType {
  return (STREAM_PROBE_TYPES as readonly string[]).includes(type);
}

function pickCandidateForType(
  candidates: TestContent[],
  type: TargetedStreamProbeType,
): StreamProbeTarget | null {
  const candidate = candidates.find((c) => c.type === type);
  return candidate ? { ...candidate, probeType: type } : null;
}

/**
 * A catalog addon whose stream resource is optional or empty by design (debrid-only, a stub) answers no streams at all, without error, even for its own titles.
 * Only for IMDb titles, which the user's other addons stream: an addon with its own ID space is the only one that can stream its titles, so answering nothing means it is broken.
 * Notices don't qualify either: an addon answering "no data" for every title has a stream resource that is its point.
 */
function isAuxiliaryStream(
  checks: StreamCheckResult[],
  catalogChecks: CatalogProbeResult[],
): boolean {
  return (
    checks.some((c) => c.target.source === "own catalog") &&
    checks.every(
      (c) =>
        c.outcome === "empty" && c.total === 0 && /^tt\d+/.test(c.target.episodeId ?? c.target.id),
    ) &&
    catalogChecks.some((c) => c.content) &&
    catalogChecks.every((c) => c.ok)
  );
}

function streamSummary(rows: StreamRow[]): string {
  return rows.map((c) => `${c.target.probeType} ${c.summary}`).join(" · ");
}

function missingStreamCheck(probeType: TargetedStreamProbeType, reason: string): StreamRow {
  return {
    target: { probeType, type: probeType, id: "" },
    summary: reason,
    details: [{ label: "Skipped", value: `${probeType}: ${reason}` }],
  };
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
  const catalogs = live.catalogs ?? [];
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
  const declared = override?.testConfig ? undefined : declaredConfigRequirement(live);
  if (declared) return needsConfiguration(declared);

  const streamRes = norm.find((r) => r.name === "stream");
  const metaRes = norm.find((r) => r.name === "meta");
  const catalogTestable = catalogs.length > 0 && norm.some((r) => r.name === "catalog");
  const advertisedStreamTypes = streamRes ? advertisedStreamProbeTypes(streamRes.types) : [];

  // Primary content resource: stream > catalog > meta.
  let primary: "stream" | "catalog" | "meta" | null = streamRes
    ? "stream"
    : catalogTestable
      ? "catalog"
      : metaRes
        ? "meta"
        : null;

  if (!primary) return livenessOnly("no testable resource");
  log.debug({ step: "discovery", primary, catalogTestable }, `primary resource: ${primary}`);

  // Step 3: Source a real, servable test ID.
  let test: TestContent | null = null;
  const streamTargets: StreamProbeTarget[] = [];
  const catalogChecks: CatalogProbeResult[] = [];

  const curated: TestContent[] = (override?.testIds ?? []).map((t) => ({
    ...t,
    source: "curated",
  }));
  if (curated.length > 0) {
    if (streamRes) {
      for (const probeType of advertisedStreamTypes) {
        const target = pickCandidateForType(curated, probeType);
        if (target) streamTargets.push(target);
      }
      if (streamTargets.length === 0) {
        const target = pickCandidate(curated, streamRes.types);
        if (target) streamTargets.push({ ...target, probeType: target.type });
      }
    }
    test = streamTargets[0] ?? curated[0];
    log.debug(
      { step: "testid", source: "curated", targets: streamTargets.map((t) => `${t.type}:${t.id}`) },
      "using curated test IDs",
    );
  }

  if (catalogTestable) {
    if (streamRes) {
      const uncoveredTypes = advertisedStreamTypes.filter(
        (probeType) => !streamTargets.some((target) => target.probeType === probeType),
      );
      if (uncoveredTypes.length > 0) {
        const results = await Promise.all(
          uncoveredTypes.map(async (probeType) => ({
            probeType,
            found: await fetchCatalogCandidate(base, catalogs, probeType),
          })),
        );
        for (const { probeType, found } of results) {
          if (!found) continue;
          catalogChecks.push({ ...found, summary: `${probeType} ${found.summary}` });
          if (found.ok && found.content) {
            streamTargets.push({ ...found.content, probeType });
          } else {
            log.debug(
              { step: "catalog", type: probeType, summary: found.summary },
              "catalog failed",
            );
          }
        }
      }
      if (streamTargets.length === 0) {
        // A mixed-type addon may only catalog a non-movie/series type its stream resource serves.
        const fallbackCatalogs =
          advertisedStreamTypes.length > 0
            ? catalogs.filter(
                (c) => streamRes.types.includes(c.type) && !isTargetedStreamProbeType(c.type),
              )
            : catalogs;
        const found = await fetchCatalogCandidate(base, fallbackCatalogs);
        if (found) {
          catalogChecks.push(found);
          if (found.ok && found.content) {
            streamTargets.push({ ...found.content, probeType: found.content.type });
          } else {
            log.debug({ step: "catalog", summary: found.summary }, "catalog failed");
          }
        }
      }
      if (catalogChecks.length > 0) {
        perResource.push({
          resource: "catalog",
          ok: catalogChecks.every((check) => check.ok),
          summary: catalogChecks.map((check) => check.summary).join(" · "),
          details: catalogChecks.flatMap((check) => check.details),
        });
      }
      test = streamTargets[0] ?? null;
      if (streamTargets.length > 0) {
        log.debug(
          {
            step: "testid",
            source: "catalog",
            targets: streamTargets.map((t) => `${t.probeType}:${t.type}:${t.id}`),
          },
          "sourced stream test IDs from own catalog",
        );
      }
    } else {
      const found = await fetchCatalogCandidate(base, catalogs);
      if (found) {
        catalogChecks.push(found);
        perResource.push({
          resource: "catalog",
          ok: found.ok,
          summary: found.summary,
          details: found.details,
        });
        test ??= found.content ?? null;
        if (found.content) {
          log.debug(
            {
              step: "testid",
              source: "catalog",
              type: found.content.type,
              id: found.content.id,
            },
            "sourced test ID from own catalog",
          );
        } else {
          log.debug({ step: "catalog", summary: found.summary }, "catalog failed");
        }
      }
    }
  }

  // Catalog-less scraper: borrow IDs from an external metadata addon.
  const missingStreamProbeTypes = advertisedStreamTypes.filter(
    (probeType) => !streamTargets.some((target) => target.probeType === probeType),
  );
  const needsBorrowedStreamTarget =
    streamTargets.length === 0 ||
    (missingStreamProbeTypes.length > 0 &&
      streamTargets.every((target) => isTargetedStreamProbeType(target.probeType)));

  if (streamRes && needsBorrowedStreamTarget) {
    if (streamRes.idPrefixes.length && hasSourceFor(streamRes.idPrefixes)) {
      const candidates = await resolveForPrefixes(streamRes.idPrefixes);
      if (advertisedStreamTypes.length > 0) {
        for (const probeType of missingStreamProbeTypes) {
          const target = pickCandidateForType(candidates, probeType);
          if (target) streamTargets.push(target);
        }
        if (streamTargets.length === 0) {
          const target = pickCandidate(candidates, streamRes.types);
          if (target) streamTargets.push({ ...target, probeType: target.type });
        }
      } else {
        const target = pickCandidate(candidates, streamRes.types);
        if (target) streamTargets.push({ ...target, probeType: target.type });
      }
      test = streamTargets[0] ?? null;
      log.debug(
        {
          step: "testid",
          source: "borrowed",
          prefixes: streamRes.idPrefixes,
          targets: streamTargets.map((t) => `${t.probeType}:${t.type}:${t.id}`),
        },
        streamTargets.length > 0
          ? "borrowed stream test ID from external source"
          : "no candidate from external source",
      );
    } else {
      log.debug(
        { step: "testid", source: "none", prefixes: streamRes.idPrefixes },
        "no ID source for stream prefixes",
      );
    }
  }

  // Every catalog item was a notice and nothing else supplied a test ID: the notice is the addon's answer.
  const catalogNotice = strongestPlaceholder(catalogChecks.flatMap((c) => c.notice ?? []));
  if (catalogNotice && !test && streamTargets.length === 0) {
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

  // For episodic content, a stream query needs an episode id.
  const ensureEpisodeId = async (target: TestContent & { probeType?: string }): Promise<void> => {
    if (target.episodeId || !EPISODIC_TYPES.has(target.type)) return;
    const resolvedEpisodeId = metaRes
      ? await firstEpisodeId(base, target.type, target.id)
      : undefined;
    const fallback = resolvedEpisodeId ?? fallbackEpisodeId(target.type, target.id);
    target.episodeId = fallback;
    log.debug(
      {
        step: "testid",
        probeType: target.probeType,
        type: target.type,
        id: target.id,
        episodeId: target.episodeId,
      },
      resolvedEpisodeId
        ? "resolved episode ID for episodic content"
        : fallback
          ? "using default S1E1 episode ID for episodic content"
          : "no episode ID resolved for episodic content",
    );
  };
  for (const target of streamTargets) await ensureEpisodeId(target);
  if (test && !streamTargets.some((target) => target === test)) await ensureEpisodeId(test);

  // Step 4: Validate resources.
  let streamCounts: ProbeResult["detail"]["streamCounts"];
  let streamOutcome: StreamVerdict | undefined;
  let streamAnswers: Array<ContentAnswer | undefined> = [];
  let metaAnswer: ContentAnswer | undefined;

  if (streamRes) {
    const targetedStreamMode =
      advertisedStreamTypes.length > 0 &&
      streamTargets.some((target) =>
        advertisedStreamTypes.some((probeType) => probeType === target.probeType),
      );
    const resolvableTargets = targetedStreamMode
      ? streamTargets.filter((target) => !EPISODIC_TYPES.has(target.type) || target.episodeId)
      : streamTargets.slice(0, 1);
    const missingAdvertisedTargets = targetedStreamMode
      ? advertisedStreamTypes
          .filter(
            (probeType) => !resolvableTargets.some((target) => target.probeType === probeType),
          )
          .map((probeType) => {
            const sourced = streamTargets.some((target) => target.probeType === probeType);
            return missingStreamCheck(probeType, sourced ? "no episode ID" : "no test ID source");
          })
      : [];
    if (resolvableTargets.length === 0) {
      // No own catalog and no ID source for its prefixes.
      return livenessOnly("no test ID source for stream prefixes");
    }

    const streamFetches = await Promise.all(
      resolvableTargets.map(async (target): Promise<StreamFetch> => {
        const type = target.type;
        const id = target.episodeId ?? target.id;
        const path = `/stream/${type}/${encodeId(id)}.json`;
        const request = { target, id, path, testId: describeTestId(id, target.source) };
        try {
          const answer = await getJson<StreamResponse>(base + path, config.timeouts.stream);
          const { status, data, parseError, attempts } = answer;
          const raw = Array.isArray(data?.streams) ? data!.streams! : [];
          const streams = raw.map((st) => classifyStream(st, { baseUrl: base }));
          const unparsed = isOkStatus(status) ? parseError : undefined;
          return { ...request, status, attempts, streams, parseError: unparsed, answer };
        } catch (e) {
          return { ...request, attempts: attemptsOf(e), streams: [], error: errMsg(e) };
        }
      }),
    );
    streamAnswers = streamFetches.map((f) => f.answer);
    const streamChecks = judgeStreamFetches(
      streamFetches,
      live.behaviorHints?.configurable === true,
    );
    for (const check of streamChecks) {
      log.debug(
        {
          step: "stream",
          outcome: check.outcome,
          playable: check.playable,
          links: check.links,
          total: check.total,
          probeType: check.target.probeType,
          type: check.target.type,
          id: check.target.episodeId ?? check.target.id,
        },
        `stream check ${check.outcome}: ${check.target.probeType} ${check.summary}`,
      );
    }

    streamCounts = {
      total: streamChecks.reduce((sum, check) => sum + check.total, 0),
      playable: streamChecks.reduce((sum, check) => sum + check.playable, 0),
      links: streamChecks.reduce((sum, check) => sum + check.links, 0),
    };
    streamOutcome = streamVerdict(streamChecks);
    // Catalogs announcing the addon needs configuration explain why borrowed titles got nothing either.
    if (
      streamOutcome.kind === "down" &&
      catalogNotice &&
      catalogNotice.placeholder !== "no-content"
    ) {
      streamOutcome = { kind: catalogNotice.placeholder, reason: catalogNotice.label };
    }
    const streamDetails = [...missingAdvertisedTargets, ...streamChecks].flatMap(
      (check) => check.details,
    );
    if (streamOutcome.kind === "links") {
      streamDetails.push({ label: "Note", value: "link addon: links only, not content-checked" });
    }
    // A catalog addon whose stream resource answers nothing for its own titles is judged on its catalogs.
    if (streamOutcome.kind === "down" && isAuxiliaryStream(streamChecks, catalogChecks)) {
      primary = "catalog";
      streamDetails.push({
        label: "Note",
        value: "no streams for the addon's own catalog titles; judged on its catalogs",
      });
    }
    perResource.push({
      resource: "stream",
      ok: streamOutcome.kind === "content" || streamOutcome.kind === "links",
      summary: streamSummary([...missingAdvertisedTargets, ...streamChecks]),
      details: streamDetails,
    });
  }

  // meta resource: skip bare tt on a catalog-less scraper (Cinemeta owns imdb meta).
  if (metaRes && test) {
    const borrowedImdb = !catalogTestable && test.id.startsWith("tt");
    if (borrowedImdb) {
      log.debug(
        { step: "meta", id: test.id },
        "skipped meta check (borrowed imdb id owned by Cinemeta)",
      );
    } else {
      const path = `/meta/${test.type}/${encodeId(test.id)}.json`;
      const testId = describeTestId(test.id, test.source);
      try {
        const answer = await getJson<MetaResponse>(base + path, config.timeouts.meta);
        metaAnswer = answer;
        const { status, data, parseError, attempts } = answer;
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
          details: requestRows(path, attempts, { testId, reason, parseError: unparsed }),
        });
        log.debug(
          { step: "meta", ok, status, type: test.type, id: test.id },
          `meta check ${ok ? "ok" : "fail"}`,
        );
      } catch (e) {
        perResource.push({
          resource: "meta",
          ok: false,
          summary: "unreachable",
          details: requestRows(path, attemptsOf(e), { testId, reason: errMsg(e) }),
        });
        log.debug({ step: "meta", ok: false, err: errMsg(e) }, "meta fetch threw");
      }
    }
  }

  // Secondary resources: shape-only, annotate, never flip DOWN.
  if (test && norm.some((r) => r.name === "subtitles")) {
    const id = test.episodeId ?? test.id;
    const path = `/subtitles/${test.type}/${encodeId(id)}.json`;
    try {
      const { data, parseError, attempts } = await getJson<{ subtitles?: unknown[] }>(
        base + path,
        config.timeouts.meta,
      );
      const ok = Array.isArray(data?.subtitles);
      perResource.push({
        resource: "subtitles",
        ok,
        summary: ok
          ? `${data!.subtitles!.length} found`
          : parseError
            ? describeParseError(parseError).summary
            : "invalid",
        details: requestRows(path, attempts, {
          testId: describeTestId(id, test.source),
          reason: ok || parseError ? undefined : "response has no subtitles array",
          parseError,
        }),
      });
      log.debug({ step: "subtitles", ok }, "subtitles check (annotation only)");
    } catch {
      /* secondary: ignore */
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
        ? catalogChecks.map((c) => c.answer)
        : [metaAnswer];
  const unconfigured = unconfiguredReason(live, primaryAnswers, manifestAttempts);
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
