/** Encode an id for a path segment but keep the `:` that IDs like `kitsu:1:1:1` rely on. */
export function encodeId(id: string): string {
  return encodeURIComponent(id).replace(/%3A/gi, ":");
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Extract a readable message from an unknown thrown value. */
export function errMsg(e: unknown): string {
  return e && typeof e === "object" && "message" in e ? String((e as Error).message) : String(e);
}

/** The first whole multiple of `intervalMs` since the Unix epoch strictly after `t`, so a 5-minute interval lands on :00, :05, :10, … */
export function nextSlotAfter(t: number, intervalMs: number): number {
  return (Math.floor(t / intervalMs) + 1) * intervalMs;
}

/** Resolve after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
