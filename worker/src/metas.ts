import { plural } from "./utils.js";

/** The fields Stremio needs to load a meta or meta preview; it shows one without `name` as an untitled tile. */
const META_REQUIRED_FIELDS = ["id", "type"] as const;
const META_DOCUMENTED_FIELDS = [...META_REQUIRED_FIELDS, "name"] as const;

function lackedFields(m: unknown, fields: readonly string[]): string[] {
  const o = m as Record<string, unknown> | undefined;
  return fields.filter((f) => typeof o?.[f] !== "string");
}

/** The fields Stremio needs on a meta or meta preview that this one lacks or holds as a non-string. */
export function missingMetaFields(m: unknown): string[] {
  return lackedFields(m, META_REQUIRED_FIELDS);
}

/** A catalog's metas, how many lack a field the SDK docs require, and which fields they lack between them. */
export interface MetaCounts {
  total: number;
  incomplete: number;
  missing: string[];
}

export function metaDefects(metas: readonly unknown[]): MetaCounts {
  const missing = metas
    .map((m) => lackedFields(m, META_DOCUMENTED_FIELDS))
    .filter((fields) => fields.length > 0);
  return {
    total: metas.length,
    incomplete: missing.length,
    missing: META_DOCUMENTED_FIELDS.filter((f) => missing.some((fields) => fields.includes(f))),
  };
}

/** `39 of 51 metas without name`, or `100 metas without name` when none has it. */
export function metasWithout(
  incomplete: number,
  total: number,
  missing: readonly string[],
): string {
  const count =
    incomplete === total ? plural(total, "meta") : `${incomplete} of ${plural(total, "meta")}`;
  return `${count} without ${missing.join(", ")}`;
}

/** What is wrong with a meta answer that parsed: `summary` is terse, `reason` names the defect. */
export interface MetaDefect {
  summary: string;
  reason: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Why a parsed 2xx meta answer can't be shown at all, or undefined when it can. */
export function metaBodyDefect(data: unknown): MetaDefect | undefined {
  const meta = isObject(data) ? data.meta : undefined;
  if (!isObject(meta)) {
    const unwrapped =
      isObject(data) &&
      lackedFields(data, META_DOCUMENTED_FIELDS).length < META_DOCUMENTED_FIELDS.length;
    return unwrapped
      ? {
          summary: "invalid (meta not wrapped)",
          reason: 'meta returned without the {"meta": …} wrapper',
        }
      : { summary: "invalid", reason: "response has no meta object" };
  }
  const missing = missingMetaFields(meta);
  return missing.length > 0
    ? { summary: "invalid", reason: `meta missing ${missing.join(", ")}` }
    : undefined;
}

/**
 * Whether the meta names itself with a garbled form of the requested ID (`tmdb:1273221.json`, `155` for `tmdb:155`), which Stremio then keeps and requests streams with.
 * An ID from another space (`kitsu:13911` for `anilist:100248`) is a deliberate mapping that hands the title to other addons, so it doesn't count.
 */
function garbledId(metaId: string, id: string): boolean {
  return metaId !== id && (metaId.includes(id) || id.includes(metaId));
}

/**
 * Problems a meta Stremio can show still has: one without a name, one that garbles the requested ID, or a series with no episodes to pick.
 * `id` is the ID the meta was requested with.
 */
export function metaFlaws(meta: Record<string, unknown>, type: string, id: string): MetaDefect[] {
  const flaws: MetaDefect[] = [];
  if (typeof meta.name !== "string") {
    flaws.push({ summary: "without name", reason: "meta has no name" });
  }
  if (typeof meta.id === "string" && garbledId(meta.id, id)) {
    flaws.push({ summary: "id mismatch", reason: `meta id ${meta.id} for request ${id}` });
  }
  if (type === "series" && !(Array.isArray(meta.videos) && meta.videos.length > 0)) {
    flaws.push({ summary: "no videos", reason: "series meta has no videos" });
  }
  return flaws;
}
