/** Encode an id for a path segment but keep the `:` that IDs like `kitsu:1:1:1` rely on. */
export function encodeId(id: string): string {
  return encodeURIComponent(id).replace(/%3A/gi, ":");
}

/** Extract a readable message from an unknown thrown value. */
export function errMsg(e: unknown): string {
  return e && typeof e === "object" && "message" in e ? String((e as Error).message) : String(e);
}

/** Resolve after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
