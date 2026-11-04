import { metasWithout } from "./metas.js";
import type { DetailRow, PerResourceResult } from "./types.js";
import { plural } from "./utils.js";

/** Catalogs checked per addon besides those its primary check already fetched: enough to reach every type a typical addon declares. */
export const MAX_COVERAGE_FETCHES = 4;

/** Broken catalogs named in the summary, counting the `N more` that stands for the rest, since the tooltip and Discord show it; the detail rows list them all. */
const MAX_NAMED_PROBLEMS = 4;

export interface CatalogRef {
  type: string;
  id: string;
}

/** One catalog request as the probe judged it. */
export interface CatalogOutcome {
  catalog: CatalogRef;
  path: string;
  kind: "items" | "notices" | "empty" | "failed";
  ok: boolean;
  summary: string;
  metas?: { total: number; invalid: number; missing: string[] };
}

function keyOf(c: CatalogRef): string {
  return `${c.type.toLowerCase()}/${c.id}`;
}

/**
 * The catalogs still to fetch so the addon's catalogs are covered: first one of each declared type not yet fetched, then further ones until the coverage holds `MAX_COVERAGE_FETCHES`.
 * At most `MAX_COVERAGE_FETCHES` are returned, whatever was fetched before.
 */
export function coveragePicks<T>(
  candidates: readonly T[],
  catalogOf: (candidate: T) => CatalogRef,
  fetched: readonly CatalogRef[],
): T[] {
  const covered = new Set(fetched.map(keyOf));
  const types = new Set(fetched.map((c) => c.type.toLowerCase()));
  const open = candidates.filter((c) => !covered.has(keyOf(catalogOf(c))));
  const picks: T[] = [];
  for (const c of open) {
    const type = catalogOf(c).type.toLowerCase();
    if (picks.length >= MAX_COVERAGE_FETCHES) break;
    if (types.has(type)) continue;
    types.add(type);
    picks.push(c);
  }
  for (const c of open) {
    if (
      picks.length >= MAX_COVERAGE_FETCHES ||
      covered.size + picks.length >= MAX_COVERAGE_FETCHES
    ) {
      break;
    }
    if (!picks.includes(c)) picks.push(c);
  }
  return picks;
}

const KIND_RANK = { failed: 0, empty: 1, notices: 2, items: 3 } as const;

/** Each catalog's best answer among the requests made for it, in the order the catalogs were first requested. */
function bestPerCatalog<T extends CatalogOutcome>(outcomes: readonly T[]): T[] {
  const best = new Map<string, T>();
  for (const o of outcomes) {
    const key = keyOf(o.catalog);
    const seen = best.get(key);
    if (!seen || KIND_RANK[o.kind] >= KIND_RANK[seen.kind]) best.set(key, o);
  }
  return [...best.values()];
}

/** What is wrong with a catalog a user browses, in a word or two, or undefined when nothing is. */
export function catalogProblem(o: CatalogOutcome): string | undefined {
  const invalid = o.metas?.invalid ?? 0;
  if (o.kind === "failed") return o.summary;
  if (o.kind === "empty") return invalid > 0 ? `without ${o.metas!.missing.join(", ")}` : "empty";
  if (o.kind === "notices" && !o.ok) return "only notices";
  return invalid > 0 ? `without ${o.metas!.missing.join(", ")}` : undefined;
}

function rowOf(o: CatalogOutcome): DetailRow {
  const m = o.metas;
  const defects =
    o.kind === "items" && m && m.invalid > 0
      ? ` · ${metasWithout(m.invalid, m.total, m.missing)}`
      : "";
  return { label: "Catalog", value: `${o.path} · ${o.summary}${defects}` };
}

/**
 * An informational `N of M OK` over every catalog checked, naming the ones a user would find broken: failing, empty, or listing metas Stremio can't title.
 * Nothing when fewer than two catalogs were checked, since the catalog condition already tells about the one.
 */
export function catalogCoverage(
  outcomes: readonly CatalogOutcome[],
): PerResourceResult | undefined {
  const catalogs = bestPerCatalog(outcomes);
  if (catalogs.length < 2) return undefined;
  const ids = catalogs.map((o) => o.catalog.id);
  const labelOf = (o: CatalogOutcome) =>
    ids.filter((id) => id === o.catalog.id).length > 1
      ? `${o.catalog.type}/${o.catalog.id}`
      : o.catalog.id;
  const problems = catalogs.flatMap((o) => {
    const problem = catalogProblem(o);
    return problem ? [`${labelOf(o)} ${problem}`] : [];
  });
  const ok = catalogs.length - problems.length;
  const named =
    problems.length > MAX_NAMED_PROBLEMS
      ? [
          ...problems.slice(0, MAX_NAMED_PROBLEMS - 1),
          `${problems.length - MAX_NAMED_PROBLEMS + 1} more`,
        ]
      : problems;
  return {
    resource: "catalogs",
    ok: problems.length === 0,
    summary: `${ok} of ${catalogs.length} OK${named.length > 0 ? ` · ${named.join(", ")}` : ""}`,
    details: catalogs.map(rowOf),
  };
}

/** How an addon catalog answer fares: `reason` is set whenever it isn't `ok`. */
export interface AddonCatalogJudgement {
  ok: boolean;
  summary: string;
  reason?: string;
}

function isInstallable(entry: unknown): boolean {
  const e = entry as { transportUrl?: unknown; manifest?: unknown } | null;
  return (
    typeof e?.transportUrl === "string" &&
    e.transportUrl !== "" &&
    e.manifest !== null &&
    typeof e.manifest === "object" &&
    !Array.isArray(e.manifest)
  );
}

/** Whether an addon catalog answer lists an addon Stremio could install: one with a transport URL and its manifest. */
export function hasInstallableAddon(data: unknown): boolean {
  const addons = (data as { addons?: unknown } | null)?.addons;
  return Array.isArray(addons) && addons.some(isInstallable);
}

/** Judge a parsed 2xx `/addon_catalog/…` answer: it passes when it lists at least one installable addon. */
export function judgeAddonCatalog(data: unknown): AddonCatalogJudgement {
  const addons = (data as { addons?: unknown } | null)?.addons;
  if (!Array.isArray(addons)) {
    return { ok: false, summary: "invalid", reason: "response has no addons array" };
  }
  if (addons.length === 0) return { ok: false, summary: "empty", reason: "returned no addons" };
  const installable = addons.filter(isInstallable).length;
  if (installable === 0) {
    return {
      ok: false,
      summary: `invalid (${plural(addons.length, "addon")} without transportUrl or manifest)`,
      reason: `none of ${addons.length} addons has a transportUrl and a manifest`,
    };
  }
  return {
    ok: true,
    summary:
      installable === addons.length
        ? plural(addons.length, "addon")
        : `${installable} of ${plural(addons.length, "addon")} installable`,
  };
}
