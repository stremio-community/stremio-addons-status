This file provides guidance to agents when working with code in this repository.

## What this is

A status page for Stremio addons that checks whether an addon **actually works** (returns real streams/catalogs/meta), not just whether `/manifest.json` responds. [Kener](https://github.com/rajnandan1/kener) renders the dashboard; a custom TypeScript `worker/` does the deep probing and feeds verdicts in via Kener's v4 REST API.

Data flow: `stremio-addons.net API → worker → Kener (status page + alerts) → Postgres → Grafana`.

pnpm workspace; the only package is `worker/`. See `package.json` scripts for commands. Local dev: `pnpm start:dev` from the repo root — its pre-script brings up the infra in Docker (including the `kener-seed` one-shot) and then runs the worker on the host with hot reload. Production is `docker compose up -d`. The `kener-seed` compose one-shot handles all Kener setup on startup (admin user, API key, static monitors — see the Seeding section); only branding/triggers are configured manually in the manage UI.

## Architecture

Two independent loops in [index.ts](worker/src/index.ts), started after an initial blocking list load:

- **listLoop** (`LIST_REFRESH`, 1h): fetch addon list, reconcile Kener monitors (create/patch/hide) and home-page order.
- **probeLoop** (`PROBE_INTERVAL`, 15m): probe every addon concurrently (`CONCURRENCY`) and push each verdict to Kener.

Non-obvious decisions to preserve when editing:

### Probe verdict ([probe.ts](worker/src/probe.ts))

Two-tier: a **liveness floor** (manifest reachable) plus **content depth** (a real resource returns usable data).

- Primary resource priority: `stream` > `catalog` > `meta`. Verdict is driven by the primary; secondary resources (subtitles) only annotate, never flip a verdict.
- A stream counts as valid only if it carries a playable source field (`STREAM_SOURCE_FIELDS`, kept in sync with the SDK `Stream` type). "Responds but 0 valid streams" = DOWN — that's the whole point.
- `mode: "liveness-only"` (UP, not deep-checked) when there's no testable resource, config is required, or no test ID can be sourced.
- Test IDs come from the addon's own catalog when possible; else borrowed via [idsources.ts](worker/src/idsources.ts) from external metadata addons (Cinemeta for `tt`, Anime Kitsu for `kitsu`). `resetCycle()` clears the per-cycle cache each probe cycle so IDs rotate.
- The structured per-resource breakdown only reaches the logs; Kener data points carry just `status` + `latency`.

### Proxy ([http.ts](worker/src/http.ts))

Requests go through a Cloudflare WARP SOCKS5 proxy first, falling back to direct when the proxied request looks blocked (`BLOCKED_STATUSES`/5xx) or its transport throws. An addon is reported unreachable only when **both** routes fail — avoids false DOWNs from addons that block WARP egress or datacenter IPs.

### Kener integration ([kener.ts](worker/src/kener.ts))

The worker owns one Kener monitor per addon and pushes verdicts as data points (`PATCH /api/v4/monitors/{tag}/data/{ts}` with `{status, latency}`).

- **Identity = tag = slug.** `tagOf` normalizes the addon's stable slug into a Kener tag; the display `name` is free to change and never affects identity or history. Never derive identity from display names: names aren't unique or stable, and a rename would orphan the monitor's history. The hub (stremio-addons-hub `src/server/services/uptime.ts`) derives the same tag from the slug to look status up — keep the two `tagOf` implementations in sync. Slug collisions after normalization get a uuid suffix on **every** collider so tags never depend on list order.
- **The worker only owns NONE and GROUP monitors** in its categories (`isWorkerManaged`). If an addon's tag is already taken by a foreign monitor (e.g. a static check whose tag collides with an addon slug), the addon moves to a uuid-suffixed tag instead of hijacking it — which also means the hub can't derive that addon's tag, so its uptime widget hides. Keep static monitor tags out of the addon-slug namespace (see the `stremio-addons-net-health` note in seed-kener.sql).
- **Never DELETE monitors.** Delisted addons are patched to `is_hidden: "YES"` + `status: "INACTIVE"` so history survives a relisting; INACTIVE also drops them from Kener's fleet status.
- **Addon monitors are `monitor_type: "NONE"` with no `cron` on purpose.** Kener only schedules monitors that have a cron, so nothing runs server-side for the ~530 addon monitors; uptime is computed from the sparse pushed rows (Kener excludes NO_DATA from its math). Don't add a cron: it would enqueue ~530 BullMQ jobs per minute and write carry-forward rows nonstop.
- **The page shows GROUP aggregates, not the ~530 member monitors.** `buildGroups` folds the members into worker-managed GROUP monitors by primary list category (chunked to ≤ `GROUP_SIZE` = 100 — the member drawer fetches all bars in one batch capped at 100 tags; hundreds of bars also break the browser). Members belong to **no page**: they stay queryable by tag (hub, drawer) but only the group bars and the static checks sit on `~home` (groups first, foreign/static tags after in their existing order; pages PATCHes **replace membership wholesale**). Group tags live under the `group-` prefix so they can't collide with addon slugs. Groups are the one thing Kener evaluates for us (5m cron, reads members' latest statuses); any DOWN member makes a group DEGRADED, so yellow group bars are the normal state. Kener PR #709 (page groups with inline expansion) is the intended successor to this layout once it ships.
- **Categories**: worker-managed monitors are `Addons` or `Addon Instances` (see `CATEGORY_ORDER`); don't hand-create NONE or GROUP monitors there. Static monitors (seed-kener.sql) use other categories.

### Seeding ([seed-kener.sh](scripts/seed-kener.sh) + [seed-kener.sql](scripts/seed-kener.sql))

The `kener-seed` compose one-shot runs on every startup: it creates the admin user through Kener's signup endpoint, registers `KENER_API_TOKEN` (Kener stores API keys as `hmac_sha256(KENER_SECRET_KEY, token)`, so the hash is computed in SQL), and upserts the static Stremio Platform / Debrid Services / Infrastructure monitors (native Kener API monitors on a 5m cron). The SQL writes Kener's internal tables directly — verify it against the schema when bumping the pinned Kener image. Static monitors probe directly (Kener has no per-monitor SOCKS proxy); if one flaps from datacenter-IP blocking, move that check into the worker's push path instead.

## Conventions

- Commit messages follow conventional commits, but never use scopes (`feat: ...`, not `feat(worker): ...`).
- ESM TypeScript (`"type": "module"`); intra-package imports use `.js` extensions even though sources are `.ts`.
- Structured logging via pino ([logger.ts](worker/src/logger.ts)); no `console.log`.
- Keep this file current: when a change alters one of the non-obvious decisions above (probe verdict, proxy fallback, Kener tags/ordering/no-cron, bootstrap layout), update AGENTS.md in the same change.
- stremio-addons.net API docs: https://docs.stremio-addons.net/developers/api
- Kener is pinned to an exact image tag (compose.yaml); the hub reads Kener's internal `dashboard-apis/monitor-bar` endpoint, so upgrades must be deliberate and tested against the hub.
