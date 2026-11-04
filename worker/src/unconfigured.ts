import type { Manifest } from "@stremio-addon/sdk";
import { config } from "./config.js";
import { getJson, type Attempt, type ParseError } from "./http.js";
import { invitesConfiguration } from "./manifest.js";

/** What a content request answered, as much as telling a route that isn't mounted from one that fails needs. */
export interface ContentAnswer {
  status: number;
  data: unknown;
  parseError?: ParseError;
  attempts: Attempt[];
}

/** FastAPI's default body for a path no route matches. */
function isFastApiNotFound(data: unknown): boolean {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const keys = Object.keys(data);
  return keys.length === 1 && (data as { detail?: unknown }).detail === "Not Found";
}

/**
 * The status a request failed with when it failed like a route that only exists under a config path, or undefined when it failed some other way.
 * A 404 that isn't JSON (Express `Cannot GET`, a Flask or nginx page, plain text) or is FastAPI's `{"detail":"Not Found"}` means no route matched.
 * A 401 or 403 counts only when every route tried answered it and one of them loaded the manifest, which rules out an IP block.
 */
export function missingRouteStatus(
  answer: ContentAnswer | undefined,
  manifestAttempts: readonly Attempt[],
): number | undefined {
  if (!answer || answer.attempts.some((a) => a.status !== answer.status)) return undefined;
  const { status } = answer;
  if (status === 404) {
    return answer.parseError || isFastApiNotFound(answer.data) ? status : undefined;
  }
  if (status === 401 || status === 403) {
    const manifestRoutes = new Set(
      manifestAttempts
        .filter((a) => a.status !== undefined && a.status >= 200 && a.status < 300)
        .map((a) => a.route),
    );
    return answer.attempts.some((a) => manifestRoutes.has(a.route)) ? status : undefined;
  }
  return undefined;
}

/**
 * Whether the addon's own `/configure` page, the one Stremio's configure button opens, loads on the addon's host.
 * Without it a user can't configure the addon either, so a dead backend or a URL that is someone's personal install doesn't pass as merely unconfigured.
 */
export async function servesConfigurePage(baseUrl: string): Promise<boolean> {
  try {
    const { status, attempts } = await getJson(`${baseUrl}/configure`, config.timeouts.manifest);
    return status >= 200 && status < 300 && !attempts.at(-1)?.redirect;
  } catch {
    return false;
  }
}

/**
 * Why an addon whose primary content failed most likely only needs configuring, or undefined when its failure suggests no such thing.
 * The listing often carries the bare URL of an addon whose content routes exist only under the config path its configure page generates.
 * It takes a configurable manifest, every primary request failing like a missing route, and a configure page that loads: a configurable addon answering empty can be genuinely broken.
 */
export async function unconfiguredReason(
  manifest: Manifest,
  answers: ReadonlyArray<ContentAnswer | undefined>,
  manifestAttempts: readonly Attempt[],
  baseUrl: string,
): Promise<string | undefined> {
  if (answers.length === 0 || !invitesConfiguration(manifest)) return undefined;
  const statuses = answers.map((a) => missingRouteStatus(a, manifestAttempts));
  if (statuses.some((s) => s === undefined)) return undefined;
  if (!(await servesConfigurePage(baseUrl))) return undefined;
  const shown = [...new Set(statuses)].map((s) => `HTTP ${s}`).join(", ");
  return `unconfigured content routes answer ${shown}`;
}
