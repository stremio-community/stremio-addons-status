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

/** A framework's JSON body for a path no route matches: FastAPI's `{"detail":"Not Found"}`, or a lone message such as `{"message":"Not Found - /stream/…"}`. */
function isJsonNotFound(data: unknown): boolean {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const fields = Object.values(data);
  return fields.length === 1 && typeof fields[0] === "string" && /^not found\b/i.test(fields[0]);
}

/**
 * The status a request failed with when it failed like a route that only exists under a config path, or undefined when it failed some other way.
 * A 404 that isn't JSON (Express `Cannot GET`, a Flask or nginx page, plain text) or is a framework's JSON "Not Found" means no route matched.
 * A 401 or 403 counts only when every route tried answered it and one of them loaded the manifest, which rules out an IP block.
 */
export function missingRouteStatus(
  answer: ContentAnswer | undefined,
  manifestAttempts: readonly Attempt[],
): number | undefined {
  if (!answer || answer.attempts.some((a) => a.status !== answer.status)) return undefined;
  const { status } = answer;
  if (status === 404) {
    return answer.parseError || isJsonNotFound(answer.data) ? status : undefined;
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

/** A listed URL with a path is already an install, configured or mounted, so its missing routes aren't explained by a missing config. */
function hasPath(baseUrl: string): boolean {
  return (URL.parse(baseUrl)?.pathname ?? "/").split("/").some(Boolean);
}

/**
 * Why an addon whose primary content failed most likely only needs configuring, or undefined when its failure suggests no such thing.
 * The listing often carries the bare URL of an addon whose content routes exist only under the config path its configure page generates.
 * It takes every primary request failing like a missing route and a configure page that loads: a configurable addon answering empty can be genuinely broken.
 * Many such addons never declare `configurable`, so a manifest that doesn't counts only unmounted routes, not refusals.
 */
export async function unconfiguredReason(
  manifest: Manifest,
  answers: ReadonlyArray<ContentAnswer | undefined>,
  manifestAttempts: readonly Attempt[],
  baseUrl: string,
): Promise<string | undefined> {
  if (answers.length === 0 || hasPath(baseUrl)) return undefined;
  const statuses = answers.map((a) => missingRouteStatus(a, manifestAttempts));
  if (statuses.some((s) => s === undefined)) return undefined;
  if (!invitesConfiguration(manifest) && statuses.some((s) => s !== 404)) return undefined;
  if (!(await servesConfigurePage(baseUrl))) return undefined;
  const shown = [...new Set(statuses)].map((s) => `HTTP ${s}`).join(", ");
  return `unconfigured content routes answer ${shown}`;
}
