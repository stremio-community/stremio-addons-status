This file provides guidance to agents when working with code in this repository.

## What this is

A status page for Stremio addons that checks whether an addon **actually works** (returns real streams/catalogs/meta), not just whether `/manifest.json` responds. Stock [Gatus](https://github.com/TwiN/gatus) renders the dashboard; a custom TypeScript `worker/` does the deep probing and feeds verdicts in.

Data flow: `stremio-addons.net API → worker → Gatus (status page + Discord alerts) → Postgres → Grafana`.

pnpm workspace; the only package is `worker/`. See `package.json` scripts for commands. Local dev: run infra in Docker, worker on host (`docker compose up -d postgres gatus grafana warp` + `pnpm -F worker start:dev`). Production is `docker compose up -d`.

## Architecture

Two independent loops in [index.ts](worker/src/index.ts), started after an initial blocking list load:

- **listLoop** (`LIST_REFRESH`, 1h): fetch addon list, rebuild endpoint descriptors, rewrite endpoints YAML.
- **probeLoop** (`PROBE_INTERVAL`, 15m): probe every addon concurrently (`CONCURRENCY`) and push each verdict to Gatus.

Non-obvious decisions to preserve when editing:

### Probe verdict ([probe.ts](worker/src/probe.ts))

Two-tier: a **liveness floor** (manifest reachable) plus **content depth** (a real resource returns usable data).

- Primary resource priority: `stream` > `catalog` > `meta`. Verdict is driven by the primary; secondary resources (subtitles) only annotate, never flip a verdict.
- A stream counts as valid only if it carries a playable source field (`STREAM_SOURCE_FIELDS`, kept in sync with the SDK `Stream` type). "Responds but 0 valid streams" = DOWN — that's the whole point.
- `mode: "liveness-only"` (UP, not deep-checked) when there's no testable resource, config is required, or no test ID can be sourced.
- Test IDs come from the addon's own catalog when possible; else borrowed via [idsources.ts](worker/src/idsources.ts) from external metadata addons (Cinemeta for `tt`, Anime Kitsu for `kitsu`). `resetCycle()` clears the per-cycle cache each probe cycle so IDs rotate.

### Proxy ([http.ts](worker/src/http.ts))

Requests go through a Cloudflare WARP SOCKS5 proxy first, falling back to direct when the proxied request looks blocked (`BLOCKED_STATUSES`/5xx) or its transport throws. An addon is reported unreachable only when **both** routes fail — avoids false DOWNs from addons that block WARP egress or datacenter IPs.

### Gatus integration ([gatus.ts](worker/src/gatus.ts))

The worker registers each addon as an **external-endpoint** and POSTs verdicts; it doesn't run checks inside Gatus.

- **Endpoint keys** are the addon's stable `uuid`, pushed via Gatus's explicit `key` field so identity is decoupled from the display name. This needs our **fork** of Gatus (`Stremio-Community/gatus`, TwiN/gatus#1146 isn't in upstream); stock Gatus derives the key from group+name and has no `key` field. Gatus sanitizes the explicit key (trim, lowercase, replace ` /_,.#&+` with `-`), so `buildEndpoints` sanitizes the uuid the same way to keep the pushed key, the generated YAML, and Gatus's stored Postgres key identical. Because the uuid is globally unique and contains only `[0-9a-f-]` (untouched by sanitize), keys never collide — no disambiguation, and renames/regroups never orphan history. The uuid also matches the identifier the hub consumer queries by (`stremio-addons-hub`, `uptime.ts`), so keep the two in sync. Keys are an endpoint's identity in Postgres, so changing the key source (e.g. uuid → slug) is still a one-time history cutover.
- **Display name** is the addon's real `name` (falling back to slug then uuid, see `baseName`), used purely as a label. It needn't be unique — Gatus dedups on the key, not the name — and is freely changeable without touching history.
- **Per-probe breakdown**: `pushResult` sends the verdict's per-resource breakdown as Gatus **condition results** (`buildConditions`), a JSON body on the push. Gatus renders them as a ✓/✗ list under "Conditions" when hovering a result, and the hub reads them for its uptime card. This is our second fork-only patch; stock Gatus's push API reads no body. Condition text is a user-facing contract rendered verbatim by both UIs — keep it terse and in `resource: detail` shape. Only the primary resource can flip the verdict, so every other resource is tagged `(informational)`; without it a healthy addon carrying a failed secondary check reads as a contradiction. The full breakdown also stays in the `error` query param, because that's what Discord alerts quote.
- **Groups**: five fixed groups top-to-bottom — `Addons`, `Addon Instances` (both worker-pushed), then `Stremio Platform`, `Debrid Services`, `Infrastructure` (static, in `00-base.yaml`). Every non-instance addon is `Addons`; instances collapse into `Addon Instances` (see `groupFor`). Gatus sorts groups alphabetically with no order config, so order is encoded as invisible **leading spaces** on the group name (more spaces sort first; HTML collapses them). The key is the uuid, independent of the group, so the leading-space prefix is purely cosmetic and never affects identity or history. See `GROUP_ORDER` + `orderPrefix`; the static base groups hardcode their matching space counts in `00-base.yaml` (2/1/0), so keep the two in sync.

### Config files (`gatus/config.d/`)

Gatus merges every `*.yaml`. `00-base.yaml` is hand-written (UI, storage, alerting, static infra/platform/debrid endpoints). `10-endpoints.yaml` is **generated by the worker; do not edit** — written atomically so Gatus hot-reloads a complete file. If `DISCORD_WEBHOOK_URL` is empty the worker omits the alert block entirely.

## Conventions

- Commit messages follow conventional commits, but never use scopes (`feat: ...`, not `feat(worker): ...`).
- ESM TypeScript (`"type": "module"`); intra-package imports use `.js` extensions even though sources are `.ts`.
- Structured logging via pino ([logger.ts](worker/src/logger.ts)); no `console.log`.
- Keep this file current: when a change alters one of the non-obvious decisions above (probe verdict, proxy fallback, Gatus keys/ordering, config layout), update AGENTS.md in the same change.
- stremio-addons.net API docs: https://docs.stremio-addons.net/developers/api
