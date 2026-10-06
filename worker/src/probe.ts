import type {
  Manifest,
  ManifestCatalog,
  MetaDetail,
  MetaPreview,
  Stream,
} from "@stremio-addon/sdk";
import { config } from "./config.js";
import { getJson } from "./http.js";
import { encodeId, errMsg } from "./utils.js";
import { hasSourceFor, resolveForPrefixes, type TestContent } from "./idsources.js";
import { logger } from "./logger.js";
import type { NormalizedAddon, PerResourceResult, ProbeResult, ProbeMode } from "./types.js";

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

interface NormResource {
  name: string;
  types: string[];
  idPrefixes: string[];
}

function normalizeResources(m: Manifest): NormResource[] {
  return (m.resources ?? []).map((r) => {
    if (typeof r === "string") {
      return { name: r, types: m.types ?? [], idPrefixes: m.idPrefixes ?? [] };
    }
    return {
      name: r.name,
      types: r.types ?? m.types ?? [],
      idPrefixes: r.idPrefixes ?? m.idPrefixes ?? [],
    };
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

function metaIsValid(m: unknown): m is MetaDetail {
  const o = m as Record<string, unknown> | undefined;
  return (
    !!o && typeof o.id === "string" && typeof o.type === "string" && typeof o.name === "string"
  );
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
    if (status < 200 || status >= 300) return undefined;
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
  detail: string;
}

async function fetchCatalogCandidate(
  baseUrl: string,
  catalogs: ManifestCatalog[],
  preferredType?: string,
): Promise<CatalogProbeResult | null> {
  const picked = pickCatalog(catalogs, preferredType);
  if (!picked) return null;

  const url = `${baseUrl}/catalog/${picked.catalog.type}/${encodeId(picked.catalog.id)}${picked.extraPath}.json`;
  const { status, data } = await getJson<CatalogResponse>(url, config.timeouts.catalog);
  const metas = data?.metas ?? [];
  const firstValid = metas.find(
    (m) =>
      m && typeof m.id === "string" && typeof m.type === "string" && typeof m.name === "string",
  );
  if (status >= 200 && status < 300 && firstValid) {
    return {
      ok: true,
      detail: `${metas.length} metas`,
      content: { type: firstValid.type || picked.catalog.type, id: firstValid.id },
    };
  }
  return { ok: false, detail: `empty (HTTP ${status})` };
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
  detail: string;
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

function streamDetail(checks: StreamCheckResult[]): string {
  return checks.map((c) => `${c.target.probeType} ${c.detail}`).join(" · ");
}

function streamVerdict(checks: StreamCheckResult[]): boolean {
  if (checks.length === 0) return false;
  if (checks.length === 1) return checks[0].ok;
  return checks.some((c) => c.ok && c.valid > 1);
}

function missingStreamCheck(probeType: TargetedStreamProbeType, detail: string): StreamCheckResult {
  return {
    target: { probeType, type: probeType, id: "" },
    ok: false,
    total: 0,
    valid: 0,
    detail,
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
  let live: Manifest;
  try {
    const { status, data } = await getJson<Manifest>(
      `${addon.baseUrl}/manifest.json`,
      config.timeouts.manifest,
    );
    if (status < 200 || status >= 300 || !data || typeof data !== "object" || Array.isArray(data)) {
      log.debug({ step: "manifest", status }, "manifest unreachable → DOWN");
      return result(
        false,
        `manifest unreachable (HTTP ${status})`,
        start,
        {
          live: false,
          mode: "content",
          perResource,
        },
        "manifest",
      );
    }
    live = data;
  } catch (e) {
    log.debug({ step: "manifest", err: errMsg(e) }, "manifest fetch threw → DOWN");
    return result(
      false,
      `manifest unreachable (${errMsg(e)})`,
      start,
      {
        live: false,
        mode: "content",
        perResource,
      },
      "manifest",
    );
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
      mode: "liveness-only",
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
      const catalogChecks: Array<{ ok: boolean; detail: string }> = [];
      if (advertisedStreamTypes.length > 0) {
        for (const probeType of advertisedStreamTypes) {
          try {
            const found = await fetchCatalogCandidate(addon.baseUrl, catalogs, probeType);
            if (!found) continue;
            catalogChecks.push({ ok: found.ok, detail: `${probeType} ${found.detail}` });
            if (found.ok && found.content) {
              streamTargets.push({ ...found.content, probeType });
            }
          } catch (e) {
            catalogChecks.push({ ok: false, detail: `${probeType} ${errMsg(e)}` });
            log.debug({ step: "catalog", type: probeType, err: errMsg(e) }, "catalog fetch threw");
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
        try {
          const found = await fetchCatalogCandidate(addon.baseUrl, fallbackCatalogs);
          if (found) {
            catalogChecks.push({ ok: found.ok, detail: found.detail });
            if (found.ok && found.content) {
              streamTargets.push({ ...found.content, probeType: found.content.type });
            }
          }
        } catch (e) {
          catalogChecks.push({ ok: false, detail: errMsg(e) });
          log.debug({ step: "catalog", err: errMsg(e) }, "catalog fetch threw");
        }
      }
      if (catalogChecks.length > 0) {
        perResource.push({
          resource: "catalog",
          ok: catalogChecks.every((check) => check.ok),
          detail: catalogChecks.map((check) => check.detail).join(" · "),
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
      try {
        const found = await fetchCatalogCandidate(addon.baseUrl, catalogs);
        if (found) {
          perResource.push({ resource: "catalog", ok: found.ok, detail: found.detail });
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
            log.debug({ step: "catalog", detail: found.detail }, "catalog empty/unreachable");
          }
        }
      } catch (e) {
        perResource.push({ resource: "catalog", ok: false, detail: errMsg(e) });
        log.debug({ step: "catalog", err: errMsg(e) }, "catalog fetch threw");
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
  for (const target of streamTargets) {
    if (!target.episodeId && EPISODIC_TYPES.has(target.type)) {
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
    }
  }
  if (test && !test.episodeId && EPISODIC_TYPES.has(test.type)) {
    test.episodeId =
      (metaRes ? await firstEpisodeId(addon.baseUrl, test.type, test.id) : undefined) ??
      fallbackEpisodeId(test.type, test.id);
  }

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
    if (resolvableTargets.length === 0 && missingAdvertisedTargets.length === 0) {
      // No own catalog and no ID source for its prefixes.
      return livenessOnly("no test ID source for stream prefixes");
    }

    const streamChecks: StreamCheckResult[] = [...missingAdvertisedTargets];
    for (const target of resolvableTargets) {
      const type = target.type;
      const id = target.episodeId ?? target.id;
      try {
        const { status, data } = await getJson<StreamResponse>(
          `${addon.baseUrl}/stream/${type}/${encodeId(id)}.json`,
          config.timeouts.stream,
        );
        const streams = Array.isArray(data?.streams) ? data!.streams! : [];
        const valid = streams.filter(isPlayableStream).length;
        const ok = status >= 200 && status < 300 && valid >= 1;
        streamChecks.push({
          target,
          ok,
          total: streams.length,
          valid,
          detail: `${valid} valid / ${streams.length} total`,
        });
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
      } catch (e) {
        streamChecks.push({
          target,
          ok: false,
          total: 0,
          valid: 0,
          detail: errMsg(e),
        });
        log.debug(
          { step: "stream", ok: false, err: errMsg(e), probeType: target.probeType, type, id },
          "stream fetch threw",
        );
      }
    }

    streamCounts = {
      total: streamChecks.reduce((sum, check) => sum + check.total, 0),
      valid: streamChecks.reduce((sum, check) => sum + check.valid, 0),
    };
    perResource.push({
      resource: "stream",
      ok: streamVerdict(streamChecks),
      detail: streamDetail(streamChecks),
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
      try {
        const { status, data } = await getJson<MetaResponse>(
          `${addon.baseUrl}/meta/${test.type}/${encodeId(test.id)}.json`,
          config.timeouts.meta,
        );
        const ok = status >= 200 && status < 300 && metaIsValid(data?.meta);
        perResource.push({
          resource: "meta",
          ok,
          detail: ok ? "valid" : `invalid (HTTP ${status})`,
        });
        log.debug(
          { step: "meta", ok, status, type: test.type, id: test.id },
          `meta check ${ok ? "ok" : "fail"}`,
        );
      } catch (e) {
        perResource.push({ resource: "meta", ok: false, detail: errMsg(e) });
        log.debug({ step: "meta", ok: false, err: errMsg(e) }, "meta fetch threw");
      }
    }
  }

  // Secondary resources: shape-only, annotate, never flip DOWN.
  if (test && norm.some((r) => r.name === "subtitles")) {
    try {
      const { data } = await getJson<{ subtitles?: unknown[] }>(
        `${addon.baseUrl}/subtitles/${test.type}/${encodeId(test.episodeId ?? test.id)}.json`,
        config.timeouts.meta,
      );
      const ok = Array.isArray(data?.subtitles);
      perResource.push({
        resource: "subtitles",
        ok,
        detail: ok ? `${data!.subtitles!.length} subs` : "no array",
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
      ? okResources.map((r) => `${r.resource}: ${r.detail}`).join(" · ")
      : "manifest reachable";

  if (primaryResult?.ok) {
    log.debug(
      { step: "verdict", mode: "content", primary, streamCounts },
      `content UP: primary resource ${primary} passed`,
    );
    return result(true, message, start, {
      live: true,
      mode: "content",
      perResource,
      streamCounts,
    });
  }

  // Manifest up but primary content failed.
  // Push the full per-resource breakdown (not just the primary) so Gatus's failure tooltip shows exactly what was probed and what each resource returned.
  const breakdown = perResource.map((r) => `${r.resource}: ${r.detail}`).join(" · ");
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
      mode: "content",
      perResource,
      streamCounts,
    },
    primary,
  );
}
