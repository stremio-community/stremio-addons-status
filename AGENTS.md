This file provides guidance to agents when working with code in this repository.

## What this is

A status page for Stremio addons that checks whether an addon **actually works** (returns real streams/catalogs/meta), not just whether `/manifest.json` responds. Stock [Uptime Kuma](https://github.com/louislam/uptime-kuma) renders the dashboard; a custom TypeScript `worker/` does the deep probing, provisions the monitors, and pushes verdicts in.

Data flow: `stremio-addons.net API → worker → Uptime Kuma (status page) → MariaDB`.

pnpm workspace; the only package is `worker/`. See `package.json` scripts for commands. Local dev: run infra in Docker, worker on host (`docker compose up -d mariadb kuma warp` + `pnpm -F worker start:dev`). Production is `docker compose up -d`.

## Architecture

Two independent loops in [index.ts](worker/src/index.ts), started after a blocking Kuma connect and an initial blocking list load:

- **listLoop** (`LIST_REFRESH`, 1h): fetch addon list and reconcile Kuma's monitors/status page against it.
- **probeLoop** (`PROBE_INTERVAL`, 15m): probe every addon concurrently (`CONCURRENCY`) and push each verdict to its Kuma push monitor.

Non-obvious decisions to preserve when editing:

### Probe verdict ([probe.ts](worker/src/probe.ts))

Two-tier: a **liveness floor** (manifest reachable) plus **content depth** (a real resource returns usable data).

- Primary resource priority: `stream` > `catalog` > `meta`. Verdict is driven by the primary; secondary resources (subtitles) only annotate, never flip a verdict.
- A stream counts as valid only if it carries a playable source field (`STREAM_SOURCE_FIELDS`, kept in sync with the SDK `Stream` type). "Responds but 0 valid streams" = DOWN — that's the whole point.
- `mode: "liveness-only"` (UP, not deep-checked) when there's no testable resource, config is required, or no test ID can be sourced.
- Test IDs come from the addon's own catalog when possible; else borrowed via [idsources.ts](worker/src/idsources.ts) from external metadata addons (Cinemeta for `tt`, Anime Kitsu for `kitsu`). `resetCycle()` clears the per-cycle cache each probe cycle so IDs rotate.

### Proxy ([http.ts](worker/src/http.ts))

Requests go through a Cloudflare WARP SOCKS5 proxy first, falling back to direct when the proxied request looks blocked (`BLOCKED_STATUSES`/5xx) or its transport throws. An addon is reported unreachable only when **both** routes fail — avoids false DOWNs from addons that block WARP egress or datacenter IPs.

### Uptime Kuma integration ([kuma.ts](worker/src/kuma.ts) + [kuma-client.ts](worker/src/kuma-client.ts))

Kuma has no REST write API; all provisioning goes through its internal socket.io API ([kuma-client.ts](worker/src/kuma-client.ts) is a thin promise wrapper over it, pinned to the compose image version). Verdicts are pushed over plain HTTP to each monitor's `/api/push/{token}` endpoint with `status`, `msg`, and `ping` (the probe's duration, so per-addon response times survive).

- **Identity is the `slug` tag**, not the display name: every addon monitor carries a Kuma tag `slug` whose value is the addon's stable slug. Reconciliation matches monitors by tag value, so upstream renames just edit the name and keep the monitor id (and its history). The hub resolves addons the same way via the public status-page API, which includes tags because the page sets `showTags: true` — tag name/semantics and the page slug (`status`) are a public contract with the hub.
- **Reconcile, don't rebuild** (`reconcile` in [kuma.ts](worker/src/kuma.ts)): create missing monitors, edit on drift, resume relisted, and **pause** (never delete) delisted addons so history survives a relisting. A cycle with no upstream changes must make zero API writes. When editing, always round-trip the full monitor JSON from `monitorList` with only the owned fields changed — Kuma's `editMonitor` overwrites every field it knows, including `pushToken`.
- **Push watchdog**: a push monitor's `interval` is how long Kuma tolerates push silence before flipping it DOWN, so it's set to 4× `PROBE_INTERVAL` — a dead worker self-reports, while cycles that stretch don't cause mass false DOWNs. `maxretries: 0` because a pushed DOWN is already final (the probe retried via WARP + direct); with retries it would linger in PENDING.
- **Names are cosmetic**: shared name+group still gets a slug suffix for humans (order-independent, every sharer), but collisions no longer threaten identity or history.
- **Groups and ordering**: five fixed groups top-to-bottom — `Addons`, `Addon Instances` (push monitors), then `Stremio Platform`, `Debrid Services`, `Infrastructure` (native Kuma HTTP/keyword monitors defined in `STATIC_MONITORS`, most probing through the WARP proxy Kuma-side). Order is simply the array order of `publicGroupList` in `saveStatusPage`.
- **Zero-touch bootstrap**: on an empty Kuma the worker creates the admin account itself (socket `setup` event) from `KUMA_USERNAME`/`KUMA_PASSWORD`, then provisions everything; no setup wizard. The compose file presets the database via `UPTIME_KUMA_DB_*` env so the DB wizard is skipped too.
- No alerting is provisioned for now (`notificationIDList` stays empty); notifications can be added later in the admin UI or via the API.

## Conventions

- Commit messages follow conventional commits, but never use scopes (`feat: ...`, not `feat(worker): ...`).
- ESM TypeScript (`"type": "module"`); intra-package imports use `.js` extensions even though sources are `.ts`.
- Structured logging via pino ([logger.ts](worker/src/logger.ts)); no `console.log`.
- Keep this file current: when a change alters one of the non-obvious decisions above (probe verdict, proxy fallback, Kuma identity/reconcile/watchdog, hub contract), update AGENTS.md in the same change.
- stremio-addons.net API docs: https://docs.stremio-addons.net/developers/api
