import type {
  Manifest,
  ManifestCatalog,
  MetaDetail,
  MetaPreview,
  Stream,
} from "@stremio-addon/sdk";
import { config } from "./config.js";
import { attemptsOf, describeParseError, getJson, type Attempt, type ParseError } from "./http.js";
import { encodeId, errMsg } from "./utils.js";
import { hasSourceFor, resolveForPrefixes, type TestContent } from "./idsources.js";
import { logger } from "./logger.js";
import { missingManifestFields, normalizeResources } from "./manifest.js";
import type {
  DetailRow,
  NormalizedAddon,
  PerResourceResult,
  ProbeResult,
  ProbeMode,
} from "./types.js";

/**
 * Fields on a Stream that make it actually playable.
 *  Kept in sync with the SDK `Stream` interface via `satisfies (keyof Stream)[]`.
 * A stream is "valid" only if it carries at least one of these.
 */
const STREAM_SOURCE_FIELDS = [
  "url",
  "ytId",
  "infoHash",
  "nzbUrl",
  "rarUrls",
  "zipUrls",
  "7zipUrls",
  "tgzUrls",
  "tarUrls",
  "externalUrl",
] as const satisfies readonly (keyof Stream)[];

function isPlayableStream(s: unknown): s is Stream {
  if (!s || typeof s !== "object") return false;
  const obj = s as Record<string, unknown>;
  return STREAM_SOURCE_FIELDS.some((f) => {
    const v = obj[f];
    return Array.isArray(v) ? v.length > 0 : v != null && v !== "";
  });
}

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
    const { status, data, parseError, attempts } = await getJson<CatalogResponse>(
      baseUrl + path,
      config.timeouts.catalog,
    );
    if (!isOkStatus(status)) {
      return {
        ok: false,
        summary: `HTTP ${status}`,
        details: requestRows(path, attempts, { reason: `addon responded with HTTP ${status}` }),
      };
    }
    if (parseError) {
      return {
        ok: false,
        summary: describeParseError(parseError).summary,
        details: requestRows(path, attempts, { parseError }),
      };
    }
    const metas = data?.metas ?? [];
    const firstValid = metas.find((m) => missingMetaFields(m).length === 0);
    if (!firstValid) {
      const reason =
        metas.length === 0
          ? "returned no metas"
          : `none of ${metas.length} metas has an id, type and name`;
      return { ok: false, summary: "empty", details: requestRows(path, attempts, { reason }) };
    }
    return {
      ok: true,
      summary: `${metas.length} metas`,
      details: requestRows(path, attempts),
      content: {
        type: firstValid.type || picked.catalog.type,
        id: firstValid.id,
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

interface StreamCheckResult {
  target: StreamProbeTarget;
  ok: boolean;
  total: number;
  valid: number;
  summary: string;
  details: DetailRow[];
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

function streamSummary(checks: StreamCheckResult[]): string {
  return checks.map((c) => `${c.target.probeType} ${c.summary}`).join(" · ");
}

function streamVerdict(checks: StreamCheckResult[]): boolean {
  if (checks.length === 0) return false;
  if (checks.length === 1) return checks[0].ok;
  return checks.some((c) => c.ok && c.valid > 1);
}

function missingStreamCheck(probeType: TargetedStreamProbeType, reason: string): StreamCheckResult {
  return {
    target: { probeType, type: probeType, id: "" },
    ok: false,
    total: 0,
    valid: 0,
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
  try {
    const { status, data, parseError, attempts } = await getJson<unknown>(
      addon.baseUrl + manifestPath,
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
    manifestDetails = requestRows(manifestPath, attempts);
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

  // Step 2: Discovery / early liveness-only.
  if (live.behaviorHints?.configurationRequired === true)
    return livenessOnly("configurationRequired");

  const streamRes = norm.find((r) => r.name === "stream");
  const metaRes = norm.find((r) => r.name === "meta");
  const catalogTestable = catalogs.length > 0 && norm.some((r) => r.name === "catalog");
  const advertisedStreamTypes = streamRes ? advertisedStreamProbeTypes(streamRes.types) : [];

  // Primary content resource: stream > catalog > meta.
  const primary: "stream" | "catalog" | "meta" | null = streamRes
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

  if (catalogTestable) {
    if (streamRes) {
      const catalogChecks: CatalogProbeResult[] = [];
      if (advertisedStreamTypes.length > 0) {
        const results = await Promise.all(
          advertisedStreamTypes.map(async (probeType) => ({
            probeType,
            found: await fetchCatalogCandidate(addon.baseUrl, catalogs, probeType),
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
        const found = await fetchCatalogCandidate(addon.baseUrl, fallbackCatalogs);
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
      const found = await fetchCatalogCandidate(addon.baseUrl, catalogs);
      if (found) {
        perResource.push({
          resource: "catalog",
          ok: found.ok,
          summary: found.summary,
          details: found.details,
        });
        test = found.content ?? null;
        if (test) {
          log.debug(
            {
              step: "testid",
              source: "catalog",
              type: test.type,
              id: test.id,
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

  // For episodic content, a stream query needs an episode id.
  const ensureEpisodeId = async (target: TestContent & { probeType?: string }): Promise<void> => {
    if (target.episodeId || !EPISODIC_TYPES.has(target.type)) return;
    const resolvedEpisodeId = metaRes
      ? await firstEpisodeId(addon.baseUrl, target.type, target.id)
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
  let streamCounts: { total: number; valid: number } | undefined;

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

    const streamChecks = await Promise.all(
      resolvableTargets.map(async (target): Promise<StreamCheckResult> => {
        const type = target.type;
        const id = target.episodeId ?? target.id;
        const path = `/stream/${type}/${encodeId(id)}.json`;
        const testId = describeTestId(id, target.source);
        try {
          const { status, data, attempts } = await getJson<StreamResponse>(
            addon.baseUrl + path,
            config.timeouts.stream,
          );
          const streams = Array.isArray(data?.streams) ? data!.streams! : [];
          const valid = streams.filter(isPlayableStream).length;
          const ok = isOkStatus(status) && valid >= 1;
          const reason = !isOkStatus(status)
            ? `addon responded with HTTP ${status}`
            : streams.length === 0
              ? "returned no streams"
              : valid === 0
                ? `none of ${streams.length} streams has a playable source`
                : undefined;
          log.debug(
            {
              step: "stream",
              ok,
              status,
              valid,
              total: streams.length,
              probeType: target.probeType,
              type,
              id,
            },
            `stream check ${ok ? "ok" : "fail"}: ${target.probeType} ${valid}/${streams.length} playable`,
          );
          return {
            target,
            ok,
            total: streams.length,
            valid,
            summary: isOkStatus(status) ? `${valid} of ${streams.length} valid` : `HTTP ${status}`,
            details: requestRows(path, attempts, { testId, reason }),
          };
        } catch (e) {
          log.debug(
            { step: "stream", ok: false, err: errMsg(e), probeType: target.probeType, type, id },
            "stream fetch threw",
          );
          return {
            target,
            ok: false,
            total: 0,
            valid: 0,
            summary: "unreachable",
            details: requestRows(path, attemptsOf(e), { testId, reason: errMsg(e) }),
          };
        }
      }),
    );

    streamCounts = {
      total: streamChecks.reduce((sum, check) => sum + check.total, 0),
      valid: streamChecks.reduce((sum, check) => sum + check.valid, 0),
    };
    const streamOk = streamVerdict(streamChecks);
    const allStreamChecks = [...missingAdvertisedTargets, ...streamChecks];
    const streamDetails = allStreamChecks.flatMap((check) => check.details);
    if (!streamOk && streamChecks.some((check) => check.ok)) {
      streamDetails.push({
        label: "Reason",
        value: "no target returned more than 1 playable stream",
      });
    }
    perResource.push({
      resource: "stream",
      // Unsourced targets only annotate: an ID source outage must not turn into a DOWN.
      ok: streamOk,
      summary: streamSummary(allStreamChecks),
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
        const { status, data, parseError, attempts } = await getJson<MetaResponse>(
          addon.baseUrl + path,
          config.timeouts.meta,
        );
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
        addon.baseUrl + path,
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

  // Manifest up but primary content failed.
  // The log message carries the full per-resource breakdown, not just the primary, so a DOWN is explainable from the logs alone.
  const breakdown = perResource.map((r) => `${r.resource}: ${r.summary}`).join(" · ");
  const downMsg = breakdown
    ? `manifest up · ${breakdown}`
    : `manifest up · ${primary} check failed`;
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
