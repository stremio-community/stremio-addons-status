import type { Manifest } from "@stremio-addon/sdk";

/** A manifest resource with its scope resolved: short-form resources inherit the manifest's `types` and `idPrefixes`. */
export interface NormResource {
  name: string;
  types: string[];
  idPrefixes: string[];
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
