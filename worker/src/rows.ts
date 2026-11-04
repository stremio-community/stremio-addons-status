import { describeParseError, type Attempt, type JsonResult, type ParseError } from "./http.js";
import type { DetailRow } from "./types.js";

export function describeTestId(id: string, source: string | undefined): string {
  return source ? `${id} (${source})` : id;
}

export function attemptRows(a: Attempt): DetailRow[] {
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
export function requestRows(
  path: string,
  attempts: Attempt[],
  {
    testId,
    reason,
    parseError,
    note,
  }: { testId?: string; reason?: string; parseError?: ParseError; note?: string } = {},
): DetailRow[] {
  const parsed = parseError ? describeParseError(parseError) : undefined;
  const why = reason ?? parsed?.reason;
  return [
    { label: "Request", value: path },
    ...(testId ? [{ label: "Test ID", value: testId }] : []),
    ...attempts.flatMap(attemptRows),
    ...(why ? [{ label: "Reason", value: why }] : []),
    ...(note ? [{ label: "Note", value: note }] : []),
    ...(parsed?.details ?? []),
  ];
}

/** How long the route whose answer the request kept took to give it, leaving out the tries it replaced. */
export function answerTime({
  status,
  attempts,
}: Pick<JsonResult<unknown>, "status" | "attempts">): number {
  return attempts.findLast((a) => a.status === status)?.durationMs ?? 0;
}

/** A request summarized in one row, for the requests a check made besides the one its full rows describe. */
export function alsoTriedRow(request: string, summary: string): DetailRow {
  return { label: "Also tried", value: `${request} · ${summary}` };
}
