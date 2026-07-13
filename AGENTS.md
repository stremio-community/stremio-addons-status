This file provides guidance to agents when working with code in this repository.

## What this is

A status page for Stremio addons that checks whether an addon **actually works** (returns real streams/catalogs/meta), not just whether `/manifest.json` responds. Stock [Kuvasz](https://github.com/kuvasz-uptime/kuvasz) renders the dashboard; a custom TypeScript `worker/` does the deep probing and feeds verdicts in through Kuvasz's v2 REST API.

Data flow: `stremio-addons.net API → worker → Kuvasz (status page + Discord alerts) → Postgres → Grafana`.

pnpm workspace; the only package is `worker/`. See `package.json` scripts for commands. Local dev: run infra in Docker, worker on host (`docker compose up -d postgres kuvasz grafana warp` + `pnpm -F worker start:dev`). Production is `docker compose up -d`.

## Architecture

Two independent loops in [index.ts](worker/src/index.ts), started after an initial blocking list load:

- **listLoop** (`LIST_REFRESH`, 1h): fetch addon list, reconcile Kuvasz push monitors (create/rename/disable) plus the static HTTP monitors.
- **probeLoop** (`PROBE_INTERVAL`, 15m): probe every addon concurrently (`CONCURRENCY`) and push each verdict to Kuvasz.

Non-obvious decisions to preserve when editing:

### Probe verdict ([probe.ts](worker/src/probe.ts))

Two-tier: a **liveness floor** (manifest reachable) plus **content depth** (a real resource returns usable data).

- Primary resource priority: `stream` > `catalog` > `meta`. Verdict is driven by the primary; secondary resources (subtitles) only annotate, never flip a verdict.
- A stream counts as valid only if it carries a playable source field (`STREAM_SOURCE_FIELDS`, kept in sync with the SDK `Stream` type). "Responds but 0 valid streams" = DOWN — that's the whole point.
- `mode: "liveness-only"` (UP, not deep-checked) when there's no testable resource, config is required, or no test ID can be sourced.
- Test IDs come from the addon's own catalog when possible; else borrowed via [idsources.ts](worker/src/idsources.ts) from external metadata addons (Cinemeta for `tt`, Anime Kitsu for `kitsu`). `resetCycle()` clears the per-cycle cache each probe cycle so IDs rotate.

### Proxy ([http.ts](worker/src/http.ts))

Requests go through a Cloudflare WARP SOCKS5 proxy first, falling back to direct when the proxied request looks blocked (`BLOCKED_STATUSES`/5xx) or its transport throws. An addon is reported unreachable only when **both** routes fail — avoids false DOWNs from addons that block WARP egress or datacenter IPs.

### Kuvasz integration ([kuvasz.ts](worker/src/kuvasz.ts))

The worker owns one Kuvasz **push monitor** per addon, managed through the authenticated v2 REST API (`KUVASZ_API_KEY`), and pushes verdicts as heartbeats (UP) or explicit failures (DOWN, carrying the probe's error message). Push monitors record no latency; durations only reach the worker's logs.

- **Identity = client secret, not name.** Each monitor's `clientSecret` is `HMAC-SHA256(PUSH_SECRET_SEED, slug)`, so reconciliation matches monitors by secret and display names can change freely — Kuvasz keys history to the immutable monitor id, so renames keep history. Never match monitors by name, and never change `PUSH_SECRET_SEED` casually: re-keying orphans every monitor's history.
- **Display names must still be deterministic**: the hub (stremio-addons-hub `src/server/services/uptime.ts`) cannot derive ids or secrets, so it resolves an addon's monitor by trying the name candidates `[name, "name (slug)"]`. `buildMonitors` suffixes ` (slug)` on **every** sharer of a colliding name (never a positional counter) with a uuid backstop — keep the two implementations in sync.
- **The worker owns ALL push monitors.** Any push monitor whose secret it doesn't recognize is treated as a delisted addon and patched to `enabled: false` — **never DELETE**, so history survives a relisting. Disabled monitors drop off the status page but keep their rows. Don't hand-create push monitors; hand-created **HTTP** monitors are left alone.
- **Static checks** (Stremio Platform, debrid APIs, stremio-addons.net) are native Kuvasz HTTP monitors upserted by name from [staticmonitors.ts](worker/src/staticmonitors.ts), using `expectedStatusCodes`/`expectedKeyword` for the non-2xx cases. Kuvasz probes them directly (no per-monitor proxy); if one flaps from datacenter-IP blocking, move that check into the worker's push path instead.
- **Heartbeat watchdog**: `heartbeatInterval` = the probe interval, `gracePeriod` = one extra interval, so Kuvasz itself flags addons DOWN if the worker stops pushing.
- **Discord**: the integration is defined once in [kuvasz/kuvasz.yml](kuvasz/kuvasz.yml) as `discord:alerts`; the worker assigns it to the monitors it manages only when `DISCORD_WEBHOOK_URL` is set. With no webhook, compose substitutes a placeholder URL so the integration definition stays valid but unused.
- **Never define monitors in kuvasz.yml**: YAML-managed monitors put Kuvasz's UI and API into read-only mode, which would break the worker.
- **Connection pool**: kuvasz.yml raises `datasources.default.maximumPoolSize` to 50 because Kuvasz's stock 10-connection pool self-deadlocks under bursts of concurrent push requests (each handler holds a connection while acquiring another). Keep worker-side request fan-out modest (`RECONCILE_CONCURRENCY`, probe `CONCURRENCY`).

### Status page & API surface

- The **default status page** at `/status` is public (`PUBLISH_DEFAULT_STATUS_PAGE=true`) and automatically shows every enabled monitor, server-rendered and cached for 5 minutes. The admin UI and REST API stay behind auth. There is no monitor grouping and the page-top aggregate ("some systems are experiencing a problem") is expected to sit red — many third-party addons are simply down at any given time; that's accepted.
- The hub reads per-monitor status via the authenticated API: resolve id from `GET /api/v2/push-monitors`, then `GET /api/v2/push-monitors/{id}/stats?period=1d|7d|30d`. Kuvasz is pinned to an exact image tag (compose.yaml); upgrades must be deliberate and tested against both the worker and the hub.

## Conventions

- Commit messages follow conventional commits, but never use scopes (`feat: ...`, not `feat(worker): ...`).
- ESM TypeScript (`"type": "module"`); intra-package imports use `.js` extensions even though sources are `.ts`.
- Structured logging via pino ([logger.ts](worker/src/logger.ts)); no `console.log`.
- Keep this file current: when a change alters one of the non-obvious decisions above (probe verdict, proxy fallback, Kuvasz identity/ownership/pool, status page exposure), update AGENTS.md in the same change.
- stremio-addons.net API docs: https://docs.stremio-addons.net/developers/api
