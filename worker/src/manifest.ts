import type { Manifest } from "@stremio-addon/sdk";

/** A manifest resource with its scope resolved: short-form resources inherit the manifest's `types` and `idPrefixes`. */
export interface NormResource {
  name: string;
  types: string[];
  idPrefixes: string[];
}

/**
 * The fields stremio-core needs to deserialize a manifest at all, so a body lacking any of them isn't an addon Stremio could install.
 * `description` and `catalogs` are required by the SDK docs but not by Stremio, so requiring them would turn working addons DOWN.
 */
const REQUIRED_MANIFEST_FIELDS = [
  ["id", "string"],
  ["version", "string"],
  ["name", "string"],
  ["resources", "array"],
  ["types", "array"],
] as const;

/** The required manifest fields the object lacks or holds with the wrong type, in manifest order. */
export function missingManifestFields(m: object): string[] {
  const o = m as Record<string, unknown>;
  return REQUIRED_MANIFEST_FIELDS.filter(([field, kind]) =>
    kind === "array" ? !Array.isArray(o[field]) : typeof o[field] !== kind,
  ).map(([field]) => field);
}

export function normalizeResources(m: Manifest): NormResource[] {
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

/** Declared prefixes that restrict anything: a missing list, or one holding only blanks, accepts every ID. */
export function effectivePrefixes(res: NormResource): string[] {
  return res.idPrefixes.filter((p) => p !== "");
}

/** The manifest's matching rule: Stremio sends `type`/`id` to this resource only when the type is declared and the ID starts with a declared prefix. */
export function resourceAccepts(res: NormResource, type: string, id: string): boolean {
  if (!res.types.includes(type)) return false;
  const prefixes = effectivePrefixes(res);
  return prefixes.length === 0 || prefixes.some((p) => id.startsWith(p));
}

/**
 * Settings the manifest marks `required` without a `default`, so no install works until the user fills them in.
 * SDK manifests declare `config` as an array of `{ key, required, default }`; older ones as an object keyed by setting.
 */
export function requiredConfigKeys(m: Manifest): string[] {
  const config: unknown = (m as { config?: unknown }).config;
  const entries: Array<[unknown, unknown]> = Array.isArray(config)
    ? config.map((c) => [(c as { key?: unknown } | null)?.key, c])
    : config && typeof config === "object"
      ? Object.entries(config)
      : [];
  return entries.flatMap(([key, c]) => {
    const o = c as Record<string, unknown> | null;
    const required = o?.required === true && (o.default === undefined || o.default === null);
    return required && typeof key === "string" && key !== "" ? [key] : [];
  });
}

/**
 * Why the manifest itself says it serves nothing until configured, or undefined when it doesn't.
 * Stremio reads only `behaviorHints.configurationRequired`, but a root-level flag or a required setting states the same intent.
 */
export function declaredConfigRequirement(m: Manifest): string | undefined {
  const root = m as { configurationRequired?: unknown };
  if (m.behaviorHints?.configurationRequired === true || root.configurationRequired === true) {
    return "manifest sets configurationRequired";
  }
  const keys = requiredConfigKeys(m);
  return keys.length > 0 ? `manifest requires setting ${keys.join(", ")}` : undefined;
}

/** Whether the addon offers configuration at all, which makes an unconfigured listing a likely template. */
export function invitesConfiguration(m: Manifest): boolean {
  const root = m as { configurable?: unknown };
  return (
    m.behaviorHints?.configurable === true ||
    root.configurable === true ||
    declaredConfigRequirement(m) !== undefined
  );
}
