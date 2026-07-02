This file provides guidance to agents when working with code in this repository.

## What this is

A status page for Stremio addons that checks whether an addon **actually works** (returns real streams/catalogs/meta), not just whether `/manifest.json` responds. Stock [Gatus](https://github.com/TwiN/gatus) renders the dashboard; a custom TypeScript `worker` does the deep probing and feeds verdicts in.

Data flow: `stremio-addons.net API → worker → Gatus (status page + Discord alerts) → Postgres → Grafana`.

## Commands

pnpm workspace; the only package is `worker/`. Run from repo root:

- `pnpm install` — install (once, from root)
- `pnpm test` — worker unit tests (vitest). Single file: `pnpm -F worker test src/probe.test.ts`. Single test: append `-t "name"`.
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm build` — `tsc` → `worker/dist`
- `pnpm format` / `pnpm format:check` — prettier over the repo
- `pnpm start:dev` — run the worker on the host with hot reload (`tsx watch`); loads `.env` then `worker/.env.dev` on top

Production is Docker Compose (`docker compose up -d`). For local dev, run infra in Docker but the worker on the host:

```sh
docker compose up -d postgres gatus grafana warp   # infra only
pnpm -F worker start:dev                            # worker on host
```

## Architecture

### The worker (`worker/src`)

Two independent loops in [index.ts](worker/src/index.ts), started after an initial blocking list load:

- **listLoop** (`LIST_REFRESH`, default 1h): fetch the addon list, rebuild endpoint descriptors, rewrite the endpoints YAML.
- **probeLoop** (`PROBE_INTERVAL`, default 15m): probe every addon concurrently (`CONCURRENCY`, via `mapLimit`) and push each verdict to Gatus.

Module responsibilities:

- [api.ts](worker/src/api.ts) — paginate the stremio-addons.net API, `normalizeAddon` into `NormalizedAddon`. `baseUrl` = manifestUrl minus `/manifest.json`.
- [probe.ts](worker/src/probe.ts) — the core deep-probe (see below).
- [idsources.ts](worker/src/idsources.ts) — for catalog-less stream addons, borrow real test IDs from external metadata addons (Cinemeta for `tt`, Anime Kitsu for `kitsu`). Per-cycle cache; `resetCycle()` clears it each probe cycle so IDs rotate.
- [gatus.ts](worker/src/gatus.ts) — `buildEndpoints` (grouping + unique keys), `writeConfig` (render `10-endpoints.yaml`), `pushResult` (POST verdict to Gatus's external-endpoint API).
- [http.ts](worker/src/http.ts) — `getJson`: WARP-proxy-first fetch with a direct-connection fallback (see proxy note below).
- [config.ts](worker/src/config.ts) — all env parsing; single exported `config` object. `parseDuration` accepts `30s`/`15m`/`1h`/bare-ms.

### Probe verdict logic ([probe.ts](worker/src/probe.ts))

Two-tier: a **liveness floor** (manifest reachable) plus **content depth** (a real resource returns usable data). Key decisions:

- Primary resource priority: `stream` > `catalog` > `meta`. The verdict is driven by the primary resource; secondary resources (subtitles) only annotate, never flip a verdict.
- A stream is only counted valid if it carries a playable source field (`STREAM_SOURCE_FIELDS`, kept in sync with the SDK `Stream` type). "Responds but 0 valid streams" = DOWN — that's the whole point of the project.
- `mode: "liveness-only"` (UP but not deep-checked) when there's no testable resource, config is required, or no test ID can be sourced.
- Test IDs come from the addon's own catalog when possible; otherwise borrowed via `idsources`. Episodic types resolve a first-episode id before the stream query.

### Proxy strategy ([http.ts](worker/src/http.ts))

Requests go through a Cloudflare WARP SOCKS5 proxy first, falling back to a direct connection when the proxied request looks blocked (`BLOCKED_STATUSES` or 5xx) or its transport throws. An addon is only reported unreachable when **both** routes fail — this avoids false DOWNs from addons that block either WARP egress IPs or datacenter IPs.

### Gatus integration ([gatus.ts](worker/src/gatus.ts))

The worker doesn't run checks inside Gatus; it registers each addon as an **external-endpoint** and POSTs verdicts. Two subtleties to preserve when editing:

- **Endpoint keys** must mirror Gatus's own key rule (`sanitize`: trim, lowercase, replace ` /_,.#&+` with `-`). Keys are the identity of an endpoint's history in Postgres — changing how a key is derived orphans history. `buildEndpoints` also dedups keys since lowercasing can collapse two distinct slugs.
- **Group ordering**: Gatus has no group-order config and sorts groups alphabetically. Order is encoded as invisible **leading spaces** on the group name (more spaces sort first, HTML collapses them, and Gatus trims the group before deriving the key so history is untouched). `GROUP_ORDER` + `orderPrefix` implement this; groups mirror the stremio-addons.net homepage sections (`LABEL_TO_GROUP`). If you add static base groups in `00-base.yaml`, keep their leading-space counts in sync with this scheme.

### Config files (`gatus/config.d/`)

Gatus merges every `*.yaml` in this dir. Split:

- `00-base.yaml` — hand-written: UI, storage, alerting, and static infra/platform/debrid endpoints.
- `10-endpoints.yaml` — **generated by the worker; do not edit**. Written atomically (temp file + rename) so Gatus hot-reloads a complete file. In compose it lives on a host bind mount shared between the worker and Gatus containers.

Discord alerts: if `DISCORD_WEBHOOK_URL` is empty the worker omits the alert block from generated endpoints entirely (no dead entries).

## External API reference

Stremio addons API (the `stremio-addons.net` API the worker consumes) is documented at https://docs.stremio-addons.net/developers/api.

## Conventions

- ESM TypeScript (`"type": "module"`); intra-package imports use `.js` extensions (e.g. `./config.js`) even though sources are `.ts`.
- Structured logging via pino ([logger.ts](worker/src/logger.ts)); probe steps trace on a per-addon child logger so the path to each verdict is reconstructable. Don't reintroduce `console.log`.
